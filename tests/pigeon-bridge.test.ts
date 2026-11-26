import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { buildTabContextEnvelope } from "../daemon/harnesses";
import { parsePigeonTabUrl } from "../daemon/pigeon-bridge";
import { createTabAgentServer, type TabAgentServerHandle } from "../daemon/server";

let srv: TabAgentServerHandle | null = null;
let mockPigeon: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  if (srv) {
    srv.stop();
    srv = null;
  }
  if (mockPigeon) {
    mockPigeon.stop(true);
    mockPigeon = null;
  }
});

function startMockPigeonHole() {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let nextQueueId = 40;
  const queuedBySession = new Map<string, Array<{ id: number; text: string }>>();
  const sessions = [
    {
      id: "nova-kernel",
      name: "nova-kernel",
      shelf: "Hardware",
      path: "/tmp/demo-repos/nova-kernel",
      displayPath: "~/Projects/nova-kernel",
      state: "working",
      family: "AGY",
      model: "NEON",
      effort: "xhigh",
      queuedCount: 0,
      steerState: null,
      messages: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        sender: i % 2 === 0 ? "human" : "agent",
        time: `16:3${i}`,
        text: `Message #${i + 1} from NovaKernel cubby`,
      })),
    },
    {
      id: "pigeon-hole",
      name: "Pigeon-Hole",
      shelf: "Mac-Apps",
      path: "/tmp/demo-repos/pigeon-hole",
      displayPath: "~/Projects/pigeon-hole",
      state: "needs-you",
      family: "CLAUDE",
      model: "OPUS",
      effort: "high",
      queuedCount: 0,
      steerState: null,
      messages: [{ id: 1, sender: "agent", time: "16:10", text: "Waiting on your pick." }],
    },
  ];

  const wsClients = new Set<ServerWebSocket<unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srvInst) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srvInst.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/bootstrap" && req.method === "GET") {
        calls.push({ method: "GET", path: url.pathname });
        return Response.json({
          sessions: sessions.map((s) => ({
            ...s,
            queuedCount: (queuedBySession.get(s.id) || []).length,
          })),
        });
      }

      const msgMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (msgMatch && req.method === "POST") {
        const sid = decodeURIComponent(msgMatch[1]);
        const body = await req.json();
        calls.push({ method: "POST", path: url.pathname, body });
        const target = sessions.find((s) => s.id === sid);
        if (!target) return Response.json({ error: "Session not found" }, { status: 404 });
        if (body.mode === "queue" || (body.mode === "auto" && target.state === "working")) {
          const list = queuedBySession.get(sid) || [];
          const qid = ++nextQueueId;
          const item = { id: qid, text: body.text };
          list.push(item);
          queuedBySession.set(sid, list);
          return Response.json({
            ok: true,
            queued: true,
            deduplicated: false,
            queuedItem: item,
            queuedMessages: list,
          });
        }
        return Response.json({
          ok: true,
          message: { id: 900, sender: "human", text: body.text },
        });
      }

      const steerMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/queue\/(\d+)\/steer$/);
      if (steerMatch && req.method === "POST") {
        const sid = decodeURIComponent(steerMatch[1]);
        const qid = Number(steerMatch[2]);
        calls.push({ method: "POST", path: url.pathname });
        const list = queuedBySession.get(sid) || [];
        const idx = list.findIndex((q) => q.id === qid);
        if (idx === -1) return Response.json({ error: "Queued message not found" }, { status: 404 });
        const [removed] = list.splice(idx, 1);
        queuedBySession.set(sid, list);
        return Response.json({
          ok: true,
          humanMessage: { id: 901, text: removed.text },
          queuedMessages: list,
        });
      }

      const delMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/queue\/(\d+)$/);
      if (delMatch && req.method === "DELETE") {
        const sid = decodeURIComponent(delMatch[1]);
        const qid = Number(delMatch[2]);
        calls.push({ method: "DELETE", path: url.pathname });
        const list = queuedBySession.get(sid) || [];
        const idx = list.findIndex((q) => q.id === qid);
        if (idx === -1) return Response.json({ error: "Queued message not found" }, { status: 404 });
        list.splice(idx, 1);
        queuedBySession.set(sid, list);
        return Response.json({ ok: true, queuedMessages: list });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        wsClients.add(ws);
        ws.send(JSON.stringify({ type: "connected", ts: Date.now() }));
      },
      close(ws) {
        wsClients.delete(ws);
      },
      message() {},
    },
  });

  mockPigeon = server;
  const broadcastWs = (payload: Record<string, unknown>) => {
    const raw = JSON.stringify(payload);
    for (const ws of wsClients) ws.send(raw);
  };
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, calls, queuedBySession, wsClients, broadcastWs };
}

describe("Pigeon-Hole Relay Bridge", () => {
  test("parsePigeonTabUrl matches Pigeon-Hole origin and decodes #s=<id>", () => {
    expect(parsePigeonTabUrl("http://127.0.0.1:7742/#s=nova-kernel")).toEqual({
      isPigeonHole: true,
      sessionId: "nova-kernel",
    });
    expect(parsePigeonTabUrl("http://localhost:7742/")).toEqual({
      isPigeonHole: true,
      sessionId: null,
    });
    expect(parsePigeonTabUrl("http://127.0.0.1:7742/#s=my%20cubby&foo=1")).toEqual({
      isPigeonHole: true,
      sessionId: "my cubby",
    });
    expect(parsePigeonTabUrl("https://github.com/pulls")).toEqual({
      isPigeonHole: false,
      sessionId: null,
    });
    expect(parsePigeonTabUrl("http://127.0.0.1:4321/#s=other")).toEqual({
      isPigeonHole: false,
      sessionId: null,
    });
  });

  test("pigeon_status works with See Page OFF, Ask stages + confirms + undoes, Auto-Queue injects directly while Steer/Idle stay gated", async () => {
    const ph = startMockPigeonHole();
    srv = createTabAgentServer({
      port: 0,
      dbPath: ":memory:",
      token: "pigeon-test-tok",
      scratchDir: "/tmp/tab-agent-pigeon-scratch",
      pigeonHoleUrl: ph.baseUrl,
    });
    const base = `http://127.0.0.1:${srv.port}`;

    // Create session bound to Pigeon-Hole cubby URL (See Page OFF!)
    const createRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tabId: 101,
        url: `${ph.baseUrl}/#s=nova-kernel`,
        title: "Pigeon-Hole · nova-kernel",
        repoPath: "/tmp/demo-repos/pigeon-hole",
      }),
    });
    const { session } = await createRes.json();
    expect(session.pageAccess).toBe(false);
    expect(session.pigeonRelayMode).toBe("ask");

    const callMcp = async (op: string, args: Record<string, unknown> = {}) => {
      const r = await fetch(`${base}/api/mcp/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tab-Agent-Token": "pigeon-test-tok",
        },
        body: JSON.stringify({ sessionId: session.id, op, args }),
      });
      return r.json();
    };

    // 1. pigeon_status works with See Page OFF and returns last 6 messages
    const st = await callMcp("pigeon_status");
    expect(st.ok).toBe(true);
    expect(st.data.targetCubby.id).toBe("nova-kernel");
    expect(st.data.targetCubby.recentMessages.length).toBe(6);
    expect(st.data.targetCubby.recentMessages[0].text).toBe("Message #3 from NovaKernel cubby");
    expect(st.data.cubbies.length).toBe(2);

    // 2. Ask mode: pigeon_send stages a Relay Card without hitting Pigeon-Hole /messages
    const staged = await callMcp("pigeon_send", {
      text: "Run Lane A hardware safety check in parallel.",
      mode: "queue",
    });
    expect(staged.ok).toBe(true);
    expect(staged.data.status).toBe("staged");
    expect(ph.calls.filter((c) => c.method === "POST").length).toBe(0);

    // 3. Confirming staged relay with edited text queues it in Pigeon-Hole and returns queueId
    const confirmRes = await fetch(`${base}/api/relays/${staged.data.relayId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Run Lane A + kissat baseline in parallel.", mode: "queue" }),
    });
    const confirmed = await confirmRes.json();
    expect(confirmed.ok).toBe(true);
    expect(confirmed.relay.status).toBe("queued");
    expect(confirmed.relay.pigeonQueueId).toBe(41);
    expect(ph.queuedBySession.get("nova-kernel")?.length).toBe(1);

    // 4. Undo removes queued item from Pigeon-Hole
    const undoRes = await fetch(`${base}/api/relays/${staged.data.relayId}/undo`, { method: "POST" });
    const undone = await undoRes.json();
    expect(undone.ok).toBe(true);
    expect(undone.relay.status).toBe("undone");
    expect(ph.queuedBySession.get("nova-kernel")?.length).toBe(0);

    // 5. Switch to Auto-Queue mode via PATCH
    const patchRes = await fetch(`${base}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pigeonRelayMode: "auto-queue" }),
    });
    expect((await patchRes.json()).session.pigeonRelayMode).toBe("auto-queue");

    // 6. Auto-Queue on WORKING cubby queues directly!
    const autoQ = await callMcp("pigeon_send", {
      text: "Auto-queued parallel benchmark check",
      mode: "queue",
    });
    expect(autoQ.ok).toBe(true);
    expect(autoQ.data.status).toBe("queued");
    expect(autoQ.data.queueId).toBe(42);

    // 7. Promote auto-queued item to Steer
    const promoRes = await fetch(`${base}/api/relays/${autoQ.data.relayId}/promote`, { method: "POST" });
    const promoted = await promoRes.json();
    expect(promoted.ok).toBe(true);
    expect(promoted.relay.status).toBe("steered");

    // 8. Even in Auto-Queue mode, mode="steer" ALWAYS stays staged (Steer Gate)
    const steerAttempt = await callMcp("pigeon_send", {
      text: "Pause scp right now",
      mode: "steer",
    });
    expect(steerAttempt.ok).toBe(true);
    expect(steerAttempt.data.status).toBe("staged");

    // 9. Even in Auto-Queue mode, targeting an IDLE cubby ("pigeon-hole", needs-you) stays staged!
    const idleAttempt = await callMcp("pigeon_send", {
      text: "Start a new turn on idle cubby",
      mode: "queue",
      targetSessionId: "pigeon-hole",
    });
    expect(idleAttempt.ok).toBe(true);
    expect(idleAttempt.data.status).toBe("staged");
    expect(idleAttempt.data.targetState).toBe("needs-you");

    // 10. Context envelope includes [Pigeon-Hole Target] when pigeonContext is present
    const ctx = await srv.pigeon.getContextForTab(`${ph.baseUrl}/#s=nova-kernel`);
    const env = buildTabContextEnvelope(srv.store.getSession(session.id)!, "Queue it", [], { pigeonContext: ctx });
    expect(env).toContain("[Pigeon-Hole Target]");
    expect(env).toContain("nova-kernel");
    expect(env).toContain("pigeon_send");
  });

  test("/after slash command + pigeon_watch wake Tab-Agent on Pigeon-Hole WS message_end and update Cross-Tab Radar", async () => {
    const ph = startMockPigeonHole();
    const binDir = join(tmpdir(), `ta-after-${Date.now()}`);
    mkdirSync(binDir, { recursive: true });
    const fakeAgy = join(binDir, "agy");
    writeFileSync(
      fakeAgy,
      [
        "#!/bin/sh",
        'printf \'{"event":"init","conversation_id":"conv-after-1"}\\n\'',
        'printf \'{"event":"result","result":{"conversation_id":"conv-after-1","response":"Reviewed verdict — staging next step."}}\\n\'',
      ].join("\n"),
      { mode: 0o755 }
    );
    const prevAgy = process.env.AGY_BIN;
    process.env.AGY_BIN = fakeAgy;

    try {
      srv = createTabAgentServer({
        port: 0,
        dbPath: ":memory:",
        token: "after-tok",
        scratchDir: binDir,
        pigeonHoleUrl: ph.baseUrl,
        watchPigeonWs: true,
        attentionMinMs: 0,
      });
      const base = `http://127.0.0.1:${srv.port}`;

      // Wait for Pigeon-Hole WS watcher to connect & seed live cubbies
      const wsDeadline = Date.now() + 2500;
      while ((ph.wsClients.size === 0 || !srv.getRadar().pigeonOnline) && Date.now() < wsDeadline) {
        await Bun.sleep(25);
      }
      expect(srv.getRadar().pigeonOnline).toBe(true);
      expect(srv.getRadar().pigeonWorking).toBe(1);

      const { session } = await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tabId: 202,
            url: `${ph.baseUrl}/#s=nova-kernel`,
            title: "Pigeon-Hole · nova-kernel",
            repoPath: binDir,
          }),
        })
      ).json();

      // Arm /after via slash command
      await fetch(`${base}/api/sessions/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "/after check the kill bar and stage next prompt" }),
      });
      await Bun.sleep(150);

      const armed = srv.store.listArmedTriggers("nova-kernel");
      expect(armed.length).toBe(1);
      expect(armed[0].instruction).toBe("check the kill bar and stage next prompt");
      expect(srv.getRadar().armedTriggers).toBe(1);

      // Arm a second watcher via MCP pigeon_watch and cancel it
      const mcpWatch = await (
        await fetch(`${base}/api/mcp/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Tab-Agent-Token": "after-tok" },
          body: JSON.stringify({
            sessionId: session.id,
            op: "pigeon_watch",
            args: { targetSessionId: "pigeon-hole", instruction: "summarise changes" },
          }),
        })
      ).json();
      expect(mcpWatch.ok).toBe(true);
      expect(mcpWatch.data.status).toBe("armed");
      await fetch(`${base}/api/triggers/${mcpWatch.data.triggerId}/cancel`, { method: "POST" });
      expect(srv.store.getTrigger(mcpWatch.data.triggerId)?.status).toBe("cancelled");

      // Simulate Pigeon-Hole finishing nova-kernel turn over WS!
      ph.broadcastWs({
        type: "message_end",
        sessionId: "nova-kernel",
        messageId: 777,
        text: "Final verdict: BUY THE RIG — 4.2x wall-clock win over kissat.",
        time: "17:45",
      });

      // Wait for trigger to fire and fake AGY wake turn to complete
      const wakeDeadline = Date.now() + 3000;
      while (Date.now() < wakeDeadline) {
        const full = srv.store.getSessionFull(session.id)!;
        if (full.messages.some((m) => m.text.includes("Reviewed verdict — staging next step."))) break;
        await Bun.sleep(30);
      }

      const firedTrig = srv.store.getTrigger(armed[0].id)!;
      expect(firedTrig.status).toBe("fired");
      expect(firedTrig.firedSummary).toContain("BUY THE RIG");

      const full = srv.store.getSessionFull(session.id)!;
      expect(full.messages.some((m) => m.sender === "system" && m.text.includes("/after fired"))).toBe(true);
      expect(full.messages.some((m) => m.sender === "agent" && m.text.includes("Reviewed verdict"))).toBe(true);

      // Cross-Tab Radar shows unread ready count, and ack clears it
      expect(srv.getRadar().tabAttention).toBe(1);
      await fetch(`${base}/api/sessions/${session.id}/ack`, { method: "POST" });
      expect(srv.getRadar().tabAttention).toBe(0);
    } finally {
      if (prevAgy === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevAgy;
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
