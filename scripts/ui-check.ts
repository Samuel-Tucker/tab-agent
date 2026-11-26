// End-to-end check of the sidebar in real Chromium: switcher, search, rename, move here, send to,
// attach a closed chat, and a chat following an opened .html.
// Isolated: test daemon on :7762 with an in-memory DB and a temp copy of the extension pointed at it, so the live
// daemon on :7752 and its data are never touched. Headless Chrome for Testing; screenshots go to $UI_OUT or a temp dir.
//   bun scripts/ui-check.ts        (needs: bun add -d playwright; CHROME=<path> if not the default below)
import { chromium } from "playwright";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createTabAgentServer } from "../daemon/server";

const EXT = mkdtempSync(join(tmpdir(), "ta-ui-ext-"));
cpSync(join(import.meta.dir, "..", "extension"), EXT, { recursive: true });
for (const f of readdirSync(EXT).filter((n) => n.endsWith(".js") || n === "manifest.json")) {
  writeFileSync(join(EXT, f), readFileSync(join(EXT, f), "utf8").replaceAll("7752", "7762"));
}
const OUT = process.env.UI_OUT || mkdtempSync(join(tmpdir(), "ta-ui-shots-"));
const CHROME =
  process.env.CHROME ||
  join(homedir(), "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

const results: string[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

const repoDir = mkdtempSync(join(tmpdir(), "ta-ui-"));
const weld = join(repoDir, "acme-web");
const site = join(repoDir, "acme-web-site");
const nova = join(repoDir, "nova-kernel");
mkdirSync(weld);
mkdirSync(site);
mkdirSync(nova);

// Lightweight mock Pigeon-Hole server on :7764 for real-Chromium Relay UI checks
let mockQid = 10;
const mockPhQueue: Array<{ id: number; text: string }> = [];
const mockPigeon = Bun.serve({
  port: 7764,
  hostname: "127.0.0.1",
  async fetch(req, s) {
    const u = new URL(req.url);
    if (u.pathname === "/ws") {
      if (s.upgrade(req)) return undefined;
      return new Response("ws upgrade failed", { status: 400 });
    }
    if (u.pathname === "/api/bootstrap" && req.method === "GET") {
      return Response.json({
        sessions: [
          {
            id: "nova-kernel",
            name: "nova-kernel",
            shelf: "Hardware",
            path: nova,
            displayPath: "~/Projects/nova-kernel",
            state: "working",
            family: "AGY",
            model: "NEON",
            effort: "xhigh",
            queuedCount: mockPhQueue.length,
            steerState: null,
            messages: [{ id: 1, sender: "agent", time: "16:39", text: "Running track28 benchmark." }],
          },
        ],
      });
    }
    if (u.pathname === "/api/sessions/nova-kernel/messages" && req.method === "POST") {
      const b = await req.json();
      if (b.mode === "queue" || b.mode === "auto") {
        const item = { id: ++mockQid, text: b.text };
        mockPhQueue.push(item);
        return Response.json({ ok: true, queued: true, deduplicated: false, queuedItem: item, queuedMessages: mockPhQueue });
      }
      return Response.json({ ok: true, message: { id: 500, sender: "human", text: b.text } });
    }
    const delM = u.pathname.match(/^\/api\/sessions\/nova-kernel\/queue\/(\d+)$/);
    if (delM && req.method === "DELETE") {
      const idx = mockPhQueue.findIndex((q) => q.id === Number(delM[1]));
      if (idx === -1) return Response.json({ error: "Queued message not found" }, { status: 404 });
      mockPhQueue.splice(idx, 1);
      return Response.json({ ok: true, queuedMessages: mockPhQueue });
    }
    return new Response(`<!doctype html><title>Pigeon-Hole · nova-kernel</title><h1>Pigeon-Hole</h1>`, {
      headers: { "content-type": "text/html" },
    });
  },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ type: "connected", ts: Date.now() })); },
    message() {},
  },
});

const srv = createTabAgentServer({
  port: 7762,
  dbPath: ":memory:",
  token: "t",
  scratchDir: repoDir,
  pigeonHoleUrl: "http://127.0.0.1:7764",
});
const pages = Bun.serve({
  port: 7763,
  hostname: "127.0.0.1",
  fetch(req) {
    const p = new URL(req.url).pathname;
    return new Response(`<!doctype html><title>${p}</title><h1>${p}</h1>`, { headers: { "content-type": "text/html" } });
  },
});

const userDir = mkdtempSync(join(tmpdir(), "ta-ui-profile-"));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: CHROME,
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 400, height: 800 },
});

try {
  let [swk] = ctx.serviceWorkers();
  if (!swk) swk = await ctx.waitForEvent("serviceworker");
  const extId = new URL(swk.url()).host;

  const pa = ctx.pages()[0] || (await ctx.newPage());
  await pa.goto("http://127.0.0.1:7763/kits/g5-01");
  const pb = await ctx.newPage();
  await pb.goto("http://127.0.0.1:7763/astro/kits");
  const pc = await ctx.newPage();
  await pc.goto("http://127.0.0.1:7763/margin-sheet");

  const tabs: any[] = await swk.evaluate(() => chrome.tabs.query({}));
  const tabOf = (path: string) => tabs.find((t) => (t.url || "").includes(path));
  const tA = tabOf("/kits/g5-01"), tB = tabOf("/astro/kits"), tC = tabOf("/margin-sheet");
  const W1 = tA.windowId;

  const api = async (path: string, body?: unknown, method = body ? "POST" : "GET") =>
    (await fetch(`http://127.0.0.1:7762${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })).json();

  const sA = (await api("/api/sessions", { tabId: tA.id, windowId: W1, url: tA.url, title: "A", name: "Kit cards spacing fix", repoPath: weld })).session;
  const sB = (await api("/api/sessions", { tabId: tB.id, windowId: W1, url: tB.url, title: "B", name: "Astro build error on /kits", repoPath: site })).session;
  const sC = (await api("/api/sessions", { url: "https://www.pricing.example.com/en-gb/auction-catalogues/fees", title: "BS", name: "Pricing fee table", repoPath: weld })).session;
  srv.store.insertMessage({ sessionId: sA.id, sender: "agent", text: "Mock-up is at http://127.0.0.1:7763/report.html — have a look." });
  srv.store.insertMessage({ sessionId: sA.id, sender: "agent", text: "Connect with:\n```\nssh prod-box\n```\nThen run `claude auth login`." });
  srv.store.insertMessage({
    sessionId: sA.id,
    sender: "agent",
    text: Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: a long stretch of prose to read while the chat keeps updating underneath.`).join("\n\n"),
  });
  srv.store.insertMessage({
    sessionId: sA.id,
    sender: "agent",
    text: "Paste this:\n```\nPAUSE synthetic benchmarks and self-made puzzles before you spend anything on a multi-card host; pick one real external benchmark first and lock the pass and kill bars before writing code.\n```",
  });
  srv.store.insertMessage({ sessionId: sB.id, sender: "agent", text: "sharp import missing" });
  srv.store.insertMessage({ sessionId: sC.id, sender: "agent", text: "fees updated" });

  // The panel thinks it lives in window W1 (in a real side panel it does).
  await ctx.addInitScript((w) => {
    if (location.protocol === "chrome-extension:") {
      // @ts-ignore
      chrome.windows.getCurrent = async () => ({ id: w });
    }
  }, W1);
  await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tA.id);
  const panelP = ctx.waitForEvent("page");
  await swk.evaluate((url) => chrome.windows.create({ url }), `chrome-extension://${extId}/sidepanel.html`);
  const panel = await panelP;
  await panel.setViewportSize({ width: 380, height: 760 });
  await panel.waitForLoadState("domcontentloaded");
  await panel.waitForTimeout(250);
  // Nudge tab activation in W1 after the panel is listening so startup never races
  await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tB.id);
  await panel.waitForTimeout(120);
  await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tA.id);
  await panel.waitForFunction(() => document.getElementById("chat-title-text")?.textContent === "Kit cards spacing fix", null, { timeout: 8000 });
  check("panel shows the chat bound to the active tab", true);

  // Reading place is kept when the chat re-renders (session_updated), and the bottom is followed only when you're at it
  const scrollInfo = () =>
    panel.evaluate(() => {
      const sc = document.getElementById("chat-scroll")!;
      return { top: sc.scrollTop, gap: sc.scrollHeight - sc.scrollTop - sc.clientHeight };
    });
  check("long chat opens at the bottom", (await scrollInfo()).gap < 4);
  await panel.evaluate(() => (document.getElementById("chat-scroll")!.scrollTop = 300));
  await api(`/api/sessions/${sA.id}`, { name: "Kit cards spacing fix" }, "PATCH");
  await panel.waitForTimeout(300);
  const kept = await scrollInfo();
  check("reading place kept when the chat updates", Math.abs(kept.top - 300) < 2, `scrollTop ${Math.round(kept.top)}`);
  await panel.evaluate(() => {
    const sc = document.getElementById("chat-scroll")!;
    sc.scrollTop = sc.scrollHeight;
  });
  srv.store.insertMessage({ sessionId: sA.id, sender: "agent", text: "New reply line one.\n\nLine two.\n\nLine three." });
  await api(`/api/sessions/${sA.id}`, { name: "Kit cards spacing fix" }, "PATCH");
  await panel.waitForTimeout(300);
  check("…and follows new text when at the bottom", (await scrollInfo()).gap < 4, `gap ${Math.round((await scrollInfo()).gap)}px`);

  // Prompt box grows with long text, capped at ~55% of the panel, then scrolls
  const ta = panel.locator("#prompt-input");
  const h0 = await ta.evaluate((n: HTMLElement) => n.getBoundingClientRect().height);
  await ta.fill(Array.from({ length: 14 }, (_, i) => `line ${i + 1} of a long prompt about the overnight sprint`).join("\n"));
  const h1 = await ta.evaluate((n: HTMLElement) => n.getBoundingClientRect().height);
  await ta.fill(Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"));
  const h2 = await ta.evaluate((n: HTMLElement) => n.getBoundingClientRect().height);
  await panel.screenshot({ path: join(OUT, "ui-long-prompt.png") });
  await ta.fill("");
  const h3 = await ta.evaluate((n: HTMLElement) => n.getBoundingClientRect().height);
  check("prompt box grows with long text", h1 > h0 + 100, `${Math.round(h0)} → ${Math.round(h1)}px`);
  check("…stops at about half the panel", h2 <= 760 * 0.56 && h2 > h1, `${Math.round(h2)}px`);
  check("…and shrinks back when cleared", Math.abs(h3 - h0) < 4, `${Math.round(h3)}px`);

  // Copy button on code blocks, click-to-copy on inline code
  // Headless Chrome won't read its clipboard back, so record what the panel writes to it.
  await panel.evaluate(() => {
    const w = window as any;
    w.__copied = [];
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (t: string) => {
      w.__copied.push(t);
      return orig(t);
    };
  });
  const lastCopied = () => panel.evaluate(() => (window as any).__copied.at(-1) ?? "?");
  const copyBtn = panel.locator("[data-copy-code]").first();
  check("code block has a Copy button", (await panel.locator("[data-copy-code]").count()) === 2);
  const longPre = await panel.locator(".md-pre", { hasText: "PAUSE synthetic" }).evaluate((n: HTMLElement) => ({
    overflow: n.scrollWidth - n.clientWidth,
    lines: Math.round(n.getBoundingClientRect().height / 16),
  }));
  check("long code lines wrap instead of cutting off", longPre.overflow <= 1 && longPre.lines >= 3, `overflow ${longPre.overflow}px, ~${longPre.lines} lines`);
  await copyBtn.click();
  await panel.waitForTimeout(200);
  const btnText = await copyBtn.innerText();
  const clip1 = await lastCopied();
  check("Copy puts the command on the clipboard", clip1 === "ssh prod-box" && btnText.startsWith("Copied"), `${btnText} · ${JSON.stringify(clip1)}`);
  await panel.screenshot({ path: join(OUT, "ui-copy.png") });
  await panel.locator(".msg-body p code", { hasText: "claude auth login" }).click();
  await panel.waitForTimeout(200);
  const clip2 = await lastCopied();
  check("clicking inline code copies it", clip2 === "claude auth login", JSON.stringify(clip2));

  // .html open bar under the agent reply
  const openBtn = panel.locator('[data-open-html][data-open-mode="tab"]');
  check(".html reply gets an Open bar", (await openBtn.count()) === 1, await openBtn.first().getAttribute("data-open-html") || "");

  // Switcher via ⌘K
  await panel.keyboard.press("Meta+k");
  await panel.waitForSelector("#switcher:not(.hidden) .sw-row");
  await panel.waitForTimeout(200);
  await panel.screenshot({ path: join(OUT, "ui-switcher.png") });
  const listText = await panel.locator("#switcher-list").innerText();
  check("groups: this tab / other open / closed", /THIS TAB/i.test(listText) && /OTHER OPEN TABS/i.test(listText) && /CLOSED TABS/i.test(listText));
  check("no tab numbers anywhere in the switcher", !/Tab #/.test(await panel.locator("#switcher").innerText()));
  check("row shows full URL and folder", listText.includes("127.0.0.1:7763/astro/kits") && listText.includes("acme-web-site"));
  check("send-to lists other tabs in this window", (await panel.locator("[data-sw-send]").count()) >= 2);

  // Search
  await panel.locator("#switcher-input").fill("astro");
  await panel.waitForFunction(() => document.querySelectorAll(".sw-row").length === 1, null, { timeout: 4000 });
  await panel.screenshot({ path: join(OUT, "ui-search.png") });
  check("search narrows to the match", true);

  // Rename a row inline
  await panel.locator(".sw-row").first().hover();
  await panel.locator("[data-sw-ren]").first().click();
  await panel.locator("[data-sw-ren-input]").fill("Astro sharp fix");
  await panel.keyboard.press("Enter");
  await panel.waitForTimeout(300);
  check("row rename saved", srv.store.getSession(sB.id)!.name === "Astro sharp fix", srv.store.getSession(sB.id)!.name);

  // Enter = move here
  await panel.locator("#switcher-input").fill("astro");
  await panel.waitForFunction(() => document.querySelectorAll(".sw-row").length === 1);
  await panel.locator("#switcher-input").press("Enter");
  await panel.waitForFunction(() => document.getElementById("chat-title-text")?.textContent === "Astro sharp fix", null, { timeout: 4000 });
  check("Move here puts the chat on this tab", srv.store.getTabBinding(tA.id)?.sessionId === sB.id);
  check("its old tab is freed", srv.store.getTabBinding(tB.id) === null);
  check("displaced chat is parked, not deleted", srv.store.getSession(sA.id)?.archived === true);

  // Header ✎ rename
  await panel.locator("#rename-btn").click();
  await panel.locator("#chat-title-input").fill("Astro build — sharp");
  await panel.keyboard.press("Enter");
  await panel.waitForTimeout(300);
  check("header rename saved", srv.store.getSession(sB.id)!.name === "Astro build — sharp");

  // Send this chat to tab C
  await panel.keyboard.press("Meta+k");
  await panel.waitForSelector("#switcher:not(.hidden) [data-sw-send]");
  await panel.locator(`[data-sw-send="${tC.id}"]`).click();
  await panel.waitForTimeout(600);
  check("Send to moves the chat to that tab", srv.store.getTabBinding(tC.id)?.sessionId === sB.id);
  const activeNow: any[] = await swk.evaluate((w) => chrome.tabs.query({ active: true, windowId: w }), W1);
  check("…and goes to that tab", activeNow[0]?.id === tC.id);

  // Attach the closed chat here (tab C), via button
  await panel.waitForFunction(() => document.getElementById("chat-title-text")?.textContent === "Astro build — sharp", null, { timeout: 4000 });
  await panel.keyboard.press("Meta+k");
  await panel.waitForSelector("#switcher:not(.hidden) [data-sw-move]");
  await panel.screenshot({ path: join(OUT, "ui-switcher-2.png") });
  await panel.locator("#switcher-input").fill("pricing fee");
  await panel.waitForFunction(() => document.querySelectorAll(".sw-row").length === 1);
  await panel.locator("[data-sw-move]").first().click();
  await panel.waitForTimeout(400);
  check("Attach here for a closed chat", srv.store.getTabBinding(tC.id)?.sessionId === sC.id);

  // Chat follows an opened .html: go back to chat A on tab A first
  await panel.keyboard.press("Meta+k");
  await panel.locator("#switcher-input").fill("kit cards");
  await panel.waitForFunction(() => document.querySelectorAll(".sw-row").length === 1);
  await panel.locator("[data-sw-move]").first().click();
  await panel.waitForFunction(() => document.getElementById("chat-title-text")?.textContent === "Kit cards spacing fix", null, { timeout: 4000 });
  const before = new Set(((await swk.evaluate(() => chrome.tabs.query({}))) as any[]).map((t) => t.id));
  await panel.locator('[data-open-html][data-open-mode="tab"]').first().click();
  await panel.waitForTimeout(1200);
  const after: any[] = await swk.evaluate(() => chrome.tabs.query({}));
  const fresh = after.find((t) => !before.has(t.id));
  check("Open ↗ opens a new tab", Boolean(fresh), fresh?.url || fresh?.pendingUrl || "");
  check("…and the chat follows it", fresh ? srv.store.getTabBinding(fresh.id)?.sessionId === sA.id : false);
  await panel.screenshot({ path: join(OUT, "ui-after-follow.png") });

  // Close the chat from the header ⏻: off the tab, panel empties, chat listed under Closed tabs
  await panel.locator("#close-chat-btn").click();
  await panel.waitForFunction(() => document.getElementById("chat-title-text")?.textContent === "No chat on this tab", null, { timeout: 4000 });
  check("⏻ closes the chat on this tab", fresh ? srv.store.getTabBinding(fresh.id) === null : false);
  check("…and keeps its history", srv.store.getSession(sA.id)?.archived === true && srv.store.getSessionFull(sA.id)!.messages.length > 0);
  await panel.keyboard.press("Meta+k");
  await panel.waitForSelector("#switcher:not(.hidden) .sw-row");
  await panel.waitForTimeout(200);
  const closedText = await panel.locator("#switcher-list").innerText();
  check("…and lists it under Closed tabs", /CLOSED TABS[\s\S]*Kit cards spacing fix/i.test(closedText));
  await panel.screenshot({ path: join(OUT, "ui-closed.png") });
  await panel.keyboard.press("Escape");

  // Pigeon-Hole Relay checks: hidden on normal tabs, active on :7764/#s=nova-kernel
  check("Relay pill stays hidden on non-Pigeon-Hole tabs", await panel.locator("#relay-mode-btn").isHidden());

  const tPh: any = await swk.evaluate(
    (w) => chrome.tabs.create({ windowId: w, url: "http://127.0.0.1:7764/#s=nova-kernel", active: false }),
    W1
  );
  const sPh = (
    await api("/api/sessions", {
      tabId: tPh.id,
      windowId: W1,
      url: "http://127.0.0.1:7764/#s=nova-kernel",
      title: "Pigeon-Hole · nova-kernel",
      name: "Pigeon-Hole · nova-kernel",
      repoPath: weld,
    })
  ).session;
  srv.store.insertMessage({
    sessionId: sPh.id,
    sender: "agent",
    text: "Drafted the council prompt for NovaKernel:\n```\nRun Lane A HWMCC benchmark in parallel.\n```",
  });
  await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tPh.id);
  await panel.waitForFunction(() => document.getElementById("chat-title-text")?.textContent === "Pigeon-Hole · nova-kernel", null, { timeout: 6000 });
  await panel.waitForTimeout(250);
  check("Relay pill appears on Pigeon-Hole tab (default Ask)", (await panel.locator("#relay-mode-btn").isVisible()) && (await panel.locator("#relay-mode-btn").innerText()) === "Relay: Ask");
  check("Cubby repo banner offers switching to nova-kernel", await panel.locator("#pigeon-repo-banner").isVisible());
  check("Code blocks get Queue ↗ button on Pigeon-Hole tab", await panel.locator("[data-queue-code]").first().isVisible());

  // Agent calls pigeon_send -> staged Relay Card renders live via WS
  const mcpCall = async (op: string, args: Record<string, unknown>) =>
    (
      await fetch("http://127.0.0.1:7762/api/mcp/call", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tab-Agent-Token": "t" },
        body: JSON.stringify({ sessionId: sPh.id, op, args }),
      })
    ).json();

  await mcpCall("pigeon_send", { text: "Run Lane A in parallel alongside track28.", mode: "queue" });
  await panel.waitForSelector('.relay-card[data-relay-status="staged"]', { timeout: 4000 });
  await panel.screenshot({ path: join(OUT, "ui-pigeon-staged.png") });
  check("pigeon_send renders staged editable Relay Card", (await panel.locator('.relay-card[data-relay-status="staged"] textarea').count()) === 1);

  // Confirm staged relay -> Queued receipt with Undo
  await panel.locator('.relay-card[data-relay-status="staged"] [data-relay-confirm]').first().click();
  await panel.waitForSelector('.relay-card[data-relay-status="queued"]', { timeout: 4000 });
  await panel.screenshot({ path: join(OUT, "ui-pigeon-queued.png") });
  check("Confirming Relay Card queues into Pigeon-Hole with Undo", mockPhQueue.length === 1 && (await panel.locator("[data-relay-undo]").count()) === 1);

  // Undo removes from Pigeon-Hole queue
  await panel.locator("[data-relay-undo]").first().click();
  await panel.waitForSelector('.relay-card[data-relay-status="undone"]', { timeout: 4000 });
  check("Undo removes queued item from Pigeon-Hole", mockPhQueue.length === 0);

  // Toggle Row-2 pill to Auto-Queue -> steer stays gated, queue auto-executes
  await panel.locator("#relay-mode-btn").click();
  await panel.waitForFunction(() => document.getElementById("relay-mode-btn")?.textContent === "Relay: Auto-Queue", null, { timeout: 4000 });
  await mcpCall("pigeon_send", { text: "Pause scp right now", mode: "steer" });
  await panel.waitForSelector('.relay-card.warn[data-relay-status="staged"]', { timeout: 4000 });
  check("Steer stays 1-click gated even in Auto-Queue mode", (await panel.locator('.relay-card.warn[data-relay-status="staged"]').count()) === 1);
  await mcpCall("pigeon_send", { text: "Auto-queued parallel run", mode: "queue" });
  await panel.waitForSelector('.relay-card[data-relay-status="queued"]', { timeout: 4000 });
  check("Auto-Queue injects directly on working cubby", mockPhQueue.length === 1);

  // Live working / heartbeat visibility + silent-exit error badge
  const liveBinDir = mkdtempSync(join(tmpdir(), "ta-ui-live-"));
  const liveFakeAgy = join(liveBinDir, "agy");
  writeFileSync(
    liveFakeAgy,
    [
      "#!/bin/sh",
      'printf \'{"event":"init","conversation_id":"conv-ui-1"}\\n\'',
      'printf \'{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"scp track28/results.json"}}}}\\n\'',
      "sleep 2.2",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  const prevAgyBin = process.env.AGY_BIN;
  process.env.AGY_BIN = liveFakeAgy;
  try {
    await api(`/api/sessions/${sPh.id}/prompt`, { text: "Run silent-exit test" });
    await panel.waitForSelector("[data-live-work-box]", { timeout: 4000 });
    await panel.waitForFunction(
      () => (document.querySelector("[data-live-step]")?.textContent || "").includes("run_command: scp track28"),
      null,
      { timeout: 4000 }
    );
    await panel.screenshot({ path: join(OUT, "ui-working-live.png") });
    check(
      "Active tool-heavy turn shows live working box + header timer",
      (await panel.locator("#working-pill").isVisible()) &&
        (await panel.locator("[data-live-step]").innerText()).includes("run_command: scp track28")
    );
    // Wait for silent exit -> error badge renders clearly
    await panel.waitForSelector(".msg-card.is-error .msg-err-badge", { timeout: 5000 });
    await panel.screenshot({ path: join(OUT, "ui-silent-exit-error.png") });
    check(
      "Silent CLI exit renders clear Harness error badge",
      (await panel.locator(".msg-card.is-error .msg-err-badge").innerText()).toUpperCase().includes("HARNESS ERROR")
    );

    // /after banner + cancel + Cross-Tab Radar jump from another tab
    await api(`/api/sessions/${sPh.id}/triggers`, {
      targetSessionId: "nova-kernel",
      instruction: "Check kill bar and stage next prompt",
    });
    await panel.waitForSelector("#after-banner:not(.hidden)", { timeout: 4000 });
    await panel.screenshot({ path: join(OUT, "ui-after-armed.png") });
    check(
      "/after banner displays armed watcher with Cancel",
      (await panel.locator("#after-banner").innerText()).includes("nova-kernel")
    );
    await panel.locator("[data-cancel-trigger]").first().click();
    await panel.waitForSelector("#after-banner", { state: "hidden", timeout: 4000 });
    check("Cancel button disarms /after watcher", true);

    // Switch to another tab (tC) -> Cross-Tab Radar shows compact "Working: 1" + error chip, and clicking jumps + clears it!
    await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tC.id);
    await panel.waitForSelector("#radar-bar:not(.hidden) .radar-chip.error", { timeout: 5000 });
    await panel.screenshot({ path: join(OUT, "ui-radar-strip.png") });
    const radarTxt = await panel.locator("#radar-bar").innerText();
    check(
      "Cross-Tab Radar collapses working to 'Working: N' and surfaces error chip",
      radarTxt.includes("Working: 1") &&
        !radarTxt.includes("Working: PH") &&
        (await panel.locator("#radar-bar .radar-chip.error").innerText()).includes("Pigeon-Hole")
    );
    await panel.locator("#radar-bar .radar-chip.error").first().click();
    await panel.waitForFunction(
      () => document.getElementById("chat-title-text")?.textContent === "Pigeon-Hole · nova-kernel",
      null,
      { timeout: 5000 }
    );
    check("Clicking Radar chip jumps straight to that tab and clears it", srv.getRadar().tabError === 0);

    // Inline ▶ Run terminal runner on code blocks + → Compose + Copy
    srv.store.insertMessage({
      sessionId: sPh.id,
      sender: "agent",
      text: "Run this check:\n```bash\necho \"hello from tab-agent runner\"\n```",
    });
    await api(`/api/sessions/${sPh.id}`, { name: "Pigeon-Hole · nova-kernel" }, "PATCH");
    await panel.waitForSelector('.md-code [data-run-code]', { timeout: 4000 });
    await panel.locator('.md-code', { hasText: "hello from tab-agent runner" }).locator("[data-run-code]").click();
    await panel.waitForSelector('.term-drawer[data-shell-status="done"]', { timeout: 6000 });
    await panel.screenshot({ path: join(OUT, "ui-shell-run.png") });
    const termTxt = await panel.locator('.term-drawer[data-shell-status="done"] .term-out').innerText();
    check("▶ Run executes code block in sidebar and shows output", termTxt.includes("hello from tab-agent runner"));

    await panel.locator('[data-shell-compose]').first().click();
    const composeVal = await panel.locator("#prompt-input").inputValue();
    check("→ Compose inserts command & output into compose box", composeVal.includes("hello from tab-agent runner"));
    await panel.locator("#prompt-input").fill("");

    await panel.locator('[data-shell-copy]').first().click();
    await panel.waitForTimeout(150);
    check("Terminal Copy puts output on clipboard", (await lastCopied()).includes("hello from tab-agent runner"));

    // ⌖ Pin Note directly on live web tab (with See Page OFF) -> element chip + note + cropped screenshot thumbnail
    await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tC.id);
    await panel.waitForSelector("#pin-note-btn", { timeout: 4000 });
    await panel.waitForTimeout(250);
    await panel.locator("#pin-note-btn").click();
    await pc.waitForSelector("#__tab_agent_picker_overlay__", { state: "attached", timeout: 4000 });
    await pc.bringToFront();
    await pc.locator("h1").first().click({ position: { x: 16, y: 12 } });
    await pc.waitForFunction(
      () => {
        const host = document.getElementById("__tab_agent_picker_overlay__");
        const pop = host?.shadowRoot?.querySelector(".ta-popover") as HTMLElement | null;
        return Boolean(pop && pop.style.display === "flex");
      },
      null,
      { timeout: 4000 }
    );
    await pc.screenshot({ path: join(OUT, "ui-pin-overlay.png") });
    await pc.evaluate(() => {
      const host = document.getElementById("__tab_agent_picker_overlay__");
      const inp = host?.shadowRoot?.getElementById("ta-pop-input") as HTMLInputElement | null;
      if (inp) {
        inp.value = "make this section collapsible";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const doneBtn = host?.shadowRoot?.getElementById("ta-pop-done") as HTMLButtonElement | null;
      doneBtn?.click();
    });
    await panel.waitForSelector("#chips-bar:not(.hidden) .el-chip.is-pin", { timeout: 5000 });
    await panel.waitForSelector("#attachments-tray:not(.hidden) .att-card:not(.uploading)", { timeout: 6000 });
    await panel.screenshot({ path: join(OUT, "ui-pin-note.png") });
    const pinChipTxt = await panel.locator("#chips-bar .el-chip.is-pin").first().innerText();
    const pinAttName = await panel.locator("#attachments-tray .att-name").first().innerText();
    check(
      "⌖ Pin attaches numbered note chip + cropped element PNG with See Page OFF",
      pinChipTxt.includes("#1") &&
        pinChipTxt.includes("make this section collapsible") &&
        pinAttName.includes("pin-1-")
    );

    // Background Tab-Agent session on another open tab (tPh) finishes fast -> appears immediately as Needs you in tC's Radar!
    const fastAgy = join(liveBinDir, "fast-agy.sh");
    writeFileSync(
      fastAgy,
      `#!/bin/sh
echo '{"event":"init","conversation_id":"conv-bg-tab"}'
echo '{"event":"result","result":{"conversation_id":"conv-bg-tab","response":"Checks passed — want me to deploy now?"}}'
exit 0
`,
      { mode: 0o755 }
    );
    process.env.AGY_BIN = fastAgy;
    await api(`/api/sessions/${sPh.id}/prompt`, { text: "Check deploy readiness" });
    await panel.waitForSelector("#radar-bar:not(.hidden) .radar-chip.needs-you", { timeout: 5000 });
    await panel.screenshot({ path: join(OUT, "ui-radar-tab-needs-you.png") });
    const bgRadarTxt = await panel.locator("#radar-bar .radar-chip.needs-you").first().innerText();
    check(
      "Background Tab-Agent tab surfaces Needs you chip in another tab's Radar",
      bgRadarTxt.includes("Needs you:") && bgRadarTxt.includes("Pigeon-Hole")
    );
    await panel.locator("#radar-bar .radar-chip.needs-you").first().click();
    await panel.waitForFunction(
      () => document.getElementById("chat-title-text")?.textContent === "Pigeon-Hole · nova-kernel",
      null,
      { timeout: 5000 }
    );
    check("Clicking Tab-Agent Radar chip jumps to that tab and clears its alert", srv.getRadar().tabAttention === 0);

    // /council inside Pigeon-Hole tab -> renders Open ↗ HTML dossier bar + auto-staged Relay Card!
    const councilAgy = join(liveBinDir, "council-agy.sh");
    const councilClaude = join(liveBinDir, "council-claude.sh");
    writeFileSync(
      councilAgy,
      `#!/bin/sh\nprintf '%s\\n' '{"event":"result","result":{"response":"1. **Verdict:** Pivot to track 29 immediately.\\n2. **Blind spot / risk:** Verify SRAM fit first.\\n3. **Next concrete step:** Benchmark 256-tile SRAM kernel before scaling."}}'\nexit 0\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      councilClaude,
      `#!/bin/sh\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"1. **Verdict:** Agree with pivot to track 29.\\n2. **Blind spot / risk:** Keep baseline sealed.\\n3. **Next concrete step:** Run sealed eval harness on track 29."}'\nexit 0\n`,
      { mode: 0o755 }
    );
    const prevClaudeBin = process.env.CLAUDE_BIN;
    process.env.AGY_BIN = councilAgy;
    process.env.CLAUDE_BIN = councilClaude;
    try {
      await api(`/api/sessions/${sPh.id}/prompt`, { text: "/council gemini,claude | Pivot track 28 to track 29?" });
      await panel.waitForSelector('.msg-card.agent .html-open-bar', { timeout: 6000 });
      await panel.waitForSelector('.msg-card.agent .relay-card[data-relay-status="staged"]', { timeout: 6000 });
      await panel.screenshot({ path: join(OUT, "ui-council-relay.png") });
      const lastCardTxt = await panel.locator(".msg-card.agent").last().innerText();
      check(
        "/council renders summary + Open ↗ HTML dossier bar + staged Pigeon-Hole Relay Card",
        lastCardTxt.includes("Council Verdicts (2/2)") &&
          (await panel.locator(".msg-card.agent").last().locator(".html-open-bar").count()) > 0 &&
          (await panel.locator(".msg-card.agent").last().locator('.relay-card[data-relay-status="staged"]').count()) > 0
      );
      // Clean up generated dossier file after capturing a visual screenshot of it
      const dossierHref = await panel.locator(".msg-card.agent").last().locator("[data-open-html]").first().getAttribute("data-open-html");
      if (dossierHref && dossierHref.startsWith("file://")) {
        const dp = await ctx.newPage();
        await dp.setViewportSize({ width: 1120, height: 820 });
        await dp.goto(dossierHref);
        await dp.screenshot({ path: join(OUT, "ui-council-dossier.png") });
        await dp.close();
        rmSync(dossierHref.replace(/^file:\/\//, ""), { force: true });
      }
    } finally {
      if (prevClaudeBin === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prevClaudeBin;
    }

    // Reloading a bound page keeps its Tab-Agent chat bound (no "Move here" / lost binding)
    await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tPh.id);
    const phPage = ctx.pages().find((p) => p.url().startsWith(`http://127.0.0.1:${mockPigeon.port}`));
    if (phPage) {
      await phPage.reload({ waitUntil: "domcontentloaded" });
      await panel.waitForTimeout(350);
    }
    check(
      "Reloading a bound tab keeps its Tab-Agent chat attached",
      (await panel.locator("#chat-title-text").innerText()) === "Pigeon-Hole · nova-kernel"
    );
  } finally {
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    rmSync(liveBinDir, { recursive: true, force: true });
  }
} catch (err) {
  check("script ran to the end", false, String(err).slice(0, 300));
} finally {
  console.log(results.join("\n"));
  console.log(`screenshots: ${OUT}`);
  await ctx.close();
  pages.stop(true);
  mockPigeon.stop(true);
  srv.stop();
  rmSync(userDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(EXT, { recursive: true, force: true });
  if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
}
