import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ServerWebSocket } from "bun";
import {
  ALLOWED_IMAGE_EXTS,
  getAttachmentsDir,
  isSafeSegment,
  MAX_ATTACHMENT_BYTES,
  sanitizeMessageAttachments,
  saveAttachmentBytes,
  saveAttachmentFromLocalPath,
} from "./attachments";
import { BrowserBridge } from "./browser-bridge";
import {
  extractOrigin,
  TabAgentStore,
  type AttachmentRecord,
  type AttentionKind,
  type ElementChip,
  type RepoSource,
  type SessionFull,
} from "./db";
import {
  getDefaultHarnessId,
  getHarnessSpec,
  HARNESS_CATALOGUE,
  HarnessRunner,
  normalizeEffort,
} from "./harnesses";
import { listPeers, readPeer, sendToPeer } from "./peers";
import { PigeonBridge } from "./pigeon-bridge";
import { ShellRunner } from "./shell-runner";
import {
  expandTildePath,
  resolveUrlToRepo,
  searchRepoCatalogue,
  toTildePath,
} from "./url-repo";

export interface RadarItem {
  kind: "tab" | "pigeon";
  id: string;
  name: string;
  tabId: number | null;
  url: string;
  state: "working" | "needs-you" | "error" | "stale" | "done";
  detail: string;
  updatedAt: number;
}

export interface RadarSummary {
  tabWorking: number;
  tabAttention: number;
  tabError: number;
  pigeonOnline: boolean;
  pigeonWorking: number;
  pigeonNeedsYou: number;
  armedTriggers: number;
  items: RadarItem[];
}

export interface TabAgentServerHandle {
  server: ReturnType<typeof Bun.serve>;
  store: TabAgentStore;
  bridge: BrowserBridge;
  pigeon: PigeonBridge;
  shell: ShellRunner;
  runner: HarnessRunner;
  token: string;
  port: number;
  stop: () => void;
  sweepSeePage: () => Promise<string[]>;
  getRadar: () => RadarSummary;
}

interface WsClientData {
  role: "panel" | "extension";
}

function isAllowedRequest(req: Request): boolean {
  const host = req.headers.get("host") || "";
  if (
    host &&
    !host.startsWith("127.0.0.1:") &&
    !host.startsWith("localhost:") &&
    host !== "127.0.0.1" &&
    host !== "localhost"
  ) {
    return false;
  }
  const origin = req.headers.get("origin");
  if (
    origin &&
    !origin.startsWith("chrome-extension://") &&
    !origin.startsWith("http://127.0.0.1:") &&
    !origin.startsWith("http://localhost:")
  ) {
    return false;
  }
  return true;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const base: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (
    origin &&
    (origin.startsWith("chrome-extension://") ||
      origin.startsWith("http://127.0.0.1:") ||
      origin.startsWith("http://localhost:"))
  ) {
    base["Access-Control-Allow-Origin"] = origin;
    base["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
    base["Access-Control-Allow-Headers"] = "Content-Type, X-Tab-Agent-Token";
  }
  return base;
}

function jsonResp(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(req) });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createTabAgentServer(opts: {
  port?: number;
  dbPath?: string;
  token?: string;
  scratchDir?: string;
  attachmentsDir?: string;
  stallMs?: number;
  /** See Page switches itself off after this long with no prompt or page tool call (env TAB_AGENT_SEE_PAGE_IDLE_MIN). */
  seePageIdleMs?: number;
  /** Override Pigeon-Hole base URL (default http://127.0.0.1:7742 or PIGEON_HOLE_URL). */
  pigeonHoleUrl?: string;
  /** Connect to Pigeon-Hole WebSocket for live radar + /after triggers. */
  watchPigeonWs?: boolean;
  /** Minimum turn duration (ms) before a non-error finish raises a ready badge (default 10000). */
  attentionMinMs?: number;
} = {}): TabAgentServerHandle {
  const port = opts.port !== undefined ? opts.port : Number(process.env.TAB_AGENT_PORT ?? 7752);
  const token = opts.token || process.env.TAB_AGENT_TOKEN || randomBytes(16).toString("hex");
  const attachmentsDir = getAttachmentsDir(opts.attachmentsDir);
  const store = new TabAgentStore(opts.dbPath);
  store.recoverStaleWorkingSessions();

  const bridge = new BrowserBridge(store);
  const startedAt = Date.now();
  const seePageIdleMs =
    opts.seePageIdleMs ?? Math.max(1, Number(process.env.TAB_AGENT_SEE_PAGE_IDLE_MIN || 30)) * 60_000;
  // Last time each chat did something that needs its page (a prompt, See Page switched on, a page tool call).
  const lastTouched = new Map<string, number>();
  const touch = (sessionId: string) => lastTouched.set(sessionId, Date.now());
  const panelClients = new Set<ServerWebSocket<WsClientData>>();

  const broadcast = (payload: Record<string, unknown>): void => {
    const raw = JSON.stringify(payload);
    for (const ws of panelClients) {
      try {
        ws.send(raw);
      } catch {
        panelClients.delete(ws);
      }
    }
  };

  const serializeSession = (s: SessionFull | null) => {
    if (!s) return null;
    const cdp = bridge.getCdpStats(s.tabId);
    const runStatus = runner.getRunStatus(s.id);
    return {
      ...s,
      displayRepoPath: toTildePath(s.repoPath),
      isRunning: runner.isRunning(s.id),
      runStatus,
      cdp,
    };
  };

  const attentionMinMs = opts.attentionMinMs ?? 10_000;
  // Track which Chrome tab the user is currently viewing so background tabs ALWAYS notify on finish
  let activeTabId: number | null = null;
  // Track Pigeon-Hole cubbies the user has already opened/looked at (maps cubbyId -> cubby updatedAt when viewed)
  const viewedPigeonAt = new Map<string, number>();

  const looksLikeNeedsYou = (text: string): boolean => {
    const s = (text || "").trim();
    if (!s) return false;
    if (/\?\s*$/.test(s)) return true;
    return /\b(which one|would you like|do you want|want me to|should i|please confirm|approve|let me know|your call|pick one|say yes|reply with)\b/i.test(
      s
    );
  };

  const shell = new ShellRunner(store, broadcast);
  let runner: HarnessRunner;

  const buildRadar = (): RadarSummary => {
    const items: RadarItem[] = [];
    let tabWorking = 0;
    let tabAttention = 0;
    let tabError = 0;

    const seenSessions = new Set<string>();
    const bindings = store.listBindings();
    for (const b of bindings) {
      if (seenSessions.has(b.sessionId)) continue;
      seenSessions.add(b.sessionId);
      const s = store.getSession(b.sessionId);
      if (!s) continue;
      const rs = runner ? runner.getRunStatus(s.id) : null;
      if (rs) {
        tabWorking++;
        const silentMs = Date.now() - rs.lastActivityAt;
        const isStale = silentMs >= 180_000;
        if (isStale) tabError++;
        items.push({
          kind: "tab",
          id: s.id,
          name: s.name,
          tabId: b.tabId,
          url: s.lastUrl,
          state: isStale ? "stale" : "working",
          detail: isStale ? "No output >3m" : rs.currentStep || "Working…",
          updatedAt: rs.lastActivityAt,
        });
        continue;
      }
      if (s.attentionState) {
        if (s.attentionState === "error") tabError++;
        else tabAttention++;
        items.push({
          kind: "tab",
          id: s.id,
          name: s.name,
          tabId: b.tabId,
          url: s.lastUrl,
          state: s.attentionState,
          detail: s.attentionDetail || s.questionSnippet || (s.attentionState === "needs-you" ? "Needs your reply" : "Ready"),
          updatedAt: s.attentionAt || s.updatedAt,
        });
      }
    }

    const phSnap = pigeon.getLiveSnapshot();
    let pigeonWorking = 0;
    let pigeonNeedsYou = 0;
    for (const c of phSnap.cubbies) {
      if (c.state === "working") {
        pigeonWorking++;
        items.push({
          kind: "pigeon",
          id: c.id,
          name: c.name,
          tabId: null,
          url: `${pigeon.baseUrl}/#s=${encodeURIComponent(c.id)}`,
          state: "working",
          detail: "Pigeon-Hole working",
          updatedAt: c.updatedAt,
        });
      } else if (c.state === "needs-you") {
        const viewedAt = viewedPigeonAt.get(c.id) || 0;
        if (viewedAt >= c.updatedAt) continue;
        pigeonNeedsYou++;
        items.push({
          kind: "pigeon",
          id: c.id,
          name: c.name,
          tabId: null,
          url: `${pigeon.baseUrl}/#s=${encodeURIComponent(c.id)}`,
          state: "needs-you",
          detail: c.snippet || "Needs you in Pigeon-Hole",
          updatedAt: c.updatedAt,
        });
      }
    }

    const armedTriggers = store.listArmedTriggers().length;
    return {
      tabWorking,
      tabAttention,
      tabError,
      pigeonOnline: phSnap.online,
      pigeonWorking,
      pigeonNeedsYou,
      armedTriggers,
      items,
    };
  };

  const broadcastRadar = (): void => {
    const radar = buildRadar();
    broadcast({ type: "radar_updated", radar });
    bridge.broadcastToExtensions({ type: "radar_updated", radar });
  };

  const shouldWatchPigeon =
    opts.watchPigeonWs ??
    (process.env.TAB_AGENT_DISABLE_PIGEON !== "1" && (opts.port !== 0 || Boolean(opts.pigeonHoleUrl)));
  const pigeon = new PigeonBridge(store, broadcast, {
    baseUrl: opts.pigeonHoleUrl,
    watchWs: shouldWatchPigeon,
    getActiveAgentMessageId: (sid) => (runner ? runner.getActiveAgentMessageId(sid) : null),
    onLiveStateChange: () => broadcastRadar(),
    onTriggerFired: (trigger, wakePrompt, displayNote) => {
      if (!runner) return;
      runner
        .dispatch(trigger.sessionId, wakePrompt, [], [], {
          displayText: displayNote,
          fromTrigger: true,
        })
        .catch((err) => console.error("[tab-agent] /after wake dispatch error:", err));
    },
  });

  const server = Bun.serve<WsClientData>({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,
    async fetch(req, srv) {
      if (!isAllowedRequest(req)) {
        return new Response("Forbidden (local host only)", { status: 403 });
      }
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      }

      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const role = url.searchParams.get("role") === "extension" ? "extension" : "panel";
        if (srv.upgrade(req, { data: { role } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname === "/api/health" && req.method === "GET") {
        return jsonResp(req, {
          ok: true,
          pid: process.pid,
          port: srv.port,
          extensionConnected: bridge.isExtensionConnected(),
          activeRuns: runner.getActiveSessionIds(),
        });
      }

      if (url.pathname === "/api/bootstrap" && req.method === "GET") {
        return jsonResp(req, {
          ok: true,
          port: srv.port,
          extensionConnected: bridge.isExtensionConnected(),
          harnesses: HARNESS_CATALOGUE,
          bindings: store.listBindings(),
          rules: store.listRules(),
          recentHistory: store.searchHistory("", 30),
          radar: buildRadar(),
        });
      }

      if (url.pathname === "/api/radar" && req.method === "GET") {
        return jsonResp(req, { ok: true, radar: buildRadar() });
      }

      /* ---- Serve Stored Image Attachments ---- */
      if (url.pathname.startsWith("/api/attachments/") && req.method === "GET") {
        const rest = url.pathname.slice("/api/attachments/".length);
        const segs = rest.split("/");
        if (segs.length !== 2) return jsonResp(req, { error: "Invalid attachment path" }, 400);
        let reqSid: string;
        let reqFile: string;
        try {
          reqSid = decodeURIComponent(segs[0]);
          reqFile = decodeURIComponent(segs[1]);
        } catch {
          return jsonResp(req, { error: "Invalid encoding" }, 400);
        }
        if (!isSafeSegment(reqSid) || !isSafeSegment(reqFile)) {
          return jsonResp(req, { error: "Invalid attachment path" }, 400);
        }
        const target = resolve(attachmentsDir, reqSid, reqFile);
        const rel = relative(attachmentsDir, target);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
          return jsonResp(req, { error: "Invalid attachment path" }, 400);
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          return jsonResp(req, { error: "Attachment not found" }, 404);
        }
        const mime = ALLOWED_IMAGE_EXTS[extname(reqFile).toLowerCase()] || "application/octet-stream";
        const headers = corsHeaders(req);
        headers["Content-Type"] = mime;
        headers["X-Content-Type-Options"] = "nosniff";
        headers["Cache-Control"] = "private, max-age=3600";
        return new Response(Bun.file(target), { status: 200, headers });
      }

      /* ---- Passive Tab URL Sync ---- */
      if (url.pathname === "/api/tabs/sync" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body.tabId !== "number") {
          return jsonResp(req, { error: "numeric tabId is required" }, 400);
        }
        const tabId = body.tabId;
        const tabUrl = typeof body.url === "string" ? body.url : "";
        const pageTitle = typeof body.title === "string" ? body.title : "";
        const windowId = typeof body.windowId === "number" ? body.windowId : null;
        const origin = extractOrigin(tabUrl);

        const repoMatch = resolveUrlToRepo(tabUrl, {
          pageTitle,
          store,
          scratchDir: opts.scratchDir,
        });
        const pigeonCtx = await pigeon.getContextForTab(tabUrl, { timeoutMs: 1_200 }).catch(() => null);
        if (body.active === true) {
          activeTabId = tabId;
        }
        if (body.active === true && pigeonCtx?.isPigeonHole && pigeonCtx.activeSessionId) {
          viewedPigeonAt.set(pigeonCtx.activeSessionId, Date.now());
          broadcastRadar();
        }

        const binding = store.getTabBinding(tabId);
        let session = binding ? store.getSessionFull(binding.sessionId) : null;
        let domainChanged: { fromOrigin: string; toOrigin: string; suggestedRepo: typeof repoMatch } | null = null;

        if (session) {
          if (body.active === true && store.setSessionAttention(session.id, "")) {
            broadcastRadar();
          }
          const prevOrigin = session.origin;
          if (tabUrl && tabUrl !== session.lastUrl) {
            store.updateSessionUrl(session.id, tabUrl, pageTitle || session.pageTitle);
            store.bindTab(tabId, session.id, windowId, tabUrl);
            if (prevOrigin && origin && prevOrigin !== origin) {
              domainChanged = { fromOrigin: prevOrigin, toOrigin: origin, suggestedRepo: repoMatch };
            }
            session = store.getSessionFull(session.id);
          }
          // If session was previously bound to scratch and we now have a strong rule/localhost match, suggest it
          const serialized = serializeSession(session);
          broadcast({
            type: "tab_synced",
            tabId,
            url: tabUrl,
            title: pageTitle,
            session: serialized,
            repoMatch,
            domainChanged,
            pigeon: pigeonCtx,
          });
          return jsonResp(req, {
            tabId,
            url: tabUrl,
            title: pageTitle,
            session: serialized,
            repoMatch,
            domainChanged,
            pigeon: pigeonCtx,
            recoverable: null,
          });
        }

        // Unbound tab: check for most recent archived/previous chat on same domain
        const recoverable = origin ? store.findRecentForOrigin(origin) : null;
        return jsonResp(req, {
          tabId,
          url: tabUrl,
          title: pageTitle,
          session: null,
          repoMatch,
          domainChanged: null,
          pigeon: pigeonCtx,
          recoverable,
        });
      }

      /* ---- Tab Closed (Archive binding without deleting session) ---- */
      const tabClosedMatch = url.pathname.match(/^\/api\/tabs\/(\d+)\/closed$/);
      if (tabClosedMatch && req.method === "POST") {
        const tabId = Number(tabClosedMatch[1]);
        if (activeTabId === tabId) activeTabId = null;
        const prevSessionId = store.unbindTab(tabId);
        if (prevSessionId) {
          broadcast({ type: "tab_closed", tabId, sessionId: prevSessionId });
          broadcastRadar();
        }
        return jsonResp(req, { ok: true, tabId, archivedSessionId: prevSessionId });
      }

      /* ---- Create Session (optionally bound to a tab) ---- */
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return jsonResp(req, { error: "Invalid JSON" }, 400);

        const tabId = typeof body.tabId === "number" ? body.tabId : null;
        const windowId = typeof body.windowId === "number" ? body.windowId : null;
        const tabUrl = typeof body.url === "string" ? body.url : "";
        const pageTitle = typeof body.title === "string" ? body.title : "";

        const spec = getHarnessSpec(
          typeof body.harnessId === "string" && body.harnessId.trim() ? body.harnessId : getDefaultHarnessId()
        );
        const effort = normalizeEffort(spec, typeof body.effort === "string" ? body.effort : undefined);

        let repoPath: string;
        let repoName: string;
        let repoSource: RepoSource;

        if (typeof body.repoPath === "string" && body.repoPath.trim()) {
          const expanded = expandTildePath(body.repoPath.trim());
          repoPath = expanded;
          repoName = typeof body.repoName === "string" && body.repoName.trim() ? body.repoName.trim() : basename(expanded);
          repoSource = (body.repoSource as RepoSource) || "manual";
        } else {
          const matched = resolveUrlToRepo(tabUrl, { pageTitle, store, scratchDir: opts.scratchDir });
          repoPath = matched.repoPath;
          repoName = matched.repoName;
          repoSource = matched.source;
        }

        const name =
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 120)
            : pageTitle
              ? pageTitle.slice(0, 64)
              : "New Chat";

        const id = `tab-${randomUUID().slice(0, 10)}`;
        store.createSession({
          id,
          name,
          repoPath,
          repoName,
          repoSource,
          url: tabUrl,
          pageTitle,
          family: spec.family,
          model: spec.model,
          effort,
          harnessId: spec.id,
          pageAccess: false,
        });

        if (tabId !== null) {
          store.bindTab(tabId, id, windowId, tabUrl);
        }

        store.insertEvent({
          sessionId: id,
          kind: "init",
          summary: `Created sticky chat in ${repoName} (${spec.family} · ${spec.model})`,
        });

        const full = serializeSession(store.getSessionFull(id));
        broadcast({ type: "session_created", session: full });
        return jsonResp(req, { session: full }, 201);
      }

      /* ---- Session Routes ---- */
      const sessMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
      if (sessMatch) {
        const sessionId = decodeURIComponent(sessMatch[1]);
        const action = sessMatch[2] || "";

        if (!action && req.method === "GET") {
          const full = serializeSession(store.getSessionFull(sessionId));
          if (!full) return jsonResp(req, { error: "Session not found" }, 404);
          return jsonResp(req, { session: full });
        }

        if (!action && req.method === "DELETE") {
          runner.abort(sessionId, true);
          store.deleteSession(sessionId);
          broadcast({ type: "session_deleted", sessionId });
          return jsonResp(req, { ok: true });
        }

        const existing = store.getSession(sessionId);
        if (!existing) return jsonResp(req, { error: "Session not found" }, 404);

        if (!action && req.method === "PATCH") {
          const body = await readJson(req);
          if (!body) return jsonResp(req, { error: "Invalid JSON" }, 400);

          if (typeof body.name === "string" && body.name.trim()) {
            store.updateSessionName(sessionId, body.name.trim().slice(0, 120));
          }
          if (typeof body.repoPath === "string" && body.repoPath.trim()) {
            const expanded = expandTildePath(body.repoPath.trim());
            if (!existsSync(expanded)) {
              return jsonResp(req, { error: `Directory not found: ${body.repoPath}` }, 400);
            }
            const rName =
              typeof body.repoName === "string" && body.repoName.trim()
                ? body.repoName.trim()
                : basename(expanded);
            const rSource = (body.repoSource as RepoSource) || "manual";
            store.updateSessionRepo(sessionId, expanded, rName, rSource);
            const ev = store.insertEvent({
              sessionId,
              kind: "config",
              summary: `Repo → ${rName} (${toTildePath(expanded)})`,
            });
            broadcast({ type: "harness_event", sessionId, event: ev });
          }
          if (typeof body.harnessId === "string" || typeof body.effort === "string") {
            const prevSpec = getHarnessSpec(existing.harnessId);
            const nextSpec = typeof body.harnessId === "string" ? getHarnessSpec(body.harnessId) : prevSpec;
            const nextEffort = normalizeEffort(
              nextSpec,
              typeof body.effort === "string" ? body.effort : existing.effort
            );
            const resetProviderSession = nextSpec.runner !== prevSpec.runner;
            store.updateSessionConfig(sessionId, {
              family: nextSpec.family,
              model: nextSpec.model,
              effort: nextEffort,
              harnessId: nextSpec.id,
              resetProviderSession,
            });
          }
          let inspectSync: any = null;
          if (typeof body.pageAccess === "boolean") {
            if (body.pageAccess) touch(sessionId);
            store.setPageAccess(sessionId, body.pageAccess);
            const ev = store.insertEvent({
              sessionId,
              kind: "inspect",
              summary: body.pageAccess
                ? "See Page ENABLED — live DOM/DevTools attached"
                : "See Page OFF — CDP detached",
            });
            broadcast({ type: "harness_event", sessionId, event: ev });
            if (bridge.isExtensionConnected()) {
              inspectSync = await bridge.syncInspectState(sessionId, body.pageAccess);
            }
          }
          if (body.pigeonRelayMode === "ask" || body.pigeonRelayMode === "auto-queue") {
            store.setPigeonRelayMode(sessionId, body.pigeonRelayMode);
            const ev = store.insertEvent({
              sessionId,
              kind: "relay",
              summary:
                body.pigeonRelayMode === "auto-queue"
                  ? "Pigeon-Hole Relay → Auto-Queue (working cubbies queue directly with Undo)"
                  : "Pigeon-Hole Relay → Ask (stage editable Relay Card before sending)",
            });
            broadcast({ type: "harness_event", sessionId, event: ev });
          }

          const updated = serializeSession(store.getSessionFull(sessionId));
          broadcast({ type: "session_updated", session: updated });
          return jsonResp(req, { session: updated, inspectSync });
        }

        /* attach (older name) and move: the chat ends up on exactly one tab */
        if ((action === "attach" || action === "move") && req.method === "POST") {
          const body = await readJson(req);
          if (!body || typeof body.tabId !== "number") {
            return jsonResp(req, { error: "numeric tabId is required" }, 400);
          }
          const toTabId = body.tabId;
          const tabUrl = typeof body.url === "string" && body.url ? body.url : existing.lastUrl;
          const pageTitle = typeof body.title === "string" && body.title ? body.title : existing.pageTitle;
          const windowId = typeof body.windowId === "number" ? body.windowId : null;
          const reason = typeof body.reason === "string" ? body.reason.slice(0, 80) : "";

          // CDP stays tied to a tab, never to a chat: switch See Page off before the chat leaves its tab,
          // and for the chat being pushed off the target tab.
          const prevTabId = store.getTabIdForSession(sessionId);
          const target = store.getTabBinding(toTabId);
          const displacing = target && target.sessionId !== sessionId ? target.sessionId : null;
          for (const sid of [prevTabId !== toTabId ? sessionId : null, displacing]) {
            if (!sid) continue;
            const s = store.getSession(sid);
            if (!s?.pageAccess) continue;
            if (bridge.isExtensionConnected()) await bridge.syncInspectState(sid, false).catch(() => null);
            store.setPageAccess(sid, false);
          }

          const moved = store.moveSessionToTab(sessionId, toTabId, windowId, tabUrl);
          if (tabUrl) store.updateSessionUrl(sessionId, tabUrl, pageTitle);
          const where = (tabUrl || "").replace(/^https?:\/\//, "").replace(/^www\./, "").slice(0, 80) || "a new tab";
          const ev = store.insertEvent({
            sessionId,
            kind: "move",
            summary: `Moved chat to ${where}${reason ? ` (${reason})` : ""}`,
          });
          broadcast({ type: "harness_event", sessionId, event: ev });
          const full = serializeSession(store.getSessionFull(sessionId));
          broadcast({ type: "session_updated", session: full });
          broadcast({
            type: "session_moved",
            sessionId,
            fromTabIds: moved.fromTabIds,
            toTabId,
            displacedSessionId: moved.displacedSessionId,
            session: full,
          });
          if (moved.displacedSessionId) {
            const displaced = serializeSession(store.getSessionFull(moved.displacedSessionId));
            if (displaced) broadcast({ type: "session_updated", session: displaced });
          }
          return jsonResp(req, {
            session: full,
            fromTabIds: moved.fromTabIds,
            displacedSessionId: moved.displacedSessionId,
          });
        }

        /* Close a chat: stop its turn, switch See Page off, take it off its tab. History is kept. */
        if (action === "close" && req.method === "POST") {
          const wasRunning = runner.abort(sessionId, true);
          if (existing.pageAccess && bridge.isExtensionConnected()) {
            await bridge.syncInspectState(sessionId, false).catch(() => null);
          }
          const tabIds = store.closeSession(sessionId);
          store.setSessionAttention(sessionId, "");
          const ev = store.insertEvent({
            sessionId,
            kind: "close",
            summary: wasRunning ? "Closed chat (stopped the running turn)" : "Closed chat",
          });
          broadcast({ type: "harness_event", sessionId, event: ev });
          const full = serializeSession(store.getSessionFull(sessionId));
          broadcast({ type: "session_closed", sessionId, tabIds, session: full });
          broadcastRadar();
          return jsonResp(req, { ok: true, tabIds, stoppedTurn: wasRunning, session: full });
        }

        /* Resolve an .html path an agent mentioned (absolute, ~, file:// or repo-relative) to a file:// URL */
        if (action === "resolve-file" && req.method === "GET") {
          const raw = (url.searchParams.get("path") || "").trim();
          if (!raw) return jsonResp(req, { error: "path is required" }, 400);
          let p = raw;
          if (/^file:\/\//i.test(p)) {
            try {
              p = fileURLToPath(p);
            } catch {
              return jsonResp(req, { error: "Invalid file URL" }, 400);
            }
          }
          p = expandTildePath(p);
          const abs = isAbsolute(p) ? resolve(p) : resolve(existing.repoPath, p);
          if (!/\.html?$/i.test(abs)) return jsonResp(req, { error: "Only .html files can be opened" }, 400);
          const exists = existsSync(abs) && statSync(abs).isFile();
          return jsonResp(req, {
            ok: exists,
            exists,
            absPath: abs,
            displayPath: toTildePath(abs),
            fileUrl: pathToFileURL(abs).href,
          });
        }

        if (action === "attachments" && req.method === "POST") {
          if (!isSafeSegment(sessionId)) {
            return jsonResp(req, { error: "Invalid session id" }, 400);
          }
          const contentType = (req.headers.get("content-type") || "").toLowerCase();
          const saved: AttachmentRecord[] = [];

          if (contentType.includes("multipart/form-data")) {
            let form: FormData;
            try {
              form = await req.formData();
            } catch {
              return jsonResp(req, { error: "Invalid multipart form data" }, 400);
            }
            const entries = [...form.getAll("file"), ...form.getAll("files")].filter(
              (v): v is Blob => v instanceof Blob
            );
            if (entries.length === 0) {
              return jsonResp(req, { error: "No image files provided" }, 400);
            }
            for (const entry of entries) {
              if (entry.size > MAX_ATTACHMENT_BYTES) {
                return jsonResp(req, { error: "Image exceeds 20 MB limit" }, 400);
              }
              const bytes = new Uint8Array(await entry.arrayBuffer());
              const entryName =
                typeof (entry as File).name === "string" && (entry as File).name
                  ? (entry as File).name
                  : "image.png";
              const out = saveAttachmentBytes(sessionId, entryName, entry.type || "", bytes, attachmentsDir);
              if ("error" in out) return jsonResp(req, { error: out.error }, 400);
              saved.push(out);
            }
            return jsonResp(req, { attachment: saved[0], attachments: saved }, 201);
          }

          const body = await readJson(req);
          if (!body) return jsonResp(req, { error: "Invalid JSON body" }, 400);

          if (typeof body.localPath === "string" && body.localPath.trim()) {
            const out = saveAttachmentFromLocalPath(sessionId, body.localPath, attachmentsDir);
            if ("error" in out) return jsonResp(req, { error: out.error }, 400);
            return jsonResp(req, { attachment: out, attachments: [out] }, 201);
          }

          if (typeof body.dataBase64 === "string" && body.dataBase64.trim()) {
            let b64 = body.dataBase64.trim();
            let dataMime = "";
            const m = b64.match(/^data:([^;]+);base64,(.+)$/i);
            if (m) {
              dataMime = m[1].trim();
              b64 = m[2].trim();
            }
            const bytes = new Uint8Array(Buffer.from(b64, "base64"));
            const name = typeof body.name === "string" && body.name ? body.name : "pasted-image.png";
            const mime = typeof body.mimeType === "string" && body.mimeType ? body.mimeType : dataMime;
            const out = saveAttachmentBytes(sessionId, name, mime, bytes, attachmentsDir);
            if ("error" in out) return jsonResp(req, { error: out.error }, 400);
            return jsonResp(req, { attachment: out, attachments: [out] }, 201);
          }

          return jsonResp(req, { error: "Provide multipart file, localPath, or dataBase64" }, 400);
        }

        if (action === "prompt" && req.method === "POST") {
          const body = await readJson(req);
          if (!body) return jsonResp(req, { error: "Invalid JSON" }, 400);
          const text = typeof body.text === "string" ? body.text : "";
          const chips = Array.isArray(body.chips) ? (body.chips as ElementChip[]) : [];
          const attachments = sanitizeMessageAttachments(body.attachments, sessionId, attachmentsDir);
          if (attachments === null) {
            return jsonResp(req, { error: "Invalid attachments payload" }, 400);
          }
          const hasPinnedNote = chips.some((c) => typeof c?.note === "string" && c.note.trim().length > 0);
          if (!text.trim() && attachments.length === 0 && !hasPinnedNote) {
            return jsonResp(req, { error: "prompt text, pinned note, or image attachment is required" }, 400);
          }
          touch(sessionId);
          if (store.setSessionAttention(sessionId, "")) broadcastRadar();
          runner.dispatch(sessionId, text, chips, attachments).catch((err) => {
            console.error("[tab-agent] dispatch error:", err);
          });
          return jsonResp(req, { ok: true }, 202);
        }

        if (action === "ack" && req.method === "POST") {
          if (store.setSessionAttention(sessionId, "")) broadcastRadar();
          return jsonResp(req, { ok: true, radar: buildRadar() });
        }

        if (action === "triggers" && req.method === "POST") {
          const body = await readJson(req);
          if (!body || typeof body.instruction !== "string") {
            return jsonResp(req, { error: "instruction is required" }, 400);
          }
          const out = await pigeon.armTrigger(sessionId, {
            targetQuery: typeof body.targetSessionId === "string" ? body.targetSessionId : undefined,
            instruction: body.instruction,
          });
          if (!out.ok) return jsonResp(req, { ok: false, error: out.error }, 400);
          return jsonResp(req, { ok: true, trigger: out.trigger }, 201);
        }

        if (action === "shell" && req.method === "POST") {
          const body = await readJson(req);
          if (!body || typeof body.command !== "string") {
            return jsonResp(req, { error: "command is required" }, 400);
          }
          const out = shell.start(sessionId, {
            command: body.command,
            messageId: typeof body.messageId === "number" ? body.messageId : null,
            blockIdx: typeof body.blockIdx === "number" ? body.blockIdx : null,
            cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          });
          if (!out.ok) return jsonResp(req, { ok: false, error: out.error }, 400);
          return jsonResp(req, { ok: true, run: out.run }, 202);
        }

        if (action === "abort" && req.method === "POST") {
          const stopped = runner.abort(sessionId);
          return jsonResp(req, { ok: true, stopped });
        }

        if (action === "relays" && req.method === "POST") {
          const body = await readJson(req);
          if (!body || typeof body.text !== "string") {
            return jsonResp(req, { error: "text is required" }, 400);
          }
          const out = await pigeon.createFromUserAction(sessionId, {
            text: body.text,
            mode: typeof body.mode === "string" ? body.mode : "queue",
            targetSessionId: typeof body.targetSessionId === "string" ? body.targetSessionId : undefined,
            messageId: typeof body.messageId === "number" ? body.messageId : null,
            executeNow: body.executeNow !== false,
          });
          if (!out.ok) {
            return jsonResp(req, { ok: false, error: out.error || "Relay failed", relay: out.relay }, 400);
          }
          return jsonResp(req, { ok: true, relay: out.relay }, 201);
        }
      }

      /* ---- Pigeon-Hole Relay Controls ---- */
      if (url.pathname === "/api/pigeon/status" && req.method === "GET") {
        const rawUrl = url.searchParams.get("url") || "";
        const sid = url.searchParams.get("sessionId") || "";
        const effUrl = rawUrl || (sid ? store.getSession(sid)?.lastUrl || "" : "");
        const ctx = await pigeon.getContextForTab(effUrl, { forceFetch: true, timeoutMs: 2_500 });
        return jsonResp(req, { ok: true, pigeon: ctx });
      }

      if (url.pathname === "/api/pigeon/ack" && req.method === "POST") {
        const body = await readJson(req);
        const cubbyId = typeof body?.cubbyId === "string" ? body.cubbyId.trim() : "";
        if (!cubbyId) return jsonResp(req, { error: "cubbyId is required" }, 400);
        viewedPigeonAt.set(cubbyId, Date.now());
        broadcastRadar();
        return jsonResp(req, { ok: true, radar: buildRadar() });
      }

      const relayMatch = url.pathname.match(/^\/api\/relays\/([^/]+)\/(confirm|undo|promote|dismiss)$/);
      if (relayMatch && req.method === "POST") {
        const relayId = decodeURIComponent(relayMatch[1]);
        const relayAct = relayMatch[2];
        const body = (await readJson(req)) || {};
        if (relayAct === "confirm") {
          const res = await pigeon.confirmRelay(relayId, {
            text: typeof body.text === "string" ? body.text : undefined,
            mode: typeof body.mode === "string" ? body.mode : undefined,
            targetSessionId: typeof body.targetSessionId === "string" ? body.targetSessionId : undefined,
          });
          return jsonResp(req, res, res.ok ? 200 : 400);
        }
        if (relayAct === "undo") {
          const res = await pigeon.undoRelay(relayId);
          return jsonResp(req, res, res.ok ? 200 : 400);
        }
        if (relayAct === "promote") {
          const res = await pigeon.promoteRelayToSteer(relayId);
          return jsonResp(req, res, res.ok ? 200 : 400);
        }
        if (relayAct === "dismiss") {
          const res = pigeon.dismissRelay(relayId);
          return jsonResp(req, res, res.ok ? 200 : 404);
        }
      }

      const trigCancelMatch = url.pathname.match(/^\/api\/triggers\/([^/]+)\/cancel$/);
      if (trigCancelMatch && req.method === "POST") {
        const res = pigeon.cancelTrigger(decodeURIComponent(trigCancelMatch[1]));
        return jsonResp(req, res, res.ok ? 200 : 404);
      }

      const shellKillMatch = url.pathname.match(/^\/api\/shell\/([^/]+)\/kill$/);
      if (shellKillMatch && req.method === "POST") {
        const stopped = shell.kill(decodeURIComponent(shellKillMatch[1]));
        return jsonResp(req, { ok: true, stopped });
      }

      /* ---- Peer-to-Peer Tab-Agent Session Talk ---- */
      if (url.pathname === "/api/peers" && req.method === "GET") {
        const query = url.searchParams.get("query") || "";
        const excludeSessionId = url.searchParams.get("excludeSessionId") || "";
        const includeArchived = url.searchParams.get("includeArchived") === "1";
        const peers = listPeers(store, runner, pigeon, { query, excludeSessionId, includeArchived });
        return jsonResp(req, { ok: true, peers });
      }

      if (url.pathname === "/api/peers/read" && req.method === "GET") {
        const target = url.searchParams.get("target") || "";
        const last = Number(url.searchParams.get("last") || 8);
        const excludeSessionId = url.searchParams.get("excludeSessionId") || "";
        const res = await readPeer(store, runner, pigeon, target, { last, excludeSessionId });
        return jsonResp(req, res, res.ok ? 200 : 404);
      }

      if (url.pathname === "/api/peers/send" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body.target !== "string" || typeof body.message !== "string") {
          return jsonResp(req, { ok: false, error: "target and message are required" }, 400);
        }
        const res = await sendToPeer(store, runner, pigeon, broadcast, {
          fromSessionId: typeof body.fromSessionId === "string" ? body.fromSessionId : undefined,
          target: body.target,
          message: body.message,
          wait: body.wait !== false,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 120_000,
          depth: typeof body.depth === "number" ? body.depth : 0,
        });
        return jsonResp(req, res, res.ok ? 200 : 400);
      }

      /* ---- History FTS5 Search ---- */
      if (url.pathname === "/api/history" && req.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40)));
        return jsonResp(req, { hits: store.searchHistory(q, limit) });
      }

      /* ---- Repo Catalogue Search ---- */
      if (url.pathname === "/api/repos" && req.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const limit = Math.min(80, Math.max(1, Number(url.searchParams.get("limit") || 25)));
        return jsonResp(req, { repos: searchRepoCatalogue(q, limit) });
      }

      /* ---- URL -> Repo Rules ---- */
      if (url.pathname === "/api/rules" && req.method === "GET") {
        return jsonResp(req, { rules: store.listRules() });
      }
      if (url.pathname === "/api/rules" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body.pattern !== "string" || typeof body.repoPath !== "string") {
          return jsonResp(req, { error: "pattern and repoPath are required" }, 400);
        }
        const expanded = expandTildePath(body.repoPath.trim());
        const repoName =
          typeof body.repoName === "string" && body.repoName.trim()
            ? body.repoName.trim()
            : basename(expanded);
        const rule = store.upsertRule(body.pattern, expanded, repoName);
        broadcast({ type: "rules_updated", rules: store.listRules() });
        return jsonResp(req, { rule, rules: store.listRules() }, 201);
      }
      const ruleDelMatch = url.pathname.match(/^\/api\/rules\/(\d+)$/);
      if (ruleDelMatch && req.method === "DELETE") {
        const deleted = store.deleteRule(Number(ruleDelMatch[1]));
        broadcast({ type: "rules_updated", rules: store.listRules() });
        return jsonResp(req, { ok: deleted, rules: store.listRules() });
      }

      /* ---- Internal Authenticated MCP Bridge RPC ---- */
      if (url.pathname === "/api/mcp/call" && req.method === "POST") {
        const reqTok = req.headers.get("x-tab-agent-token") || "";
        if (token && reqTok !== token) {
          return jsonResp(req, { ok: false, error: "Unauthorized MCP bridge call" }, 401);
        }
        const body = await readJson(req);
        if (!body || typeof body.sessionId !== "string" || typeof body.op !== "string") {
          return jsonResp(req, { ok: false, error: "sessionId and op are required" }, 400);
        }
        const args =
          body.args && typeof body.args === "object" && !Array.isArray(body.args)
            ? (body.args as Record<string, unknown>)
            : {};
        touch(body.sessionId);
        if (body.op === "pigeon_status") {
          const result = await pigeon.handleMcpStatus(body.sessionId, args as any);
          return jsonResp(req, result, 200);
        }
        if (body.op === "pigeon_send") {
          const result = await pigeon.handleMcpSend(body.sessionId, args as any);
          return jsonResp(req, result, 200);
        }
        if (body.op === "pigeon_watch") {
          const result = await pigeon.handleMcpWatch(body.sessionId, args as any);
          return jsonResp(req, result, 200);
        }
        if (body.op === "peer_list") {
          const peers = listPeers(store, runner, pigeon, {
            query: typeof args.query === "string" ? args.query : "",
            excludeSessionId: body.sessionId,
          });
          return jsonResp(req, { ok: true, data: { peers } }, 200);
        }
        if (body.op === "peer_read") {
          const res = await readPeer(store, runner, pigeon, String(args.target || ""), {
            last: typeof args.last === "number" ? args.last : 8,
            excludeSessionId: body.sessionId,
          });
          return jsonResp(req, res.ok ? { ok: true, data: res } : { ok: false, error: res.error }, 200);
        }
        if (body.op === "peer_send") {
          const res = await sendToPeer(store, runner, pigeon, broadcast, {
            fromSessionId: body.sessionId,
            target: String(args.target || ""),
            message: String(args.message || ""),
            wait: args.wait !== false,
            timeoutMs:
              typeof args.timeoutSeconds === "number" ? Math.round(args.timeoutSeconds * 1000) : 120_000,
          });
          return jsonResp(req, res.ok ? { ok: true, data: res } : { ok: false, error: String(res.error || "Peer send failed") }, 200);
        }
        const result = await bridge.callBrowserOp(body.sessionId, body.op, args);
        return jsonResp(req, result, result.ok ? 200 : 200);
      }

      return jsonResp(req, { error: "Not found" }, 404);
    },
    websocket: {
      idleTimeout: 0,
      sendPings: true,
      open(ws) {
        if (ws.data.role === "extension") {
          bridge.registerExtensionSocket(ws);
          broadcast({ type: "extension_status", connected: true });
          ws.send(JSON.stringify({ type: "radar_updated", radar: buildRadar() }));
        } else {
          panelClients.add(ws);
          ws.send(
            JSON.stringify({
              type: "hello",
              extensionConnected: bridge.isExtensionConnected(),
              activeRuns: runner.getActiveSessionIds(),
              radar: buildRadar(),
            })
          );
        }
      },
      close(ws) {
        if (ws.data.role === "extension") {
          bridge.unregisterExtensionSocket(ws);
          broadcast({ type: "extension_status", connected: bridge.isExtensionConnected() });
        } else {
          panelClients.delete(ws);
        }
      },
      message(ws, raw) {
        let msg: any;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch {
          return;
        }
        if (ws.data.role === "extension") {
          if (msg.type === "browser_result") {
            bridge.handleExtensionResult(msg);
          } else if (msg.type === "cdp_stats" && typeof msg.tabId === "number") {
            bridge.updateCdpStats(msg.tabId, {
              attached: Boolean(msg.attached),
              consoleErrors: Number(msg.consoleErrors || 0),
              failedRequests: Number(msg.failedRequests || 0),
            });
            broadcast({
              type: "cdp_stats",
              tabId: msg.tabId,
              attached: Boolean(msg.attached),
              consoleErrors: Number(msg.consoleErrors || 0),
              failedRequests: Number(msg.failedRequests || 0),
            });
          } else if (msg.type === "cdp_detached" && typeof msg.tabId === "number") {
            bridge.updateCdpStats(msg.tabId, {
              attached: false,
              consoleErrors: 0,
              failedRequests: 0,
            });
            const binding = store.getTabBinding(msg.tabId);
            if (binding) {
              store.setPageAccess(binding.sessionId, false);
              const updated = serializeSession(store.getSessionFull(binding.sessionId));
              if (updated) broadcast({ type: "session_updated", session: updated });
            }
          }
        }
      },
    },
  });

  runner = new HarnessRunner(store, broadcast, {
    port: server.port ?? port,
    token,
    attachmentsDir,
    stallMs: opts.stallMs,
    pigeonBridge: pigeon,
    onTurnLifecycle: (info) => {
      if (info.phase === "start") {
        store.setSessionAttention(info.sessionId, "");
      } else if (info.phase === "abort") {
        store.setSessionAttention(info.sessionId, "");
      } else if (info.phase === "end") {
        if (info.isError) {
          store.setSessionAttention(info.sessionId, "error", info.snippet || "Harness error");
        } else {
          const boundTabId = store.getTabIdForSession(info.sessionId);
          const onAnotherTab = boundTabId !== null && activeTabId !== null && boundTabId !== activeTabId;
          if (onAnotherTab || info.fromTrigger || (info.durationMs ?? 0) >= attentionMinMs) {
            const kind: AttentionKind = looksLikeNeedsYou(info.snippet || "") ? "needs-you" : "done";
            store.setSessionAttention(
              info.sessionId,
              kind,
              info.snippet || (kind === "needs-you" ? "Needs your reply" : "Turn finished")
            );
          }
        }
      }
      broadcastRadar();
    },
  });

  // A chat costs nothing between turns (each turn is its own CLI process that exits when done).
  // What can linger is See Page: Chrome keeps the debugger attached. Switch it off after a quiet spell.
  const sweepSeePage = async (): Promise<string[]> => {
    const now = Date.now();
    const switchedOff: string[] = [];
    for (const b of store.listBindings()) {
      const s = store.getSession(b.sessionId);
      if (!s?.pageAccess || runner.isRunning(s.id) || switchedOff.includes(s.id)) continue;
      const last = lastTouched.get(s.id) ?? startedAt;
      if (now - last < seePageIdleMs) continue;
      if (bridge.isExtensionConnected()) await bridge.syncInspectState(s.id, false).catch(() => null);
      store.setPageAccess(s.id, false);
      const ev = store.insertEvent({
        sessionId: s.id,
        kind: "inspect",
        summary: `See Page switched off after ${Math.round(seePageIdleMs / 60_000)} min idle`,
      });
      broadcast({ type: "harness_event", sessionId: s.id, event: ev });
      const updated = serializeSession(store.getSessionFull(s.id));
      if (updated) broadcast({ type: "session_updated", session: updated });
      switchedOff.push(s.id);
    }
    return switchedOff;
  };
  const sweepTimer = setInterval(() => {
    sweepSeePage().catch(() => {});
  }, Math.min(5 * 60_000, Math.max(100, Math.floor(seePageIdleMs / 3))));

  return {
    server,
    store,
    bridge,
    pigeon,
    shell,
    runner,
    token,
    port: server.port ?? port,
    sweepSeePage,
    getRadar: buildRadar,
    stop() {
      clearInterval(sweepTimer);
      pigeon.stopWatcher();
      shell.killAll();
      runner.abortAll();
      server.stop(true);
      store.close();
    },
  };
}

if (import.meta.main) {
  const handle = createTabAgentServer();
  // Stopping the daemon stops its running turns too, so no agent CLI is left running on its own.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      const n = handle.runner.abortAll();
      if (n) console.log(`[tab-agent] stopped ${n} running turn(s) on ${sig}`);
      handle.stop();
      process.exit(0);
    });
  }
  console.log(
    `Tab-Agent daemon live on http://127.0.0.1:${handle.port} (PID ${process.pid})`
  );
}
