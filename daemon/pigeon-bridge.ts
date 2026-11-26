import { randomUUID } from "node:crypto";
import type {
  PigeonRelayKind,
  PigeonRelayRecord,
  PigeonRelayStatus,
  PigeonTriggerRecord,
  TabAgentStore,
} from "./db";
import type { BroadcastFn } from "./harnesses";

export interface PigeonRecentMessage {
  sender: string;
  time: string;
  text: string;
}

export interface PigeonCubby {
  id: string;
  name: string;
  shelf: string;
  path: string;
  displayPath: string;
  state: "working" | "needs-you" | "seen" | string;
  family: string;
  model: string;
  effort: string;
  queuedCount: number;
  steerState: string | null;
  recentMessages: PigeonRecentMessage[];
}

export interface PigeonTabContext {
  isPigeonHole: boolean;
  baseUrl: string;
  online: boolean;
  activeSessionId: string | null;
  activeCubby: PigeonCubby | null;
  cubbies: PigeonCubby[];
  error?: string;
}

export interface PigeonLiveCubbyState {
  id: string;
  name: string;
  state: string;
  snippet: string;
  updatedAt: number;
}

export interface PigeonBridgeOptions {
  baseUrl?: string;
  timeoutMs?: number;
  watchWs?: boolean;
  reconnectMs?: number;
  getActiveAgentMessageId?: (sessionId: string) => number | null;
  onTriggerFired?: (trigger: PigeonTriggerRecord, wakePrompt: string, displayNote: string) => void;
  onLiveStateChange?: () => void;
}

export function resolvePigeonBaseUrl(override?: string): string {
  const raw =
    override ||
    process.env.PIGEON_HOLE_URL ||
    `http://127.0.0.1:${process.env.PIGEON_HOLE_PORT || 7742}`;
  return raw.replace(/\/+$/, "");
}

export function parsePigeonTabUrl(
  rawUrl: string,
  baseUrl = resolvePigeonBaseUrl()
): { isPigeonHole: boolean; sessionId: string | null } {
  if (!rawUrl) return { isPigeonHole: false, sessionId: null };
  let targetPort = "7742";
  try {
    const bu = new URL(baseUrl);
    targetPort = bu.port || (bu.protocol === "https:" ? "443" : "80");
  } catch {}

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { isPigeonHole: false, sessionId: null };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { isPigeonHole: false, sessionId: null };
  }
  const host = u.hostname.toLowerCase();
  const isLocal = host === "127.0.0.1" || host === "localhost";
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (!isLocal || port !== targetPort) {
    return { isPigeonHole: false, sessionId: null };
  }

  let sessionId: string | null = null;
  const hash = u.hash || "";
  const m = /^#s=([^&]+)/.exec(hash);
  if (m && m[1]) {
    try {
      sessionId = decodeURIComponent(m[1]).trim() || null;
    } catch {
      sessionId = m[1].trim() || null;
    }
  }
  return { isPigeonHole: true, sessionId };
}

function trimMessage(text: string, max = 700): string {
  const clean = String(text || "").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

function mapCubby(raw: any): PigeonCubby {
  const rawMsgs = Array.isArray(raw?.messages) ? raw.messages : [];
  const recentMessages: PigeonRecentMessage[] = rawMsgs.slice(-6).map((m: any) => ({
    sender: String(m?.sender || "agent"),
    time: String(m?.time || ""),
    text: trimMessage(String(m?.text || "")),
  }));
  const steerRaw = raw?.steerState;
  const steerState =
    typeof steerRaw === "string"
      ? steerRaw
      : steerRaw && typeof steerRaw === "object"
        ? String(steerRaw.status || steerRaw.state || "active")
        : null;
  return {
    id: String(raw?.id || ""),
    name: String(raw?.name || raw?.id || "Cubby"),
    shelf: String(raw?.shelf || ""),
    path: String(raw?.path || ""),
    displayPath: String(raw?.displayPath || raw?.path || ""),
    state: String(raw?.state || "idle"),
    family: String(raw?.family || ""),
    model: String(raw?.model || ""),
    effort: String(raw?.effort || ""),
    queuedCount: Number(raw?.queuedCount || 0),
    steerState,
    recentMessages,
  };
}

function normalizeRelayMode(raw: unknown): PigeonRelayKind {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "steer") return "steer";
  if (s === "send" || s === "auto") return "send";
  return "queue";
}

export class PigeonBridge {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly reconnectMs: number;
  private readonly getActiveAgentMessageId?: (sessionId: string) => number | null;
  private readonly onTriggerFired?: (trigger: PigeonTriggerRecord, wakePrompt: string, displayNote: string) => void;
  private readonly onLiveStateChange?: () => void;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watcherStopped = false;
  private wsConnected = false;
  private liveCubbies = new Map<string, PigeonLiveCubbyState>();

  constructor(
    private readonly store: TabAgentStore,
    private readonly broadcast: BroadcastFn,
    opts: PigeonBridgeOptions = {}
  ) {
    this.baseUrl = resolvePigeonBaseUrl(opts.baseUrl);
    this.timeoutMs = opts.timeoutMs ?? 4_000;
    this.reconnectMs = opts.reconnectMs ?? 4_000;
    this.getActiveAgentMessageId = opts.getActiveAgentMessageId;
    this.onTriggerFired = opts.onTriggerFired;
    this.onLiveStateChange = opts.onLiveStateChange;
    if (opts.watchWs !== false) {
      this.startWatcher();
    }
  }

  getLiveSnapshot(): { online: boolean; cubbies: PigeonLiveCubbyState[] } {
    return {
      online: this.wsConnected,
      cubbies: Array.from(this.liveCubbies.values()),
    };
  }

  startWatcher(): void {
    this.watcherStopped = false;
    this.connectPigeonWs();
  }

  stopWatcher(): void {
    this.watcherStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.wsConnected = false;
  }

  private scheduleWsReconnect(): void {
    if (this.watcherStopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectPigeonWs();
    }, this.reconnectMs);
    if (typeof (this.reconnectTimer as any)?.unref === "function") {
      (this.reconnectTimer as any).unref();
    }
  }

  private connectPigeonWs(): void {
    if (this.watcherStopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const wsUrl = this.baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:") + "/ws";
    let sock: WebSocket;
    try {
      sock = new WebSocket(wsUrl);
    } catch {
      this.scheduleWsReconnect();
      return;
    }
    this.ws = sock;

    sock.onopen = () => {
      if (this.watcherStopped) {
        try { sock.close(); } catch {}
        return;
      }
      this.wsConnected = true;
      this.syncLiveCubbies().catch(() => {});
    };

    sock.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handlePigeonWsMessage(msg);
    };

    sock.onerror = () => {
      try { sock.close(); } catch {}
    };

    sock.onclose = () => {
      if (this.ws === sock) this.ws = null;
      const wasConnected = this.wsConnected;
      this.wsConnected = false;
      if (wasConnected) {
        this.onLiveStateChange?.();
      }
      this.scheduleWsReconnect();
    };
  }

  async syncLiveCubbies(): Promise<void> {
    const boot = await this.fetchBootstrap(2_000);
    if (!boot.online) return;
    this.liveCubbies.clear();
    const now = Date.now();
    for (const c of boot.cubbies) {
      this.liveCubbies.set(c.id, {
        id: c.id,
        name: c.name,
        state: c.state,
        snippet: c.recentMessages.at(-1)?.text.slice(0, 120) || "",
        updatedAt: now,
      });
    }
    this.onLiveStateChange?.();
  }

  handlePigeonWsMessage(msg: any): void {
    if (!msg || typeof msg !== "object") return;
    const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";

    if (msg.type === "session_created" && msg.session?.id) {
      this.liveCubbies.set(String(msg.session.id), {
        id: String(msg.session.id),
        name: String(msg.session.name || msg.session.id),
        state: String(msg.session.state || "needs-you"),
        snippet: String(msg.session.questionSnippet || ""),
        updatedAt: Date.now(),
      });
      this.onLiveStateChange?.();
      return;
    }

    if (msg.type === "session_deleted" && sid) {
      this.liveCubbies.delete(sid);
      this.onLiveStateChange?.();
      return;
    }

    if (msg.type === "session_updated" && msg.session?.id) {
      const id = String(msg.session.id);
      const prev = this.liveCubbies.get(id);
      this.liveCubbies.set(id, {
        id,
        name: String(msg.session.name || prev?.name || id),
        state: String(msg.session.state || prev?.state || "seen"),
        snippet: String(msg.session.questionSnippet ?? prev?.snippet ?? ""),
        updatedAt: Date.now(),
      });
      this.onLiveStateChange?.();
      return;
    }

    if (msg.type === "session_state" && sid) {
      const prev = this.liveCubbies.get(sid);
      this.liveCubbies.set(sid, {
        id: sid,
        name: prev?.name || sid,
        state: String(msg.state || prev?.state || "seen"),
        snippet:
          typeof msg.questionSnippet === "string" ? msg.questionSnippet : prev?.snippet || "",
        updatedAt: Date.now(),
      });
      this.onLiveStateChange?.();
      return;
    }

    if (msg.type === "message_end" && sid) {
      const text = typeof msg.text === "string" ? msg.text : "";
      const prev = this.liveCubbies.get(sid);
      const cubbyName = prev?.name || sid;
      this.liveCubbies.set(sid, {
        id: sid,
        name: cubbyName,
        state: "needs-you",
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 140),
        updatedAt: Date.now(),
      });
      this.fireTriggersForCubby(sid, cubbyName, text);
      this.onLiveStateChange?.();
    }
  }

  private fireTriggersForCubby(targetSessionId: string, cubbyName: string, replyText: string): void {
    const armed = this.store.listArmedTriggers(targetSessionId);
    if (armed.length === 0) return;

    const excerpt = trimMessage(replyText || "(no text reply)", 900);
    const shortSnippet = replyText.replace(/\s+/g, " ").trim().slice(0, 120) || "Turn finished";

    for (const trig of armed) {
      const updated = this.store.updateTriggerStatus(trig.id, "fired", shortSnippet);
      if (!updated) continue;
      const ev = this.store.insertEvent({
        sessionId: trig.sessionId,
        kind: "after",
        summary: `/after fired: ${cubbyName} finished → waking chat`,
      });
      this.broadcast({ type: "harness_event", sessionId: trig.sessionId, event: ev });
      this.broadcast({ type: "trigger_updated", sessionId: trig.sessionId, trigger: updated });

      const wakePrompt = [
        "[Pigeon-Hole /after Trigger Fired]",
        `- Cubby: ${cubbyName} (${targetSessionId}) just finished its turn.`,
        `- Final reply excerpt:\n${excerpt}`,
        `- the user's /after instruction: ${trig.instruction}`,
        "- Note: Call pigeon_status if you need full recent messages, and call pigeon_send if the user asked you to stage or queue a follow-up.",
      ].join("\n");
      const displayNote = `⏰ /after fired (${cubbyName} finished): ${trig.instruction}`;
      this.onTriggerFired?.(updated, wakePrompt, displayNote);
    }
  }

  /**
   * Arm an /after trigger on a Pigeon-Hole cubby (from slash command or pigeon_watch MCP tool).
   */
  async armTrigger(
    sessionId: string,
    input: { targetQuery?: string; instruction: string }
  ): Promise<{ ok: boolean; trigger?: PigeonTriggerRecord; error?: string }> {
    const sess = this.store.getSession(sessionId);
    if (!sess) return { ok: false, error: `Unknown session: ${sessionId}` };

    const instruction = String(input.instruction || "").trim();
    if (!instruction) return { ok: false, error: "Instruction is required (e.g. /after check the verdict and stage next prompt)" };

    const parsed = parsePigeonTabUrl(sess.lastUrl, this.baseUrl);
    const boot = await this.fetchBootstrap(2_500);
    const q = String(input.targetQuery || "").trim();

    let targetId = "";
    let targetName = "";

    if (q) {
      const qLow = q.toLowerCase();
      const hit =
        boot.cubbies.find((c) => c.id.toLowerCase() === qLow || c.name.toLowerCase() === qLow) ||
        boot.cubbies.find((c) => c.id.toLowerCase().includes(qLow) || c.name.toLowerCase().includes(qLow));
      if (hit) {
        targetId = hit.id;
        targetName = hit.name;
      } else {
        targetId = q;
        targetName = q;
      }
    } else if (parsed.sessionId) {
      const hit = boot.cubbies.find((c) => c.id === parsed.sessionId);
      targetId = parsed.sessionId;
      targetName = hit?.name || parsed.sessionId;
    } else if (boot.cubbies.length === 1) {
      targetId = boot.cubbies[0].id;
      targetName = boot.cubbies[0].name;
    } else {
      const names = boot.cubbies.map((c) => c.id).join(", ");
      return {
        ok: false,
        error: names
          ? `Specify which Pigeon-Hole cubby to watch (active: ${names}), or open the cubby tab.`
          : "Specify which Pigeon-Hole cubby to watch (e.g. /after nova-kernel check the verdict).",
      };
    }

    const trig = this.store.insertTrigger({
      id: `trg-${randomUUID().slice(0, 10)}`,
      sessionId,
      targetSessionId: targetId,
      targetName,
      instruction,
    });
    const ev = this.store.insertEvent({
      sessionId,
      kind: "after",
      summary: `Armed /after on ${targetName}: ${instruction.slice(0, 64)}`,
    });
    this.broadcast({ type: "harness_event", sessionId, event: ev });
    this.broadcast({ type: "trigger_updated", sessionId, trigger: trig });
    this.onLiveStateChange?.();
    return { ok: true, trigger: trig };
  }

  cancelTrigger(triggerId: string): { ok: boolean; trigger?: PigeonTriggerRecord; error?: string } {
    const existing = this.store.getTrigger(triggerId);
    if (!existing) return { ok: false, error: "Trigger not found" };
    const updated = this.store.updateTriggerStatus(triggerId, "cancelled")!;
    const ev = this.store.insertEvent({
      sessionId: existing.sessionId,
      kind: "after",
      summary: `Cancelled /after on ${existing.targetName}`,
    });
    this.broadcast({ type: "harness_event", sessionId: existing.sessionId, event: ev });
    this.broadcast({ type: "trigger_updated", sessionId: existing.sessionId, trigger: updated });
    this.onLiveStateChange?.();
    return { ok: true, trigger: updated };
  }

  async handleMcpWatch(
    sessionId: string,
    args: { instruction?: string; targetSessionId?: string } = {}
  ): Promise<{ ok: boolean; data: any; error?: string }> {
    const res = await this.armTrigger(sessionId, {
      targetQuery: typeof args.targetSessionId === "string" ? args.targetSessionId : undefined,
      instruction: typeof args.instruction === "string" ? args.instruction : "",
    });
    if (!res.ok || !res.trigger) {
      return { ok: false, data: null, error: res.error || "Could not arm /after trigger" };
    }
    return {
      ok: true,
      data: {
        status: "armed",
        triggerId: res.trigger.id,
        targetSessionId: res.trigger.targetSessionId,
        targetName: res.trigger.targetName,
        instruction: res.trigger.instruction,
        note: `Armed /after watcher on ${res.trigger.targetName}. This chat will wake automatically when that cubby finishes its current turn.`,
      },
    };
  }

  private async fetchJson(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs
  ): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          data,
          error: (data && typeof data.error === "string" && data.error) || `HTTP ${res.status}`,
        };
      }
      return { ok: true, status: res.status, data };
    } catch (err: any) {
      const msg =
        err?.name === "AbortError"
          ? `Pigeon-Hole timed out on ${this.baseUrl}`
          : `Could not reach Pigeon-Hole on ${this.baseUrl}: ${err?.message || String(err)}`;
      return { ok: false, status: 0, data: null, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchBootstrap(timeoutMs = this.timeoutMs): Promise<{
    online: boolean;
    cubbies: PigeonCubby[];
    error?: string;
  }> {
    const res = await this.fetchJson("/api/bootstrap", { method: "GET" }, timeoutMs);
    if (!res.ok || !res.data) {
      return { online: false, cubbies: [], error: res.error || "Pigeon-Hole offline" };
    }
    const rawList = Array.isArray(res.data.sessions) ? res.data.sessions : [];
    const cubbies = rawList.map(mapCubby).filter((c: PigeonCubby) => Boolean(c.id));
    return { online: true, cubbies };
  }

  async getContextForTab(tabUrl: string, opts: { forceFetch?: boolean; timeoutMs?: number } = {}): Promise<PigeonTabContext | null> {
    const parsed = parsePigeonTabUrl(tabUrl, this.baseUrl);
    if (!parsed.isPigeonHole && !opts.forceFetch) return null;
    const boot = await this.fetchBootstrap(opts.timeoutMs ?? 1_500);
    const activeCubby = parsed.sessionId
      ? boot.cubbies.find((c) => c.id === parsed.sessionId) || null
      : null;
    return {
      isPigeonHole: parsed.isPigeonHole,
      baseUrl: this.baseUrl,
      online: boot.online,
      activeSessionId: parsed.sessionId,
      activeCubby,
      cubbies: boot.cubbies,
      ...(boot.error ? { error: boot.error } : {}),
    };
  }

  /**
   * MCP tool: pigeon_status
   * Always works even when See Page is OFF. Returns active cubby details (including last 6 messages)
   * plus the list of all active Pigeon-Hole cubbies.
   */
  async handleMcpStatus(
    sessionId: string,
    args: { targetSessionId?: string; includeMessages?: boolean } = {}
  ): Promise<{ ok: boolean; data: any; error?: string }> {
    const sess = this.store.getSession(sessionId);
    if (!sess) return { ok: false, data: null, error: `Unknown session: ${sessionId}` };

    const parsed = parsePigeonTabUrl(sess.lastUrl, this.baseUrl);
    const boot = await this.fetchBootstrap();
    if (!boot.online) {
      return {
        ok: false,
        data: { online: false, baseUrl: this.baseUrl, activeTabSessionId: parsed.sessionId },
        error: boot.error || `Pigeon-Hole is unreachable on ${this.baseUrl}`,
      };
    }

    const requestedId =
      (typeof args.targetSessionId === "string" && args.targetSessionId.trim()) ||
      parsed.sessionId ||
      null;
    const includeMessages = args.includeMessages !== false;
    const target = requestedId ? boot.cubbies.find((c) => c.id === requestedId) || null : null;

    const stripMsgs = (c: PigeonCubby) => ({
      id: c.id,
      name: c.name,
      shelf: c.shelf,
      path: c.path,
      displayPath: c.displayPath,
      state: c.state,
      family: c.family,
      model: c.model,
      effort: c.effort,
      queuedCount: c.queuedCount,
      steerState: c.steerState,
    });

    return {
      ok: true,
      data: {
        online: true,
        baseUrl: this.baseUrl,
        relayMode: sess.pigeonRelayMode,
        activeTabIsPigeonHole: parsed.isPigeonHole,
        activeTabSessionId: parsed.sessionId,
        targetCubby: target
          ? includeMessages
            ? target
            : stripMsgs(target)
          : null,
        cubbies: boot.cubbies.map(stripMsgs),
      },
    };
  }

  /**
   * MCP tool: pigeon_send
   * Respects Direction A policy:
   * - If relayMode === "auto-queue" AND mode === "queue" AND target cubby is live & working -> injects directly + Undo receipt.
   * - Otherwise (Ask mode, or mode === "steer", or idle cubby, or no target / offline) -> stages an editable Relay Card in the sidebar.
   */
  async handleMcpSend(
    sessionId: string,
    args: {
      text?: string;
      mode?: string;
      targetSessionId?: string;
      reason?: string;
    } = {}
  ): Promise<{ ok: boolean; data: any; error?: string }> {
    const sess = this.store.getSession(sessionId);
    if (!sess) return { ok: false, data: null, error: `Unknown session: ${sessionId}` };

    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return { ok: false, data: null, error: "text is required and cannot be empty." };

    const mode = normalizeRelayMode(args.mode);
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 200) : "";
    const parsed = parsePigeonTabUrl(sess.lastUrl, this.baseUrl);
    const boot = await this.fetchBootstrap();

    let targetSessionId =
      (typeof args.targetSessionId === "string" && args.targetSessionId.trim()) ||
      parsed.sessionId ||
      "";
    let targetCubby = targetSessionId
      ? boot.cubbies.find((c) => c.id === targetSessionId) || null
      : null;

    if (!targetSessionId && boot.cubbies.length === 1) {
      targetSessionId = boot.cubbies[0].id;
      targetCubby = boot.cubbies[0];
    }

    const targetName = targetCubby?.name || targetSessionId || "Choose Pigeon-Hole cubby";
    const messageId = this.getActiveAgentMessageId ? this.getActiveAgentMessageId(sessionId) : null;

    const canAutoQueue =
      sess.pigeonRelayMode === "auto-queue" &&
      mode === "queue" &&
      boot.online &&
      Boolean(targetCubby) &&
      targetCubby?.state === "working";

    const relayId = `rel-${randomUUID().slice(0, 10)}`;

    if (canAutoQueue && targetCubby) {
      const sent = await this.dispatchToPigeonHole(targetCubby.id, text, "queue");
      if (sent.ok) {
        const relay = this.store.insertRelay({
          id: relayId,
          sessionId,
          messageId,
          targetSessionId: targetCubby.id,
          targetName: targetCubby.name,
          mode: "queue",
          text,
          reason,
          status: sent.status,
          pigeonQueueId: sent.queueId,
          pigeonMessageId: sent.messageId,
          error: "",
          resolvedAt: Date.now(),
        });
        this.emitRelayUpdate(sessionId, relay, `Auto-queued into ${targetCubby.name}${sent.queueId ? ` (#${sent.queueId})` : ""}`);
        return {
          ok: true,
          data: {
            status: relay.status,
            relayId: relay.id,
            targetSessionId: targetCubby.id,
            targetName: targetCubby.name,
            queueId: sent.queueId,
            deduplicated: sent.deduplicated,
            note: "Injected directly into Pigeon-Hole queue (Auto-Queue is ON). the user can Undo or Promote to Steer in the sidebar.",
          },
        };
      }
      // If Pigeon-Hole rejected the auto-queue, fall back to staging with the error surfaced
      const failedRelay = this.store.insertRelay({
        id: relayId,
        sessionId,
        messageId,
        targetSessionId: targetCubby.id,
        targetName: targetCubby.name,
        mode: "queue",
        text,
        reason,
        status: "staged",
        error: sent.error || "Could not reach Pigeon-Hole",
      });
      this.emitRelayUpdate(sessionId, failedRelay, `Staged relay for ${targetCubby.name} (auto-queue failed)`);
      return {
        ok: true,
        data: {
          status: "staged",
          relayId: failedRelay.id,
          targetSessionId: targetCubby.id,
          targetName: targetCubby.name,
          error: sent.error,
          note: "Auto-queue failed so the prompt was staged as a Relay Card for the user to retry or copy.",
        },
      };
    }

    let whyStaged = "Relay mode is Ask — waiting for the user's click or ⌘⇧↩.";
    if (mode === "steer") {
      whyStaged = "Steer interrupts an active turn and always requires the user's confirmation.";
    } else if (!boot.online) {
      whyStaged = `Pigeon-Hole is unreachable on ${this.baseUrl}.`;
    } else if (!targetCubby) {
      whyStaged = "No target cubby selected — the user can pick one on the Relay Card.";
    } else if (targetCubby.state !== "working") {
      whyStaged = `Target cubby '${targetCubby.name}' is idle (${targetCubby.state}); starting a new turn requires the user's click.`;
    }

    const relay = this.store.insertRelay({
      id: relayId,
      sessionId,
      messageId,
      targetSessionId: targetCubby?.id || targetSessionId,
      targetName,
      mode,
      text,
      reason,
      status: "staged",
      error: !boot.online ? boot.error || `Pigeon-Hole unreachable on ${this.baseUrl}` : "",
    });
    this.emitRelayUpdate(sessionId, relay, `Staged ${mode} relay for ${targetName}`);

    return {
      ok: true,
      data: {
        status: "staged",
        relayId: relay.id,
        targetSessionId: relay.targetSessionId,
        targetName: relay.targetName,
        mode: relay.mode,
        targetState: targetCubby?.state || (boot.online ? "unselected" : "offline"),
        whyStaged,
        note: "Staged an editable Relay Card in Tab-Agent's sidebar. Do not re-call pigeon_send unless the user asks to revise it.",
      },
    };
  }

  /** User-triggered creation from the sidebar (e.g. clicking Queue ↗ on a code block). */
  async createFromUserAction(
    sessionId: string,
    input: {
      text: string;
      mode?: string;
      targetSessionId?: string;
      messageId?: number | null;
      executeNow?: boolean;
    }
  ): Promise<{ ok: boolean; relay?: PigeonRelayRecord; error?: string }> {
    const sess = this.store.getSession(sessionId);
    if (!sess) return { ok: false, error: "Session not found" };
    const text = String(input.text || "").trim();
    if (!text) return { ok: false, error: "Prompt text cannot be empty" };

    const mode = normalizeRelayMode(input.mode);
    const parsed = parsePigeonTabUrl(sess.lastUrl, this.baseUrl);
    const boot = await this.fetchBootstrap();
    const targetSessionId =
      (typeof input.targetSessionId === "string" && input.targetSessionId.trim()) ||
      parsed.sessionId ||
      "";
    const targetCubby = targetSessionId
      ? boot.cubbies.find((c) => c.id === targetSessionId) || null
      : null;

    const relayId = `rel-${randomUUID().slice(0, 10)}`;
    const relay = this.store.insertRelay({
      id: relayId,
      sessionId,
      messageId: typeof input.messageId === "number" ? input.messageId : null,
      targetSessionId: targetCubby?.id || targetSessionId,
      targetName: targetCubby?.name || targetSessionId || "Choose Pigeon-Hole cubby",
      mode,
      text,
      reason: "Triggered from code block",
      status: "staged",
    });

    if (input.executeNow && targetCubby) {
      return this.confirmRelay(relay.id, {
        text,
        mode,
        targetSessionId: targetCubby.id,
      });
    }

    this.emitRelayUpdate(sessionId, relay, `Staged ${mode} relay for ${relay.targetName}`);
    return { ok: true, relay };
  }

  async confirmRelay(
    relayId: string,
    overrides: { text?: string; mode?: string; targetSessionId?: string } = {}
  ): Promise<{ ok: boolean; relay?: PigeonRelayRecord; error?: string; deduplicated?: boolean }> {
    const existing = this.store.getRelay(relayId);
    if (!existing) return { ok: false, error: "Relay not found" };

    const text =
      typeof overrides.text === "string" && overrides.text.trim()
        ? overrides.text.trim()
        : existing.text;
    const mode = overrides.mode ? normalizeRelayMode(overrides.mode) : existing.mode;
    const targetSessionId =
      (typeof overrides.targetSessionId === "string" && overrides.targetSessionId.trim()) ||
      existing.targetSessionId;

    if (!targetSessionId) {
      return { ok: false, error: "Pick a target Pigeon-Hole cubby first" };
    }

    const boot = await this.fetchBootstrap();
    const targetCubby = boot.cubbies.find((c) => c.id === targetSessionId) || null;
    const targetName = targetCubby?.name || existing.targetName || targetSessionId;

    const sent = await this.dispatchToPigeonHole(targetSessionId, text, mode);
    if (!sent.ok) {
      const updated = this.store.updateRelay(relayId, {
        text,
        mode,
        targetSessionId,
        targetName,
        error: sent.error || "Failed to reach Pigeon-Hole",
      })!;
      this.emitRelayUpdate(existing.sessionId, updated, `Relay failed: ${sent.error}`);
      return { ok: false, relay: updated, error: sent.error };
    }

    const updated = this.store.updateRelay(relayId, {
      text,
      mode,
      targetSessionId,
      targetName,
      status: sent.status,
      pigeonQueueId: sent.queueId,
      pigeonMessageId: sent.messageId,
      error: "",
      resolvedAt: Date.now(),
    })!;
    const verb =
      updated.status === "queued"
        ? `Queued in ${targetName}${sent.queueId ? ` (#${sent.queueId})` : ""}`
        : updated.status === "steered"
          ? `Steered ${targetName}`
          : `Sent to ${targetName}`;
    this.emitRelayUpdate(existing.sessionId, updated, verb);
    return { ok: true, relay: updated, deduplicated: sent.deduplicated };
  }

  async undoRelay(relayId: string): Promise<{ ok: boolean; relay?: PigeonRelayRecord; error?: string }> {
    const existing = this.store.getRelay(relayId);
    if (!existing) return { ok: false, error: "Relay not found" };
    if (existing.status !== "queued" || existing.pigeonQueueId === null) {
      return { ok: false, error: "Only queued relays with a queueId can be undone" };
    }

    const res = await this.fetchJson(
      `/api/sessions/${encodeURIComponent(existing.targetSessionId)}/queue/${existing.pigeonQueueId}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const errMsg =
        res.status === 404
          ? "Already started running — cannot undo"
          : res.error || "Could not remove from Pigeon-Hole queue";
      const updated = this.store.updateRelay(relayId, { error: errMsg })!;
      this.emitRelayUpdate(existing.sessionId, updated, errMsg);
      return { ok: false, relay: updated, error: errMsg };
    }

    const updated = this.store.updateRelay(relayId, {
      status: "undone",
      pigeonQueueId: null,
      error: "",
      resolvedAt: Date.now(),
    })!;
    this.emitRelayUpdate(existing.sessionId, updated, `Removed queued prompt from ${existing.targetName}`);
    return { ok: true, relay: updated };
  }

  async promoteRelayToSteer(relayId: string): Promise<{ ok: boolean; relay?: PigeonRelayRecord; error?: string }> {
    const existing = this.store.getRelay(relayId);
    if (!existing) return { ok: false, error: "Relay not found" };
    if (existing.status !== "queued" || existing.pigeonQueueId === null) {
      return { ok: false, error: "Only queued relays can be promoted to steer" };
    }

    const res = await this.fetchJson(
      `/api/sessions/${encodeURIComponent(existing.targetSessionId)}/queue/${existing.pigeonQueueId}/steer`,
      { method: "POST" }
    );
    if (!res.ok) {
      const errMsg =
        res.status === 404
          ? "Already started running — cannot promote"
          : res.error || "Could not promote to steer";
      const updated = this.store.updateRelay(relayId, { error: errMsg })!;
      this.emitRelayUpdate(existing.sessionId, updated, errMsg);
      return { ok: false, relay: updated, error: errMsg };
    }

    const updated = this.store.updateRelay(relayId, {
      status: "steered",
      mode: "steer",
      pigeonQueueId: null,
      pigeonMessageId:
        typeof res.data?.humanMessage?.id === "number" ? res.data.humanMessage.id : existing.pigeonMessageId,
      error: "",
      resolvedAt: Date.now(),
    })!;
    this.emitRelayUpdate(existing.sessionId, updated, `Promoted queued prompt to Steer in ${existing.targetName}`);
    return { ok: true, relay: updated };
  }

  dismissRelay(relayId: string): { ok: boolean; relay?: PigeonRelayRecord; error?: string } {
    const existing = this.store.getRelay(relayId);
    if (!existing) return { ok: false, error: "Relay not found" };
    const updated = this.store.updateRelay(relayId, {
      status: "dismissed",
      error: "",
      resolvedAt: Date.now(),
    })!;
    this.emitRelayUpdate(existing.sessionId, updated, `Dismissed relay for ${existing.targetName}`);
    return { ok: true, relay: updated };
  }

  private async dispatchToPigeonHole(
    targetSessionId: string,
    text: string,
    mode: PigeonRelayKind
  ): Promise<{
    ok: boolean;
    status: PigeonRelayStatus;
    queueId: number | null;
    messageId: number | null;
    deduplicated: boolean;
    error?: string;
  }> {
    const pigeonMode = mode === "steer" ? "steer" : mode === "send" ? "auto" : "queue";
    const res = await this.fetchJson(
      `/api/sessions/${encodeURIComponent(targetSessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ text, mode: pigeonMode }),
      }
    );
    if (!res.ok || !res.data?.ok) {
      return {
        ok: false,
        status: "failed",
        queueId: null,
        messageId: null,
        deduplicated: false,
        error: res.error || "Pigeon-Hole rejected message",
      };
    }

    if (res.data.queued) {
      const qid = typeof res.data.queuedItem?.id === "number" ? res.data.queuedItem.id : null;
      return {
        ok: true,
        status: "queued",
        queueId: qid,
        messageId: null,
        deduplicated: Boolean(res.data.deduplicated),
      };
    }

    const mid = typeof res.data.message?.id === "number" ? res.data.message.id : null;
    return {
      ok: true,
      status: mode === "steer" ? "steered" : "sent",
      queueId: null,
      messageId: mid,
      deduplicated: false,
    };
  }

  private emitRelayUpdate(sessionId: string, relay: PigeonRelayRecord, summary: string): void {
    const ev = this.store.insertEvent({ sessionId, kind: "relay", summary });
    this.broadcast({ type: "harness_event", sessionId, event: ev });
    this.broadcast({ type: "relay_updated", sessionId, relay });
  }
}
