/**
 * Generates clean, publication-ready documentation screenshots for Tab-Agent + Pigeon-Hole
 * using real Chromium + isolated temp daemons + zero private data.
 *
 * Usage:
 *   PIGEON_HOLE_DIR=/path/to/Pigeon-Hole OUT_DIR=./docs/screenshots bun scripts/capture-docs-screenshots.ts
 */
import { chromium } from "playwright";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTabAgentServer } from "../daemon/server";
import { renderCouncilDossierHtml, type CouncilVerdict } from "../daemon/council";

const ROOT = resolve(import.meta.dir, "..");
const OUT_DIR = resolve(process.env.OUT_DIR || join(ROOT, "docs", "screenshots"));
mkdirSync(OUT_DIR, { recursive: true });

function findChromium(): string {
  if (process.env.CHROME_EXE && existsSync(process.env.CHROME_EXE)) return process.env.CHROME_EXE;
  const cacheDir = join(process.env.HOME || "", "Library", "Caches", "ms-playwright");
  if (existsSync(cacheDir)) {
    const dirs = readdirSync(cacheDir).filter((d) => d.startsWith("chromium-")).sort().reverse();
    for (const d of dirs) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-linux/chrome",
      ]) {
        const p = join(cacheDir, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const sys of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ]) {
    if (existsSync(sys)) return sys;
  }
  throw new Error("No Chromium binary found. Set CHROME_EXE or install playwright chromium.");
}

const CHROME = findChromium();
const TMP = mkdtempSync(join(tmpdir(), "ta-docs-shots-"));
const DEMO_REPOS = "/tmp/demo-workspace";
rmSync(DEMO_REPOS, { recursive: true, force: true });
const REPO_NOVA = join(DEMO_REPOS, "nova-kernel");
const REPO_ACME = join(DEMO_REPOS, "acme-web");
const REPO_PULSE = join(DEMO_REPOS, "pulse-api");
mkdirSync(join(REPO_NOVA, ".git"), { recursive: true });
mkdirSync(join(REPO_ACME, ".git"), { recursive: true });
mkdirSync(join(REPO_PULSE, ".git"), { recursive: true });
writeFileSync(
  join(REPO_ACME, "billing.test.ts"),
  `import { describe, expect, test } from "bun:test";
describe("BillingSummary", () => {
  test("formats monthly usage total", () => expect("$148.40").toContain("148.40"));
  test("collapses details cleanly", () => expect(true).toBe(true));
  test("handles zero-usage workspaces", () => expect(0).toBe(0));
});
`
);

const DAEMON_PORT = 7772;
const PIGEON_PORT = 7774;
const DEMO_SITE_PORT = 7773;

// Prepare unpacked extension copy pointing at isolated daemon :7772
const EXT_DIR = join(TMP, "extension");
cpSync(join(ROOT, "extension"), EXT_DIR, { recursive: true });
for (const f of ["background.js", "sidepanel.js", "manifest.json"]) {
  const p = join(EXT_DIR, f);
  writeFileSync(p, readFileSync(p, "utf8").replaceAll("7752", String(DAEMON_PORT)));
}

// Start either a real isolated Pigeon-Hole instance or clean demo Pigeon-Hole server on :7774
let pigeonProc: ReturnType<typeof Bun.spawn> | null = null;
let fallbackPigeon: ReturnType<typeof Bun.serve> | null = null;

async function startDemoPigeonHole(): Promise<void> {
  const phDir = process.env.PIGEON_HOLE_DIR;
  if (phDir && existsSync(join(phDir, "src", "server.ts"))) {
    const phDb = join(TMP, "pigeon-demo.sqlite");
    const phAtt = join(TMP, "pigeon-att");
    mkdirSync(phAtt, { recursive: true });
    pigeonProc = Bun.spawn([process.execPath, "run", join(phDir, "src", "server.ts")], {
      cwd: phDir,
      env: {
        ...process.env,
        PORT: String(PIGEON_PORT),
        PIGEON_HOLE_DB: phDb,
        PIGEON_HOLE_ATTACHMENTS_DIR: phAtt,
        PIGEON_HOLE_RUNNER_URL: "",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${PIGEON_PORT}/api/bootstrap`);
        if (r.ok) break;
      } catch {}
      await Bun.sleep(150);
    }
    // Clear any default seeded demo cubbies and insert clean public showcase cubbies
    const boot = (await (await fetch(`http://127.0.0.1:${PIGEON_PORT}/api/bootstrap`)).json()) as any;
    for (const s of boot.sessions || []) {
      await fetch(`http://127.0.0.1:${PIGEON_PORT}/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    }
    const seedCubbies = [
      { name: "nova-kernel", shelf: "Research", path: REPO_NOVA, harnessId: "agy-neon", effort: "xhigh", utopiaTag: "research" },
      { name: "acme-web", shelf: "Web", path: REPO_ACME, harnessId: "claude-opus", effort: "high", utopiaTag: "cash" },
      { name: "pulse-api", shelf: "Backend", path: REPO_PULSE, harnessId: "agy-carbon", effort: "high", utopiaTag: "soul" },
      { name: "docs-site", shelf: "Web", path: REPO_ACME, harnessId: "claude-sonnet", effort: "medium", utopiaTag: "wildcard" },
    ];
    for (const c of seedCubbies) {
      await fetch(`http://127.0.0.1:${PIGEON_PORT}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "pls", ...c }),
      });
    }
    // Seed a realistic message & working state directly in the temp SQLite DB
    const { Database } = await import("bun:sqlite");
    const db = new Database(phDb);
    const now = Date.now();
    const rows = db.query("SELECT id, name FROM sessions").all() as Array<{ id: string; name: string }>;
    for (const r of rows) {
      if (r.name === "nova-kernel") {
        db.query("UPDATE sessions SET state = 'working', question_snippet = 'Running 256-tile SRAM roofline benchmark...', updated_at = ? WHERE id = ?").run(now, r.id);
        db.query("INSERT INTO messages (session_id, sender, time, text, created_at) VALUES (?, 'human', '21:14', ?, ?)").run(
          r.id, "Benchmark 256-tile SRAM layout against the sealed baseline and report wall-clock speedup.", now - 60_000
        );
        db.query("INSERT INTO messages (session_id, sender, time, text, created_at) VALUES (?, 'agent', '21:18', ?, ?)").run(
          r.id, "Track 28 hit 2.36x speedup vs 3.0x pass bar. Running Track 29 tile-fusion sweep now...", now - 10_000
        );
      } else if (r.name === "acme-web") {
        db.query("UPDATE sessions SET state = 'needs-you', question_snippet = 'Billing summary card refactored — ready to preview on localhost:4321?', updated_at = ? WHERE id = ?").run(now - 120_000, r.id);
      } else if (r.name === "pulse-api") {
        db.query("UPDATE sessions SET state = 'seen', question_snippet = 'Rate-limit middleware tests passing (42/42).', updated_at = ? WHERE id = ?").run(now - 900_000, r.id);
      } else if (r.name === "docs-site") {
        db.query("UPDATE sessions SET state = 'seen', question_snippet = 'Updated Quick Start guide and CLI flags table.', updated_at = ? WHERE id = ?").run(now - 1800_000, r.id);
      }
    }
    db.close();
    // Force Pigeon-Hole to re-read clean seeded state via restart on same temp DB
    pigeonProc.kill();
    await pigeonProc.exited.catch(() => {});
    pigeonProc = Bun.spawn([process.execPath, "run", join(phDir, "src", "server.ts")], {
      cwd: phDir,
      env: {
        ...process.env,
        PORT: String(PIGEON_PORT),
        PIGEON_HOLE_DB: phDb,
        PIGEON_HOLE_ATTACHMENTS_DIR: phAtt,
        PIGEON_HOLE_RUNNER_URL: "",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const d2 = Date.now() + 8000;
    while (Date.now() < d2) {
      try {
        const r = await fetch(`http://127.0.0.1:${PIGEON_PORT}/api/bootstrap`);
        if (r.ok) break;
      } catch {}
      await Bun.sleep(150);
    }
    return;
  }

  // Fallback minimal mock Pigeon-Hole if PIGEON_HOLE_DIR is not passed
  fallbackPigeon = Bun.serve({
    port: PIGEON_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/bootstrap") {
        return Response.json({
          sessions: [
            { id: "nova-kernel", name: "nova-kernel", state: "working", family: "AGY", model: "NEON", effort: "xhigh", path: REPO_NOVA, displayPath: "~/Projects/nova-kernel", queuedCount: 0, messages: [] },
            { id: "acme-web", name: "acme-web", state: "needs-you", family: "CLAUDE", model: "OPUS", effort: "high", path: REPO_ACME, displayPath: "~/Projects/acme-web", queuedCount: 0, messages: [] },
          ],
        });
      }
      return new Response("<!doctype html><html><body style='background:#F4EFE4;font-family:sans-serif;padding:40px'><h1>Pigeon-Hole</h1></body></html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
}

// Clean demo web page for ⌖ Pin Note screenshot
const demoSite = Bun.serve({
  port: DEMO_SITE_PORT,
  hostname: "127.0.0.1",
  fetch() {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme Cloud — Billing Overview</title>
      <style>
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #F7F8FA; color: #181A1F; padding: 36px 40px; }
        .top { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; }
        h1 { margin: 0; font-size: 24px; }
        .pill { background: #E8F0FE; color: #1E4E8C; font-weight: 600; font-size: 12px; padding: 4px 12px; border-radius: 999px; }
        .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 18px; max-width: 780px; }
        .card { background:#fff; border:1px solid #E2E6ED; border-radius:12px; padding:20px; box-shadow: 0 2px 6px rgba(0,0,0,0.03); }
        .billing-card { grid-column: 1 / -1; border-left: 4px solid #1E4E8C; }
        .k { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #6B7280; font-weight: 600; }
        .v { font-size: 28px; font-weight: 700; margin: 6px 0 4px; }
        .sub { font-size: 13px; color: #4B5563; }
      </style></head><body>
      <div class="top"><h1>Acme Cloud · Workspace Billing</h1><span class="pill">Production · EU-West</span></div>
      <div class="grid">
        <section class="card billing-card" id="billing-summary">
          <div class="k">Monthly Usage Summary</div>
          <div class="v">$148.40</div>
          <div class="sub">12 active worker nodes · 99.98% uptime · Next invoice 01 Dec</div>
        </section>
        <section class="card"><div class="k">API Requests (24h)</div><div class="v">1.42M</div><div class="sub">p95 latency: 38ms</div></section>
        <section class="card"><div class="k">Error Rate</div><div class="v">0.02%</div><div class="sub">Zero 5xx alerts</div></section>
      </div></body></html>`,
      { headers: { "content-type": "text/html" } }
    );
  },
});

const srv = createTabAgentServer({
  port: DAEMON_PORT,
  dbPath: ":memory:",
  token: "docs-shot-token",
  scratchDir: DEMO_REPOS,
  pigeonHoleUrl: `http://127.0.0.1:${PIGEON_PORT}`,
  watchPigeonWs: true,
});

async function composeSideBySide(
  page: any,
  leftPngPath: string,
  rightPngPath: string,
  outPath: string,
  width: number,
  height: number
) {
  const leftB64 = readFileSync(leftPngPath).toString("base64");
  const rightB64 = readFileSync(rightPngPath).toString("base64");
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#E8E2D5;display:flex;width:${width}px;height:${height}px;overflow:hidden;">
    <img src="data:image/png;base64,${leftB64}" style="flex:1;height:100%;object-fit:cover;object-position:top left;display:block;" />
    <img src="data:image/png;base64,${rightB64}" style="width:400px;height:100%;object-fit:cover;object-position:top left;display:block;box-shadow:-4px 0 18px rgba(0,0,0,0.12);" />
  </body></html>`);
  await page.waitForTimeout(100);
  await page.screenshot({ path: outPath });
}

let ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
try {
  await startDemoPigeonHole();
  const phBoot = (await (await fetch(`http://127.0.0.1:${PIGEON_PORT}/api/bootstrap`)).json()) as any;
  const novaCubby = (phBoot.sessions || []).find((s: any) => s.name === "nova-kernel") || phBoot.sessions?.[0];
  const novaId = novaCubby?.id || "nova-kernel";

  const userDir = join(TMP, "profile");
  ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME,
    headless: true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    viewport: { width: 1040, height: 860 },
  });

  let [swk] = ctx.serviceWorkers();
  if (!swk) swk = await ctx.waitForEvent("serviceworker");
  const extId = new URL(swk.url()).host;

  // Open demo Pigeon-Hole board + demo billing site
  const phPage = ctx.pages()[0] || (await ctx.newPage());
  await phPage.setViewportSize({ width: 1040, height: 860 });
  await phPage.goto(`http://127.0.0.1:${PIGEON_PORT}/`, { waitUntil: "networkidle" });
  // Switch to All time mode so all 4 clean cubbies show regardless of clock hour
  const allModeBtn = phPage.locator('.time-mode-pill[data-time-mode="all"]');
  if (await allModeBtn.count()) await allModeBtn.click();
  await phPage.waitForTimeout(350);

  const webPage = await ctx.newPage();
  await webPage.setViewportSize({ width: 820, height: 740 });
  await webPage.goto(`http://127.0.0.1:${DEMO_SITE_PORT}/billing`, { waitUntil: "networkidle" });

  const tabs: any[] = await swk.evaluate(() => chrome.tabs.query({}));
  const tPh = tabs.find((t) => (t.url || "").includes(`:${PIGEON_PORT}`));
  const tWeb = tabs.find((t) => (t.url || "").includes(`:${DEMO_SITE_PORT}`));
  const W1 = tPh.windowId;

  const api = async (path: string, body?: unknown, method = body ? "POST" : "GET") =>
    (
      await fetch(`http://127.0.0.1:${DAEMON_PORT}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
    ).json();

  // Seed Tab-Agent sessions
  const sPh = (
    await api("/api/sessions", {
      tabId: tPh.id,
      windowId: W1,
      url: `http://127.0.0.1:${PIGEON_PORT}/#s=${novaId}`,
      title: "Pigeon-Hole · nova-kernel",
      name: "nova-kernel · Supervisor",
      repoPath: REPO_NOVA,
      harnessId: "claude-opus",
      effort: "high",
    })
  ).session;

  const sWeb = (
    await api("/api/sessions", {
      tabId: tWeb.id,
      windowId: W1,
      url: `http://127.0.0.1:${DEMO_SITE_PORT}/billing`,
      title: "Acme Cloud — Billing Overview",
      name: "acme-web · Billing UI",
      repoPath: REPO_ACME,
      harnessId: "agy-neon",
      effort: "low",
    })
  ).session;

  srv.store.insertMessage({
    sessionId: sPh.id,
    sender: "human",
    text: "Check nova-kernel's latest benchmark and stage the next queue prompt for Track 29.",
  });
  const agMsg = srv.store.insertMessage({
    sessionId: sPh.id,
    sender: "agent",
    text: "Checked `nova-kernel` (currently running Track 29 tile-fusion). Track 28 reached **2.36×** vs the **3.0×** pass bar.\n\nStaged the next follow-up prompt below — review or press `⌘⇧↩` to queue it directly into Pigeon-Hole:",
  });
  await srv.pigeon.createFromUserAction(sPh.id, {
    text: "Once Track 29 finishes, compare wall-clock tok/s against the sealed baseline. If >= 3.0x, freeze weights and run full regression suite; otherwise profile L2 cache misses before trying another kernel.",
    mode: "queue",
    targetSessionId: novaId,
    messageId: agMsg.id,
    executeNow: false,
  });

  // Spoof window W1 for the panel window
  await ctx.addInitScript((w) => {
    if (location.protocol === "chrome-extension:") {
      // @ts-ignore
      chrome.windows.getCurrent = async () => ({ id: w });
    }
  }, W1);

  await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tPh.id);
  const panelP = ctx.waitForEvent("page");
  await swk.evaluate((url) => chrome.windows.create({ url }), `chrome-extension://${extId}/sidepanel.html`);
  const panel = await panelP;
  await panel.setViewportSize({ width: 400, height: 860 });
  await panel.waitForLoadState("domcontentloaded");
  await panel.waitForTimeout(450);

  // Navigate phPage to #s=novaId for live Relay header, then snapshot board left + panel right!
  const leftBoardPng = join(TMP, "hero-left.png");
  const rightPanelPng = join(TMP, "hero-right.png");
  await phPage.screenshot({ path: leftBoardPng });
  await phPage.evaluate((id) => { window.location.hash = `#s=${id}`; }, novaId);
  await panel.waitForSelector('.relay-card[data-relay-status="staged"]', { timeout: 6000 });
  await panel.waitForTimeout(250);
  await panel.screenshot({ path: rightPanelPng });

  const compPage = await ctx.newPage();
  await composeSideBySide(compPage, leftBoardPng, rightPanelPng, join(OUT_DIR, "hero-tab-agent-pigeon-hole.png"), 1440, 860);

  // 2. Cross-Tab Radar + /after armed banner (re-activate tPh since compPage took focus)
  srv.store.setSessionAttention(sWeb.id, "needs-you", "Billing summary card refactored — ready to review?");
  await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tPh.id);
  await panel.waitForSelector('.relay-card[data-relay-status="staged"]', { timeout: 6000 });
  await api(`/api/sessions/${sPh.id}/triggers`, {
    targetSessionId: novaId,
    instruction: "Check 3.0x pass bar and stage next kernel prompt",
  });
  await panel.waitForSelector("#after-banner:not(.hidden)", { timeout: 5000 });
  await panel.waitForSelector("#radar-bar:not(.hidden)", { timeout: 5000 });
  await panel.setViewportSize({ width: 420, height: 760 });
  await panel.waitForTimeout(250);
  await panel.screenshot({ path: join(OUT_DIR, "cross-tab-radar.png") });

  // 3. Inline ▶ Run terminal runner (real bun test inside demo acme-web repo)
  srv.store.insertMessage({
    sessionId: sWeb.id,
    sender: "agent",
    text: "Run the test suite in `acme-web` to confirm the billing card refactor:\n```bash\nbun test billing.test.ts\n```",
  });
  await swk.evaluate((id) => chrome.tabs.update(id, { active: true }), tWeb.id);
  await panel.waitForSelector(".md-code [data-run-code]", { timeout: 5000 });
  await panel.locator(".md-code [data-run-code]").first().click();
  await panel.waitForSelector('.term-drawer[data-shell-status="done"]', { timeout: 6000 });
  await panel.waitForTimeout(200);
  await panel.screenshot({ path: join(OUT_DIR, "inline-run-terminal.png") });

  // 4. In-page ⌖ Pin markup (web page with overlay on left + sidebar chip & crop on right)
  await panel.setViewportSize({ width: 400, height: 740 });
  await panel.locator("#pin-note-btn").click();
  await webPage.waitForSelector("#__tab_agent_picker_overlay__", { state: "attached", timeout: 4000 });
  await webPage.bringToFront();
  await webPage.locator("#billing-summary").click({ position: { x: 10, y: 10 } });
  await webPage.waitForFunction(
    () => {
      const h = document.getElementById("__tab_agent_picker_overlay__");
      const pop = h?.shadowRoot?.querySelector(".ta-popover") as HTMLElement | null;
      return Boolean(pop && pop.style.display === "flex");
    },
    null,
    { timeout: 4000 }
  );
  await webPage.evaluate(() => {
    const h = document.getElementById("__tab_agent_picker_overlay__");
    const inp = h?.shadowRoot?.getElementById("ta-pop-input") as HTMLInputElement | null;
    if (inp) {
      inp.value = "Make this billing summary card collapsible";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  const pinLeftPng = join(TMP, "pin-left.png");
  await webPage.screenshot({ path: pinLeftPng });
  await webPage.evaluate(() => {
    const h = document.getElementById("__tab_agent_picker_overlay__");
    (h?.shadowRoot?.getElementById("ta-pop-done") as HTMLButtonElement | null)?.click();
  });
  await panel.waitForSelector("#chips-bar:not(.hidden) .el-chip.is-pin", { timeout: 5000 });
  await panel.waitForSelector("#attachments-tray:not(.hidden) .att-card:not(.uploading)", { timeout: 6000 });
  // Wait for transient toast to clear so the pinned chip is completely unobstructed
  await panel.waitForTimeout(2700);
  const pinRightPng = join(TMP, "pin-right.png");
  await panel.screenshot({ path: pinRightPng });
  await composeSideBySide(compPage, pinLeftPng, pinRightPng, join(OUT_DIR, "pin-note-markup.png"), 1220, 740);

  // 5. Frontier /council HTML Comparison Dossier (4 independent companies)
  const verdicts: CouncilVerdict[] = [
    {
      id: "gemini",
      company: "Google",
      label: "Gemini 4 · Carbon",
      accent: "#1E4E8C",
      ok: true,
      durationMs: 4200,
      text: "1. **Verdict:** Pivot to Track 29 tile-fusion now; Track 28 is memory-bound at 2.36x.\n2. **Blind spot / risk:** Register spilling above 256 tiles can erase SRAM gains.\n3. **Next concrete step:** Run a 5-minute 128 vs 256 tile roofline sweep before touching the main kernel.",
    },
    {
      id: "claude",
      company: "Anthropic",
      label: "Claude · Opus",
      accent: "#A23B17",
      ok: true,
      durationMs: 5600,
      text: "1. **Verdict:** Agree — keep Track 28 as the baseline and move directly to Track 29.\n2. **Blind spot / risk:** Ensure the evaluation split stays sealed so tuning doesn't leak.\n3. **Next concrete step:** Lock a 3.0x wall-clock pass bar on the held-out suite first.",
    },
    {
      id: "codex",
      company: "OpenAI",
      label: "Codex · GPT-6.2 Sol",
      accent: "#146A43",
      ok: true,
      durationMs: 3900,
      text: "1. **Verdict:** Pivot cleanly, but fuse epilogue quantisation into the same pass.\n2. **Blind spot / risk:** Host-to-device dispatch latency may dominate short batches.\n3. **Next concrete step:** Measure end-to-end batch=1 and batch=8 latency, not kernel-only microbenchmarks.",
    },
    {
      id: "kimi",
      company: "Moonshot",
      label: "Kimi · K3.1 Pro",
      accent: "#6B3FA0",
      ok: true,
      durationMs: 6100,
      text: "1. **Verdict:** Run one controlled ablation on Track 29 with fused softmax.\n2. **Blind spot / risk:** Small synthetic sequences hide KV bandwidth pressure at 2048+ context.\n3. **Next concrete step:** Include a 2048-token decode profile in the pass gate.",
    },
  ];
  const dossierHtml = renderCouncilDossierHtml({
    question: "Should nova-kernel push Track 28 further or pivot to Track 29 tile-fusion?",
    session: srv.store.getSession(sPh.id)!,
    pigeonCubbyName: "nova-kernel",
    verdicts,
    synthesisMarkdown:
      "### Consensus (4/4)\nAll four councillors recommend pivoting to **Track 29 tile-fusion** rather than squeezing Track 28 past 2.36x.\n\n### Where They Split\n- **Google & Moonshot** flag SRAM register spilling and 2048-token KV bandwidth as the main risks.\n- **OpenAI** advises fusing epilogue quantisation immediately and testing batch=1 vs batch=8 end-to-end.",
    recommendedPrompt:
      "Pivot to Track 29 tile-fusion. Run a 128 vs 256 tile sweep with fused epilogue quantisation, measure end-to-end tok/s at batch=1 & batch=8 (2048 context), and score against the sealed 3.0x wall-clock pass bar.",
    createdAt: Date.now(),
  });
  const dossierPath = join(TMP, "council-demo.html");
  writeFileSync(dossierPath, dossierHtml, "utf8");
  await compPage.setViewportSize({ width: 1240, height: 860 });
  await compPage.goto(`file://${dossierPath}`);
  await compPage.waitForTimeout(150);
  await compPage.screenshot({ path: join(OUT_DIR, "council-dossier.png"), fullPage: true });

  console.log("Captured 5 screenshots to", OUT_DIR);
} finally {
  if (ctx) await ctx.close().catch(() => {});
  demoSite.stop(true);
  if (fallbackPigeon) fallbackPigeon.stop(true);
  if (pigeonProc) {
    try { pigeonProc.kill(); } catch {}
  }
  srv.stop();
  rmSync(TMP, { recursive: true, force: true });
  rmSync(DEMO_REPOS, { recursive: true, force: true });
}
