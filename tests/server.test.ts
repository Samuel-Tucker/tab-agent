import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTabAgentServer, type TabAgentServerHandle } from "../daemon/server";
import { buildClaudeSpawnArgs, buildTabContextEnvelope } from "../daemon/harnesses";

let srv: TabAgentServerHandle | null = null;

afterEach(() => {
  if (srv) {
    srv.stop();
    srv = null;
  }
});

describe("Tab-Agent Daemon HTTP + WS + Inspect Gate + MCP Bridge", () => {
  test("passive sync, cross-domain nav pill, Inspect Gate enforcement, and live extension RPC", async () => {
    srv = createTabAgentServer({
      port: 0,
      dbPath: ":memory:",
      token: "test-secret-token",
      scratchDir: "/tmp/tab-agent-test-scratch",
    });
    const base = `http://127.0.0.1:${srv.port}`;

    // Connect a mock Chrome extension WebSocket
    const extWs = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?role=extension`);
    const seenOps: string[] = [];
    await new Promise<void>((resolve, reject) => {
      extWs.onopen = () => resolve();
      extWs.onerror = (e) => reject(e);
    });
    extWs.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "browser_rpc") {
        seenOps.push(msg.op);
        extWs.send(
          JSON.stringify({
            type: "browser_result",
            bid: msg.bid,
            ok: true,
            data: msg.op === "console" ? { entries: [{ level: "error", text: "Boom" }] } : { attached: msg.op === "attach" },
          })
        );
      }
    };

    // 1. Pin acme-web.example rule
    const ruleRes = await fetch(`${base}/api/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pattern: "acme-web.example",
        repoPath: "/tmp/tab-agent-test-scratch",
        repoName: "acme-web",
      }),
    });
    expect(ruleRes.status).toBe(201);

    // 2. Passive sync on new tab -> resolves pinned rule
    const sync1 = await (
      await fetch(`${base}/api/tabs/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId: 42, url: "https://acme-web.example/kits", title: "Kits" }),
      })
    ).json();
    expect(sync1.session).toBeNull();
    expect(sync1.repoMatch.source).toBe("pinned");
    expect(sync1.repoMatch.repoName).toBe("acme-web");

    // 3. Create sticky session on tab 42
    const created = await (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId: 42, url: "https://acme-web.example/kits", title: "Kits" }),
      })
    ).json();
    const sid = created.session.id;
    expect(created.session.pageAccess).toBe(false);

    // 4. Inspect Gate blocks CDP `console` while See Page is OFF (extension never called!)
    const blocked = await (
      await fetch(`${base}/api/mcp/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tab-Agent-Token": "test-secret-token" },
        body: JSON.stringify({ sessionId: sid, op: "console" }),
      })
    ).json();
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("PAGE_INSPECT_DISABLED");
    expect(seenOps.length).toBe(0);

    // Passive `info` still works with See Page OFF
    const infoRes = await (
      await fetch(`${base}/api/mcp/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tab-Agent-Token": "test-secret-token" },
        body: JSON.stringify({ sessionId: sid, op: "info" }),
      })
    ).json();
    expect(infoRes.ok).toBe(true);
    expect(infoRes.data.url).toBe("https://acme-web.example/kits");

    // 5. Toggle See Page ON -> sends `attach` to extension and unlocks `console`
    const patched = await (
      await fetch(`${base}/api/sessions/${sid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageAccess: true }),
      })
    ).json();
    expect(patched.session.pageAccess).toBe(true);
    expect(seenOps).toContain("attach");

    const consoleRes = await (
      await fetch(`${base}/api/mcp/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tab-Agent-Token": "test-secret-token" },
        body: JSON.stringify({ sessionId: sid, op: "console" }),
      })
    ).json();
    expect(consoleRes.ok).toBe(true);
    expect(consoleRes.data.entries[0].text).toBe("Boom");

    // 6. Cross-domain navigation keeps session attached and reports domainChanged
    const sync2 = await (
      await fetch(`${base}/api/tabs/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId: 42, url: "https://github.com/org/repo", title: "Repo" }),
      })
    ).json();
    expect(sync2.session.id).toBe(sid);
    expect(sync2.domainChanged.fromOrigin).toBe("https://acme-web.example");
    expect(sync2.domainChanged.toOrigin).toBe("https://github.com");

    extWs.close();
  });

  test("supports multipart paste upload, screen capture file:// localPath drop, and serves stored attachments", async () => {
    const attDir = join(tmpdir(), `tab-agent-att-test-${Date.now()}`);
    const captureFile = join(tmpdir(), `screen-capture-${Date.now()}.png`);
    // Valid 1x1 PNG bytes
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    writeFileSync(captureFile, tinyPng);

    try {
      srv = createTabAgentServer({
        port: 0,
        dbPath: ":memory:",
        token: "test-secret",
        scratchDir: "/tmp/tab-agent-test-scratch",
        attachmentsDir: attDir,
      });
      const base = `http://127.0.0.1:${srv.port}`;

      const created = await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId: 77, url: "https://acme-web.example", title: "Acme Web" }),
        })
      ).json();
      const sid = created.session.id;

      // 1. Multipart upload (clipboard paste / file drop)
      const fd = new FormData();
      fd.append("file", new File([tinyPng], "pasted-shot.png", { type: "image/png" }));
      const up1 = await (
        await fetch(`${base}/api/sessions/${sid}/attachments`, { method: "POST", body: fd })
      ).json();
      expect(up1.attachment.mimeType).toBe("image/png");
      expect(up1.attachment.url).toContain(`/api/attachments/${sid}/`);

      // Verify GET serves the stored image with CORS
      const imgResp = await fetch(`${base}${up1.attachment.url}`, {
        headers: { Origin: "chrome-extension://abcdefghijklmnop" },
      });
      expect(imgResp.status).toBe(200);
      expect(imgResp.headers.get("content-type")).toBe("image/png");
      expect(imgResp.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnop");

      // 2. Screen capture drag-drop via file:// URI localPath
      const up2 = await (
        await fetch(`${base}/api/sessions/${sid}/attachments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ localPath: `file://${captureFile}` }),
        })
      ).json();
      expect(up2.attachment.mimeType).toBe("image/png");
      expect(up2.attachment.name).toContain("screen-capture-");

      // 3. Reject non-image localPath cleanly
      const bad = await fetch(`${base}/api/sessions/${sid}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath: "/etc/hosts" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      rmSync(attDir, { recursive: true, force: true });
      rmSync(captureFile, { force: true });
    }
  });

  test("move endpoint hands a chat to another tab, and resolve-file turns agent .html paths into file URLs", async () => {
    const repoDir = join(tmpdir(), `tab-agent-move-${Date.now()}`);
    mkdirSync(join(repoDir, "docs"), { recursive: true });
    writeFileSync(join(repoDir, "docs", "Chat Switcher.html"), "<!doctype html><title>x</title>");
    try {
      srv = createTabAgentServer({ port: 0, dbPath: ":memory:", token: "t", scratchDir: "/tmp/tab-agent-test-scratch" });
      const base = `http://127.0.0.1:${srv.port}`;
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      const panel = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?role=panel`);
      const seen: any[] = [];
      await new Promise<void>((r) => (panel.onopen = () => r()));
      panel.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));

      const a = (await (await post("/api/sessions", { tabId: 10, url: "https://a.test/", title: "A", repoPath: repoDir })).json()).session;
      const b = (await (await post("/api/sessions", { tabId: 20, url: "https://b.test/", title: "B" })).json()).session;

      // Agent mentioned a repo-relative path with a space in it
      const resolved = await (
        await fetch(`${base}/api/sessions/${a.id}/resolve-file?path=${encodeURIComponent("docs/Chat Switcher.html")}`)
      ).json();
      expect(resolved.exists).toBe(true);
      expect(resolved.fileUrl).toBe(`file://${join(repoDir, "docs", "Chat%20Switcher.html")}`);
      const missing = await (await fetch(`${base}/api/sessions/${a.id}/resolve-file?path=nope.html`)).json();
      expect(missing.exists).toBe(false);
      expect((await fetch(`${base}/api/sessions/${a.id}/resolve-file?path=/etc/hosts`)).status).toBe(400);

      // Open the .html in new tab 30: chat A follows it, tab 10 is freed
      const moved = await (await post(`/api/sessions/${a.id}/move`, { tabId: 30, url: resolved.fileUrl, reason: "opened html" })).json();
      expect(moved.fromTabIds).toEqual([10]);
      expect(moved.session.tabId).toBe(30);
      expect(moved.session.lastUrl).toBe(resolved.fileUrl);
      const sync10 = await (await post("/api/tabs/sync", { tabId: 10, url: "https://a.test/", title: "A" })).json();
      expect(sync10.session).toBeNull();

      // Chat A navigates on with tab 30 (sticky), then is moved onto tab 20, displacing B
      const sync30 = await (await post("/api/tabs/sync", { tabId: 30, url: "https://next.test/page", title: "Next" })).json();
      expect(sync30.session.id).toBe(a.id);
      const moved2 = await (await post(`/api/sessions/${a.id}/move`, { tabId: 20 })).json();
      expect(moved2.displacedSessionId).toBe(b.id);
      const sync20 = await (await post("/api/tabs/sync", { tabId: 20, url: "https://b.test/", title: "B" })).json();
      expect(sync20.session.id).toBe(a.id);

      await Bun.sleep(50);
      const movedEvents = seen.filter((m) => m.type === "session_moved");
      expect(movedEvents.map((m) => m.toTabId)).toEqual([30, 20]);
      expect(movedEvents[0].fromTabIds).toEqual([10]);
      panel.close();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("close takes a chat off its tab and keeps it; idle See Page switches itself off; stuck turns are stopped", async () => {
    const binDir = join(tmpdir(), `tab-agent-fakebin-${Date.now()}`);
    mkdirSync(binDir, { recursive: true });
    // Fake agy: says hello, then goes silent for 30 s (a stuck turn)
    const fakeAgy = join(binDir, "agy");
    writeFileSync(
      fakeAgy,
      `#!/bin/sh\necho '{"event":"init","conversation_id":"conv-stuck"}'\necho '{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"Working on it"}}'\nexec sleep 30\n`,
      { mode: 0o755 }
    );
    const prevAgy = process.env.AGY_BIN;
    process.env.AGY_BIN = fakeAgy;
    try {
      srv = createTabAgentServer({
        port: 0,
        dbPath: ":memory:",
        token: "t",
        scratchDir: "/tmp/tab-agent-test-scratch",
        stallMs: 400,
        seePageIdleMs: 150,
      });
      const base = `http://127.0.0.1:${srv.port}`;
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      const a = (await (await post("/api/sessions", { tabId: 5, url: "https://a.test/", title: "A" })).json()).session;

      // Stuck turn: stopped by the watchdog, partial text kept, chat waits for you
      await post(`/api/sessions/${a.id}/prompt`, { text: "do a thing" });
      await Bun.sleep(100);
      expect(srv.runner.isRunning(a.id)).toBe(true);
      const t0 = Date.now();
      while (srv.runner.isRunning(a.id) && Date.now() - t0 < 5000) await Bun.sleep(50);
      expect(srv.runner.isRunning(a.id)).toBe(false);
      const afterStall = srv.store.getSessionFull(a.id)!;
      const last = afterStall.messages[afterStall.messages.length - 1];
      expect(last.text).toContain("Working on it");
      expect(last.text).toContain("no output from the CLI");
      expect(afterStall.state).toBe("needs-you");
      expect(afterStall.events.some((e) => e.kind === "stall")).toBe(true);

      // See Page left on with nothing happening is switched off by the sweep
      srv.store.setPageAccess(a.id, true);
      await Bun.sleep(200);
      await srv.sweepSeePage(); // the background sweep may already have done it
      expect(srv.store.getSession(a.id)!.pageAccess).toBe(false);
      expect(srv.store.getSessionFull(a.id)!.events.some((e) => e.summary.startsWith("See Page switched off after"))).toBe(true);

      // Close: off the tab, archived, history kept, can come back
      const closed = await (await post(`/api/sessions/${a.id}/close`, {})).json();
      expect(closed.tabIds).toEqual([5]);
      expect(srv.store.getTabBinding(5)).toBeNull();
      expect(srv.store.getSession(a.id)!.archived).toBe(true);
      expect(srv.store.getSessionFull(a.id)!.messages.length).toBeGreaterThan(1);
      const sync = await (await post("/api/tabs/sync", { tabId: 5, url: "https://a.test/", title: "A" })).json();
      expect(sync.session).toBeNull();
      expect(sync.recoverable?.id).toBe(a.id);
      const back = await (await post(`/api/sessions/${a.id}/move`, { tabId: 5 })).json();
      expect(back.session.tabId).toBe(5);
    } finally {
      if (prevAgy === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevAgy;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("streams live runStatus (tool step + heartbeat) mid-turn and flags silent zero-output CLI exit as error", async () => {
    const binDir = join(tmpdir(), `ta-live-${Date.now()}`);
    mkdirSync(binDir, { recursive: true });
    const fakeAgy = join(binDir, "agy");
    writeFileSync(
      fakeAgy,
      [
        "#!/bin/sh",
        'printf \'{"event":"init","conversation_id":"conv-live-1"}\\n\'',
        'printf \'{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"scp track28"}}}}\\n\'',
        "sleep 0.35",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 }
    );
    const prevAgy = process.env.AGY_BIN;
    process.env.AGY_BIN = fakeAgy;
    try {
      srv = createTabAgentServer({ port: 0, dbPath: ":memory:", token: "t-live", scratchDir: binDir });
      const base = `http://127.0.0.1:${srv.port}`;
      const seenRunStatuses: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?role=panel`);
      await new Promise<void>((r) => { ws.onopen = () => r(); });
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === "run_status" && m.runStatus) seenRunStatuses.push(m.runStatus);
      };

      const { session } = await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId: 8, url: "https://live.test/", title: "Live", repoPath: binDir }),
        })
      ).json();

      await fetch(`${base}/api/sessions/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Run long tool" }),
      });

      // Wait for tool step to land while the turn is still running
      const deadline = Date.now() + 2000;
      let midStatus: any = null;
      while (Date.now() < deadline) {
        const cur = await (await fetch(`${base}/api/sessions/${session.id}`)).json();
        if (cur.session?.runStatus?.phase === "tool") {
          midStatus = cur.session.runStatus;
          break;
        }
        await Bun.sleep(30);
      }
      expect(midStatus).not.toBeNull();
      expect(midStatus.currentStep).toContain("run_command: scp track28");
      expect(midStatus.stepCount).toBe(1);
      expect(typeof midStatus.startedAt).toBe("number");
      expect(typeof midStatus.lastActivityAt).toBe("number");

      // Wait for silent exit (exit 0, no result event, no text)
      const endDeadline = Date.now() + 2500;
      while (srv.runner.isRunning(session.id) && Date.now() < endDeadline) await Bun.sleep(30);
      await Bun.sleep(40);
      ws.close();

      expect(seenRunStatuses.some((rs) => rs.phase === "tool")).toBe(true);
      const after = srv.store.getSessionFull(session.id)!;
      const lastAgent = after.messages.filter((m) => m.sender === "agent").at(-1);
      expect(lastAgent?.text).toContain("Harness error: CLI exited silently without a response");
    } finally {
      if (prevAgy === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevAgy;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("sidebar shell runner executes commands in repo cwd, streams WS output, handles errors and kill", async () => {
    const workDir = join(tmpdir(), `ta-shell-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      srv = createTabAgentServer({ port: 0, dbPath: ":memory:", token: "t-sh", scratchDir: workDir, watchPigeonWs: false });
      const base = `http://127.0.0.1:${srv.port}`;
      const wsEvents: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?role=panel`);
      await new Promise<void>((r) => { ws.onopen = () => r(); });
      ws.onmessage = (ev) => wsEvents.push(JSON.parse(String(ev.data)));

      const { session } = await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId: 9, url: "https://sh.test/", title: "Sh", repoPath: workDir }),
        })
      ).json();

      // 1. Success run in linked workspace
      const r1 = await (
        await fetch(`${base}/api/sessions/${session.id}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "echo hello-sidebar && pwd", messageId: 1, blockIdx: 0 }),
        })
      ).json();
      expect(r1.ok).toBe(true);

      const d1 = Date.now() + 3000;
      while (srv.shell.getRun(r1.run.id)?.status === "running" && Date.now() < d1) await Bun.sleep(25);
      const done1 = srv.shell.getRun(r1.run.id)!;
      expect(done1.status).toBe("done");
      expect(done1.exitCode).toBe(0);
      expect(done1.output).toContain("hello-sidebar");
      expect(done1.output).toContain(workDir);
      expect(wsEvents.some((e) => e.type === "shell_end" && e.run?.id === r1.run.id)).toBe(true);

      // 2. Non-zero exit
      const r2 = await (
        await fetch(`${base}/api/sessions/${session.id}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "echo oops >&2; exit 7" }),
        })
      ).json();
      const d2 = Date.now() + 3000;
      while (srv.shell.getRun(r2.run.id)?.status === "running" && Date.now() < d2) await Bun.sleep(25);
      const done2 = srv.shell.getRun(r2.run.id)!;
      expect(done2.status).toBe("error");
      expect(done2.exitCode).toBe(7);
      expect(done2.output).toContain("oops");

      // 3. Kill a long-running command
      const r3 = await (
        await fetch(`${base}/api/sessions/${session.id}/shell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "sleep 30" }),
        })
      ).json();
      await Bun.sleep(60);
      const kRes = await (await fetch(`${base}/api/shell/${r3.run.id}/kill`, { method: "POST" })).json();
      expect(kRes.stopped).toBe(true);
      const d3 = Date.now() + 3000;
      while (srv.shell.getRun(r3.run.id)?.status === "running" && Date.now() < d3) await Bun.sleep(25);
      expect(srv.shell.getRun(r3.run.id)?.status).toBe("killed");
      ws.close();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("buildClaudeSpawnArgs grants attachments dir + Read/MCP tools and pinned notes format cleanly", async () => {
    const args = buildClaudeSpawnArgs({
      bin: "/usr/local/bin/claude",
      prompt: "inspect screenshot",
      model: "opus",
      effort: "high",
      mcpConfigPath: "/tmp/mcp.json",
      providerSessionId: "sess-123",
      addDirs: ["/tmp/ta-att", "/tmp/ta-att/tab-1", "/tmp/ta-att"],
    });
    const addIdx = args.indexOf("--add-dir");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(addIdx).toBeGreaterThan(0);
    expect(args[addIdx + 1]).toBe("/tmp/ta-att");
    expect(args[addIdx + 2]).toBe("/tmp/ta-att/tab-1");
    expect(args[addIdx + 3]).toBe("--allowedTools");
    expect(args[addIdx + 4]).toBe("Read,mcp__tab-agent__*");
    // Prompt flag must stay at the end so variadic flags never swallow it
    expect(args[args.length - 2]).toBe("-p");
    expect(args[args.length - 1]).toBe("inspect screenshot");

    const envText = buildTabContextEnvelope(
      {
        id: "tab-pin-1",
        name: "Pin Test",
        repoPath: "/tmp/repo",
        repoName: "Repo",
        repoSource: "manual",
        initialUrl: "http://127.0.0.1:7742/",
        lastUrl: "http://127.0.0.1:7742/",
        origin: "http://127.0.0.1:7742",
        pageTitle: "Pigeon-Hole",
        state: "idle",
        family: "CLAUDE",
        model: "OPUS",
        effort: "high",
        harnessId: "claude-opus",
        providerSessionId: null,
        pageAccess: false,
        pigeonRelayMode: "ask",
        questionSnippet: "",
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      "",
      [
        {
          pinIndex: 1,
          selector: "#queued-tray",
          tag: "div",
          label: "div#queued-tray",
          rect: { x: 10, y: 20, width: 320, height: 80 },
          note: "separate this box and make collapsible",
          attachmentName: "pin-1-div-queued-tray.png",
        },
      ],
      {
        attachments: [
          {
            id: "a1",
            name: "pin-1-div-queued-tray.png",
            mimeType: "image/png",
            size: 1234,
            path: "/tmp/ta-att/tab-pin-1/pin-1-div-queued-tray.png",
            url: "/api/attachments/tab-pin-1/pin-1-div-queued-tray.png",
          },
        ],
      }
    );
    expect(envText).toContain("- Pinned Page Notes");
    expect(envText).toContain("Pin #1: div#queued-tray");
    expect(envText).toContain("separate this box and make collapsible");
    expect(envText).toContain("[crop: pin-1-div-queued-tray.png]");
    expect(envText).toContain("Please address the pinned page note(s) above.");

    // Daemon /prompt accepts a pin-note-only request (empty textarea, no extra text)
    const pinTmp = join(tmpdir(), `ta-pin-only-${Date.now()}`);
    mkdirSync(pinTmp, { recursive: true });
    const pinFake = join(pinTmp, "pin-agy.sh");
    writeFileSync(pinFake, '#!/bin/sh\necho \'{"event":"result","result":{"response":"Noted"}}\'\nexit 0\n', { mode: 0o755 });
    const prevPinAgy = process.env.AGY_BIN;
    process.env.AGY_BIN = pinFake;
    try {
      srv = createTabAgentServer({ port: 0, dbPath: ":memory:", token: "t-pin", scratchDir: pinTmp, watchPigeonWs: false });
      const base = `http://127.0.0.1:${srv.port}`;
      const { session } = await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId: 42, url: "http://127.0.0.1:7742/", title: "Pin", repoPath: pinTmp }),
        })
      ).json();
      const res = await fetch(`${base}/api/sessions/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "",
          chips: [{ pinIndex: 1, selector: "#box", tag: "div", label: "div#box", note: "tighten padding" }],
          attachments: [],
        }),
      });
      expect(res.status).toBe(202);
      const d = Date.now() + 2000;
      while (srv.runner.isRunning(session.id) && Date.now() < d) await Bun.sleep(20);
      await Bun.sleep(30);
    } finally {
      if (prevPinAgy === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevPinAgy;
      rmSync(pinTmp, { recursive: true, force: true });
    }
  });

  test("background Tab-Agent sessions notify Radar as Needs you / Ready even on fast turns and survive restart", async () => {
    const tmp = join(tmpdir(), `ta-radar-tabs-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const dbPath = join(tmp, "radar.sqlite");
    const fakeAgy = join(tmp, "fake-agy.sh");
    writeFileSync(
      fakeAgy,
      `#!/bin/sh
echo '{"event":"init","conversation_id":"conv-fast"}'
case "$*" in
  *ASK_QUESTION*)
    echo '{"event":"result","result":{"conversation_id":"conv-fast","response":"Done checking logs — which option do you want?"}}'
    ;;
  *)
    echo '{"event":"result","result":{"conversation_id":"conv-fast","response":"Build finished cleanly."}}'
    ;;
esac
exit 0
`,
      { mode: 0o755 }
    );
    const prevAgy = process.env.AGY_BIN;
    process.env.AGY_BIN = fakeAgy;
    try {
      srv = createTabAgentServer({ port: 0, dbPath, token: "t-r", scratchDir: tmp, watchPigeonWs: false });
      const base = `http://127.0.0.1:${srv.port}`;

      const sA = (
        await (
          await fetch(`${base}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tabId: 101, url: "https://a.test/", title: "Tab A", name: "Tab A", repoPath: tmp }),
          })
        ).json()
      ).session;
      const sB = (
        await (
          await fetch(`${base}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tabId: 102, url: "https://b.test/", title: "Tab B", name: "Tab B", repoPath: tmp }),
          })
        ).json()
      ).session;
      const sC = (
        await (
          await fetch(`${base}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tabId: 103, url: "https://c.test/", title: "Tab C", name: "Tab C", repoPath: tmp }),
          })
        ).json()
      ).session;

      // User is currently looking at Tab B
      await fetch(`${base}/api/tabs/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId: 102, url: "https://b.test/", title: "Tab B", active: true }),
      });

      // Fast (<1s) background turn on Tab A asks a question -> Needs you
      await fetch(`${base}/api/sessions/${sA.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "ASK_QUESTION" }),
      });
      // Fast (<1s) background turn on Tab C completes cleanly -> Ready (done)
      await fetch(`${base}/api/sessions/${sC.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "RUN_BUILD" }),
      });

      const deadline = Date.now() + 3000;
      while ((srv.runner.isRunning(sA.id) || srv.runner.isRunning(sC.id)) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      await Bun.sleep(50);

      const radar = srv.getRadar();
      expect(radar.tabAttention).toBe(2);
      const itemA = radar.items.find((i) => i.kind === "tab" && i.id === sA.id);
      const itemC = radar.items.find((i) => i.kind === "tab" && i.id === sC.id);
      expect(itemA?.state).toBe("needs-you");
      expect(itemC?.state).toBe("done");

      // Visiting Tab A clears only Tab A
      await fetch(`${base}/api/tabs/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId: 101, url: "https://a.test/", title: "Tab A", active: true }),
      });
      expect(srv.getRadar().tabAttention).toBe(1);
      expect(srv.getRadar().items.some((i) => i.id === sA.id)).toBe(false);
      expect(srv.getRadar().items.some((i) => i.id === sC.id && i.state === "done")).toBe(true);

      // Restart daemon against same SQLite DB -> Tab C's unread Ready state survives!
      srv.stop();
      srv = createTabAgentServer({ port: 0, dbPath, token: "t-r2", scratchDir: tmp, watchPigeonWs: false });
      expect(srv.getRadar().tabAttention).toBe(1);
      expect(srv.getRadar().items.some((i) => i.id === sC.id && i.state === "done")).toBe(true);
    } finally {
      if (prevAgy === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevAgy;
      if (srv) {
        srv.stop();
        srv = null;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("peer-to-peer talk finds sessions by repo name via tab-peer CLI & MCP and enforces hop limit", async () => {
    const tmp = join(tmpdir(), `ta-peer-${Date.now()}`);
    const repoA = join(tmp, "Tab-Agent-Caller");
    const repoB = join(tmp, "demo-api");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const fakeAgy = join(tmp, "peer-agy.sh");
    writeFileSync(
      fakeAgy,
      `#!/bin/sh
echo '{"event":"init","conversation_id":"conv-peer-b"}'
echo '{"event":"result","result":{"conversation_id":"conv-peer-b","response":"API quota is 42% used and healthy."}}'
exit 0
`,
      { mode: 0o755 }
    );
    const prevAgy = process.env.AGY_BIN;
    process.env.AGY_BIN = fakeAgy;
    try {
      srv = createTabAgentServer({ port: 0, dbPath: ":memory:", token: "tok-peer", scratchDir: tmp, watchPigeonWs: false });
      const base = `http://127.0.0.1:${srv.port}`;

      const sA = (
        await (
          await fetch(`${base}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tabId: 201, url: "https://a.test/", title: "Caller", name: "Caller Chat", repoPath: repoA }),
          })
        ).json()
      ).session;
      const sB = (
        await (
          await fetch(`${base}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tabId: 202, url: "https://api.example.com/", title: "Grok", name: "Grok Usage", repoPath: repoB }),
          })
        ).json()
      ).session;

      const peerEnv = {
        ...process.env,
        TAB_AGENT_PORT: String(srv.port),
        TAB_AGENT_TOKEN: "tok-peer",
        TAB_AGENT_SESSION: sA.id,
      };
      const tabPeerBin = join(import.meta.dir, "..", "bin", "tab-peer");

      const runPeerCli = async (args: string[]) => {
        const p = Bun.spawn([tabPeerBin, ...args], { env: peerEnv, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        return { exitCode, stdout, stderr };
      };

      // 1. tab-peer list finds demo-api by repo name
      const ls = await runPeerCli(["list", "demo-api"]);
      expect(ls.exitCode).toBe(0);
      expect(ls.stdout).toContain("demo-api");

      // 2. tab-peer send asks demo-api and returns its live reply
      const sent = await runPeerCli(["send", "demo-api", "How is API quota looking?"]);
      expect(sent.exitCode).toBe(0);
      expect(sent.stdout).toContain("API quota is 42% used and healthy.");

      // 3. tab-peer read sees the conversation in demo-api
      const rd = await runPeerCli(["read", "demo-api"]);
      expect(rd.exitCode).toBe(0);
      expect(rd.stdout).toContain("API quota is 42% used");

      // 4. Loop depth guard blocks depth >= 3
      const loopResp = await fetch(`${base}/api/peers/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSessionId: sA.id, target: "demo-api", message: "ping", depth: 3 }),
      });
      expect(loopResp.status).toBe(400);
      expect((await loopResp.json()).error).toContain("hop limit");

      // 5. Claude MCP peer_list works via /api/mcp/call
      const mcpRes = await (
        await fetch(`${base}/api/mcp/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Tab-Agent-Token": "tok-peer" },
          body: JSON.stringify({ sessionId: sA.id, op: "peer_list", args: { query: "grok" } }),
        })
      ).json();
      expect(mcpRes.ok).toBe(true);
      expect(mcpRes.data.peers[0].id).toBe(sB.id);
    } finally {
      if (prevAgy === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevAgy;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("/council fans out across Gemini + Claude + Codex + Kimi, writes HTML dossier, and stages Pigeon-Hole Relay Card", async () => {
    const tmp = join(tmpdir(), `ta-council-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const fAgy = join(tmp, "c-agy.sh");
    const fClaude = join(tmp, "c-claude.sh");
    const fCodex = join(tmp, "c-codex.sh");
    const fKimi = join(tmp, "c-kimi.sh");

    writeFileSync(
      fAgy,
      `#!/bin/sh\nprintf '%s\\n' '{"event":"result","result":{"response":"1. **Verdict:** Pivot to track 29.\\n2. **Blind spot / risk:** Watch memory bandwidth.\\n3. **Next concrete step:** Run a 5-minute SRAM roofline microbenchmark before coding."}}'\nexit 0\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      fClaude,
      `#!/bin/sh\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"1. **Verdict:** Kill track 28 and test track 29.\\n2. **Blind spot / risk:** Baseline numbers must stay sealed.\\n3. **Next concrete step:** Lock kill bar at 3x speedup on real workload."}'\nexit 0\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      fCodex,
      `#!/bin/sh\nOUT=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then OUT="$2"; shift 2; else shift; fi; done\nTXT="1. **Verdict:** Agreed, pivot cleanly.\\n2. **Blind spot / risk:** Check host PCIe overhead.\\n3. **Next concrete step:** Profile host-to-card transfer first."\nif [ -n "$OUT" ]; then printf "%b" "$TXT" > "$OUT"; else printf "%b" "$TXT"; fi\nexit 0\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      fKimi,
      `#!/bin/sh\necho "1. **Verdict:** Pivot after one ablation.\\n2. **Blind spot / risk:** Overfitting small kernel.\\n3. **Next concrete step:** Measure end-to-end tok/s on 2048 context."\nexit 0\n`,
      { mode: 0o755 }
    );

    const mockPh = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/bootstrap") {
          return Response.json({
            sessions: [
              {
                id: "nova-kernel",
                name: "nova-kernel",
                state: "working",
                family: "AGY",
                model: "NEON",
                effort: "xhigh",
                path: tmp,
                displayPath: "~/Projects/nova-kernel",
                queuedCount: 0,
                messages: [{ sender: "agent", time: "21:50", text: "Track 28 hit 1.8x vs 3.0x target." }],
              },
            ],
          });
        }
        return Response.json({ ok: true });
      },
    });

    const prev = {
      AGY_BIN: process.env.AGY_BIN,
      CLAUDE_BIN: process.env.CLAUDE_BIN,
      CODEX_BIN: process.env.CODEX_BIN,
      KIMI_BIN: process.env.KIMI_BIN,
    };
    process.env.AGY_BIN = fAgy;
    process.env.CLAUDE_BIN = fClaude;
    process.env.CODEX_BIN = fCodex;
    process.env.KIMI_BIN = fKimi;
    try {
      srv = createTabAgentServer({
        port: 0,
        dbPath: ":memory:",
        token: "tok-c",
        scratchDir: tmp,
        pigeonHoleUrl: `http://127.0.0.1:${mockPh.port}`,
        watchPigeonWs: false,
      });
      const base = `http://127.0.0.1:${srv.port}`;
      const { session } = await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tabId: 301,
            url: `http://127.0.0.1:${mockPh.port}/#s=nova-kernel`,
            title: "Pigeon-Hole",
            name: "Council Test",
            repoPath: tmp,
          }),
        })
      ).json();

      await fetch(`${base}/api/sessions/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "/council Should we pivot from track 28 to track 29?" }),
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const cur = srv.store.getSessionFull(session.id)!;
        const ag = cur.messages.filter((m) => m.sender === "agent").at(-1);
        if (!srv.runner.isRunning(session.id) && ag?.text) break;
        await Bun.sleep(25);
      }

      const full = srv.store.getSessionFull(session.id)!;
      const lastAgent = full.messages.filter((m) => m.sender === "agent").at(-1)!;
      expect(lastAgent.text).toContain("Council Verdicts (4/4)");
      expect(lastAgent.text).toContain("Gemini 4 · Carbon");
      expect(lastAgent.text).toContain("Claude · Opus");
      expect(lastAgent.text).toContain("Codex · GPT-6.2 Sol");
      expect(lastAgent.text).toContain("Kimi · K3.1 Pro");
      const mFile = lastAgent.text.match(/file:\/\/([^\s`]+\.html)/);
      expect(mFile).not.toBeNull();
      const dossierHtml = await Bun.file(mFile![1]).text();
      expect(dossierHtml).toContain("Tab-Agent Frontier Council");
      expect(dossierHtml).toContain("Pivot to track 29");
      expect(dossierHtml).toContain("Kill track 28");
      expect(dossierHtml).not.toContain('{"event":"result"');
      expect(dossierHtml).not.toContain('{"type":"result"');
      // Auto-staged Pigeon-Hole Relay Card
      expect(full.relays.length).toBeGreaterThanOrEqual(1);
      expect(full.relays[0].status).toBe("staged");
      expect(full.relays[0].targetSessionId).toBe("nova-kernel");
      rmSync(mFile![1], { force: true });
    } finally {
      mockPh.stop(true);
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
