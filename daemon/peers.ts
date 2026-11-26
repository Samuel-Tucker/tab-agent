import type { TabAgentStore } from "./db";
import type { BroadcastFn, HarnessRunner } from "./harnesses";
import type { PigeonBridge } from "./pigeon-bridge";
import { toTildePath } from "./url-repo";

export const MAX_PEER_DEPTH = 3;

export interface PeerSummary {
  kind: "tab" | "pigeon";
  id: string;
  name: string;
  repoName: string;
  repoPath: string;
  displayRepoPath: string;
  url: string;
  tabId: number | null;
  bound: boolean;
  state: string;
  isRunning: boolean;
  family: string;
  model: string;
  effort: string;
  lastReply: string;
  updatedAt: number;
}

function norm(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function scorePeerMatch(peer: PeerSummary, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return peer.bound ? 100 : peer.kind === "pigeon" ? 60 : 40;
  const qNorm = norm(q);

  if (peer.id.toLowerCase() === q) return 1000;
  if (peer.repoName.toLowerCase() === q || norm(peer.repoName) === qNorm) {
    return peer.kind === "tab" ? (peer.bound ? 900 : 750) : 700;
  }
  if (peer.name.toLowerCase() === q || norm(peer.name) === qNorm) {
    return peer.kind === "tab" ? (peer.bound ? 850 : 700) : 650;
  }

  let score = 0;
  if (peer.repoName.toLowerCase().includes(q) || (qNorm && norm(peer.repoName).includes(qNorm))) {
    score = Math.max(score, 600);
  }
  if (peer.displayRepoPath.toLowerCase().includes(q) || peer.repoPath.toLowerCase().includes(q)) {
    score = Math.max(score, 520);
  }
  if (peer.name.toLowerCase().includes(q) || (qNorm && norm(peer.name).includes(qNorm))) {
    score = Math.max(score, 500);
  }
  if (peer.url.toLowerCase().includes(q)) {
    score = Math.max(score, 350);
  }
  if (score === 0) return 0;

  // Prefer currently open Tab-Agent tabs, then Pigeon-Hole cubbies, then archived Tab-Agent chats
  if (peer.kind === "tab" && peer.bound) score += 80;
  else if (peer.kind === "pigeon") score += 30;
  return score;
}

export function listPeers(
  store: TabAgentStore,
  runner: HarnessRunner,
  pigeon: PigeonBridge | undefined,
  opts: { query?: string; excludeSessionId?: string; includeArchived?: boolean } = {}
): PeerSummary[] {
  const exclude = opts.excludeSessionId || "";
  const bindings = store.listBindings();
  const tabBySession = new Map<string, number>();
  for (const b of bindings) {
    if (!tabBySession.has(b.sessionId)) tabBySession.set(b.sessionId, b.tabId);
  }

  const allSessions = store.listSessions(60);
  const peers: PeerSummary[] = [];

  for (const s of allSessions) {
    if (s.id === exclude) continue;
    const tabId = tabBySession.get(s.id) ?? null;
    const bound = tabId !== null;
    if (!bound && !opts.includeArchived && s.archived) continue;
    peers.push({
      kind: "tab",
      id: s.id,
      name: s.name,
      repoName: s.repoName,
      repoPath: s.repoPath,
      displayRepoPath: toTildePath(s.repoPath),
      url: s.lastUrl,
      tabId,
      bound,
      state: runner.isRunning(s.id) ? "working" : s.state,
      isRunning: runner.isRunning(s.id),
      family: s.family,
      model: s.model,
      effort: s.effort,
      lastReply: s.questionSnippet || "",
      updatedAt: s.updatedAt,
    });
  }

  if (pigeon) {
    const snap = pigeon.getLiveSnapshot();
    for (const c of snap.cubbies) {
      peers.push({
        kind: "pigeon",
        id: c.id,
        name: c.name,
        repoName: c.name,
        repoPath: "",
        displayRepoPath: `pigeon-hole:${c.id}`,
        url: `${pigeon.baseUrl}/#s=${encodeURIComponent(c.id)}`,
        tabId: null,
        bound: true,
        state: c.state,
        isRunning: c.state === "working",
        family: "PIGEON",
        model: "",
        effort: "",
        lastReply: c.snippet || "",
        updatedAt: c.updatedAt,
      });
    }
  }

  const q = (opts.query || "").trim();
  const scored = peers
    .map((p) => ({ peer: p, score: scorePeerMatch(p, q) }))
    .filter((x) => !q || x.score > 0)
    .sort((a, b) => b.score - a.score || b.peer.updatedAt - a.peer.updatedAt);

  return scored.map((x) => x.peer);
}

export function resolvePeer(
  store: TabAgentStore,
  runner: HarnessRunner,
  pigeon: PigeonBridge | undefined,
  target: string,
  excludeSessionId?: string
): { ok: true; peer: PeerSummary } | { ok: false; error: string; candidates: PeerSummary[] } {
  const clean = (target || "").trim();
  if (!clean) {
    const all = listPeers(store, runner, pigeon, { excludeSessionId });
    return { ok: false, error: "Target repo name or session ID is required.", candidates: all.slice(0, 10) };
  }

  // First search open tabs + Pigeon-Hole; fall back to archived tabs if nothing open matches
  let matches = listPeers(store, runner, pigeon, { query: clean, excludeSessionId, includeArchived: false });
  if (matches.length === 0) {
    matches = listPeers(store, runner, pigeon, { query: clean, excludeSessionId, includeArchived: true });
  }
  if (matches.length === 0) {
    const all = listPeers(store, runner, pigeon, { excludeSessionId });
    return {
      ok: false,
      error: `No Tab-Agent session found matching "${clean}".`,
      candidates: all.slice(0, 10),
    };
  }
  return { ok: true, peer: matches[0] };
}

export async function readPeer(
  store: TabAgentStore,
  runner: HarnessRunner,
  pigeon: PigeonBridge | undefined,
  target: string,
  opts: { last?: number; excludeSessionId?: string } = {}
): Promise<
  | {
      ok: true;
      peer: PeerSummary;
      messages: Array<{ sender: string; time: string; text: string }>;
    }
  | { ok: false; error: string; candidates?: PeerSummary[] }
> {
  const found = resolvePeer(store, runner, pigeon, target, opts.excludeSessionId);
  if (!found.ok) return found;
  const lastN = Math.min(30, Math.max(1, Number(opts.last || 8)));

  if (found.peer.kind === "pigeon" && pigeon) {
    const st = await pigeon.handleMcpStatus(opts.excludeSessionId || "", {
      targetSessionId: found.peer.id,
      includeMessages: true,
    });
    if (!st.ok) return { ok: false, error: st.error || "Could not read Pigeon-Hole cubby" };
    const msgs = Array.isArray((st.data as any)?.recentMessages)
      ? ((st.data as any).recentMessages as any[]).slice(-lastN).map((m) => ({
          sender: String(m.sender || "agent"),
          time: String(m.time || ""),
          text: String(m.text || ""),
        }))
      : [];
    return { ok: true, peer: found.peer, messages: msgs };
  }

  const full = store.getSessionFull(found.peer.id);
  if (!full) return { ok: false, error: `Session ${found.peer.id} no longer exists.` };
  const msgs = full.messages.slice(-lastN).map((m) => ({
    sender: m.sender,
    time: m.time,
    text: m.text,
  }));
  return { ok: true, peer: found.peer, messages: msgs };
}

export async function sendToPeer(
  store: TabAgentStore,
  runner: HarnessRunner,
  pigeon: PigeonBridge | undefined,
  broadcast: BroadcastFn,
  opts: {
    fromSessionId?: string;
    target: string;
    message: string;
    wait?: boolean;
    timeoutMs?: number;
    depth?: number;
  }
): Promise<Record<string, unknown>> {
  const depth = Math.max(0, Number(opts.depth || 0));
  if (depth >= MAX_PEER_DEPTH) {
    return {
      ok: false,
      error: `Peer message hop limit (${MAX_PEER_DEPTH}) reached — respond directly to the user instead of forwarding further.`,
    };
  }
  const cleanMsg = (opts.message || "").trim();
  if (!cleanMsg) return { ok: false, error: "message is required" };

  const found = resolvePeer(store, runner, pigeon, opts.target, opts.fromSessionId);
  if (!found.ok) return found;

  const caller = opts.fromSessionId ? store.getSession(opts.fromSessionId) : null;
  const fromRepo = caller?.repoName || "Peer-Session";
  const fromName = caller?.name || opts.fromSessionId || "External";

  if (found.peer.kind === "pigeon") {
    if (!pigeon) return { ok: false, error: "Pigeon-Hole bridge is unavailable." };
    const res = await pigeon.handleMcpSend(opts.fromSessionId || "", {
      targetSessionId: found.peer.id,
      mode: "queue",
      text: `[Peer Message from Tab-Agent · ${fromRepo} (${fromName})]\n\n${cleanMsg}`,
      reason: `Peer message from ${fromRepo}`,
    });
    return res.ok ? { ok: true, peer: found.peer, relayed: res.data } : { ok: false, error: res.error };
  }

  const targetSession = store.getSession(found.peer.id);
  if (!targetSession) return { ok: false, error: `Peer session ${found.peer.id} no longer exists.` };

  if (caller) {
    const evOut = store.insertEvent({
      sessionId: caller.id,
      kind: "peer",
      summary: `→ Asked ${targetSession.repoName} (${targetSession.name}): ${cleanMsg.slice(0, 80)}`,
    });
    broadcast({ type: "harness_event", sessionId: caller.id, event: evOut });
  }
  const evIn = store.insertEvent({
    sessionId: targetSession.id,
    kind: "peer",
    summary: `← From ${fromRepo} (${fromName}): ${cleanMsg.slice(0, 80)}`,
  });
  broadcast({ type: "harness_event", sessionId: targetSession.id, event: evIn });

  const peerPrompt =
    `[Peer Agent Message from ${fromRepo} ("${fromName}", session: ${caller?.id || "external"})]\n` +
    `Another Tab-Agent session is asking you on the user's behalf. Reply directly and concisely — your reply will be returned to the calling agent.\n\n` +
    cleanMsg;
  const displayText = `[Peer · ${fromRepo}] ${cleanMsg}`;

  const shouldWait = opts.wait !== false;
  if (!shouldWait) {
    runner
      .dispatch(targetSession.id, peerPrompt, [], [], {
        displayText,
        peerDepth: depth + 1,
      })
      .catch((err) => console.error("[tab-agent] async peer dispatch error:", err));
    return {
      ok: true,
      peer: found.peer,
      sent: true,
      waited: false,
    };
  }

  const timeoutMs = Math.min(300_000, Math.max(5_000, Number(opts.timeoutMs || 120_000)));
  let settled = false;
  const replyResult = await new Promise<{ reply: string; isError: boolean; timedOut: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        reply: "",
        isError: false,
        timedOut: true,
      });
    }, timeoutMs);

    runner
      .dispatch(targetSession.id, peerPrompt, [], [], {
        displayText,
        peerDepth: depth + 1,
        onComplete: (reply, isError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ reply, isError, timedOut: false });
        },
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ reply: `Error: ${err?.message || err}`, isError: true, timedOut: false });
      });
  });

  if (caller && !replyResult.timedOut) {
    const evBack = store.insertEvent({
      sessionId: caller.id,
      kind: "peer",
      summary: `← Reply from ${targetSession.repoName}: ${replyResult.reply.replace(/\s+/g, " ").slice(0, 80)}`,
    });
    broadcast({ type: "harness_event", sessionId: caller.id, event: evBack });
  }

  return {
    ok: !replyResult.isError,
    peer: found.peer,
    waited: true,
    timedOut: replyResult.timedOut,
    reply: replyResult.reply,
    ...(replyResult.timedOut
      ? { note: `Peer "${targetSession.repoName}" is still working after ${Math.round(timeoutMs / 1000)}s; check back with tab-peer read "${targetSession.repoName}".` }
      : {}),
  };
}
