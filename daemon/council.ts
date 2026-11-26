import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AttachmentRecord, ElementChip, SessionRecord } from "./db";
import type { PigeonTabContext } from "./pigeon-bridge";
import { toTildePath } from "./url-repo";

export type CouncilLaneId = "gemini" | "claude" | "codex" | "kimi";

export interface CouncilLaneSpec {
  id: CouncilLaneId;
  company: string;
  label: string;
  accent: string;
  resolveBin: () => string;
}

export interface CouncilVerdict {
  id: CouncilLaneId;
  company: string;
  label: string;
  accent: string;
  ok: boolean;
  text: string;
  error?: string;
  durationMs: number;
}

export interface CouncilSynthesis {
  markdown: string;
  recommendedPrompt: string;
}

const HOME = homedir();

export const COUNCIL_LANES: CouncilLaneSpec[] = [
  {
    id: "gemini",
    company: "Google",
    label: "Gemini 4 · Carbon",
    accent: "#1E4E8C",
    resolveBin: () => process.env.AGY_BIN || join(HOME, ".local", "bin", "agy"),
  },
  {
    id: "claude",
    company: "Anthropic",
    label: "Claude · Opus",
    accent: "#A23B17",
    resolveBin: () => process.env.CLAUDE_BIN || join(HOME, ".local", "bin", "claude"),
  },
  {
    id: "codex",
    company: "OpenAI",
    label: "Codex · GPT-6.2 Sol",
    accent: "#146A43",
    resolveBin: () => process.env.CODEX_BIN || join(HOME, ".local", "bin", "codex"),
  },
  {
    id: "kimi",
    company: "Moonshot",
    label: "Kimi · K3.1 Pro",
    accent: "#6B3FA0",
    resolveBin: () => process.env.KIMI_BIN || join(HOME, ".kimi-code", "bin", "kimi"),
  },
];

const LANE_ALIASES: Record<string, CouncilLaneId> = {
  gemini: "gemini",
  agy: "gemini",
  carbon: "gemini",
  neon: "gemini",
  claude: "claude",
  opus: "claude",
  sonnet: "claude",
  codex: "codex",
  sol: "codex",
  openai: "codex",
  kimi: "kimi",
  k3: "kimi",
  k31: "kimi",
  moonshot: "kimi",
};

export function parseCouncilCommand(raw: string): {
  isCouncil: boolean;
  lanes: CouncilLaneId[] | null;
  question: string;
} {
  const trimmed = raw.trim();
  if (!/^\/council(?:\s|$)/i.test(trimmed)) {
    return { isCouncil: false, lanes: null, question: "" };
  }
  const rest = trimmed.replace(/^\/council\s*/i, "").trim();
  if (!rest) return { isCouncil: true, lanes: null, question: "" };

  const pipeIdx = rest.indexOf("|");
  if (pipeIdx > 0 && pipeIdx < 48) {
    const left = rest.slice(0, pipeIdx).trim();
    const right = rest.slice(pipeIdx + 1).trim();
    const tokens = left
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const parsed = Array.from(new Set(tokens.map((t) => LANE_ALIASES[t]).filter(Boolean))) as CouncilLaneId[];
    if (parsed.length > 0 && right) {
      return { isCouncil: true, lanes: parsed, question: right };
    }
  }
  return { isCouncil: true, lanes: null, question: rest };
}

export function buildCouncilPrompt(opts: {
  question: string;
  session: SessionRecord;
  chips: ElementChip[];
  attachments: AttachmentRecord[];
  pigeonContext?: PigeonTabContext | null;
  pigeonMessages?: Array<{ sender: string; time: string; text: string }>;
}): string {
  const lines: string[] = [];
  lines.push("You are one independent councillor on a multi-company Frontier Council.");
  lines.push("Answer ALONE with zero deference. Be candid, concrete, and concise (max ~220 words).");
  lines.push("Label real/measured facts vs estimates. Do not edit files or run destructive commands.");
  lines.push("");
  lines.push("[Context]");
  if (opts.session.lastUrl) lines.push(`- Active Tab URL: ${opts.session.lastUrl}`);
  if (opts.session.pageTitle) lines.push(`- Page Title: ${opts.session.pageTitle}`);
  lines.push(`- Linked Workspace: ${opts.session.repoName} (${toTildePath(opts.session.repoPath)})`);

  if (opts.pigeonContext?.isPigeonHole && opts.pigeonContext.activeCubby) {
    const c = opts.pigeonContext.activeCubby;
    lines.push(`- Pigeon-Hole Cubby: ${c.name} (${c.id}, state: ${c.state}, model: ${c.family}·${c.model}·${c.effort}, repo: ${c.displayPath})`);
    if (opts.pigeonMessages && opts.pigeonMessages.length > 0) {
      lines.push("- Recent Pigeon-Hole Messages:");
      for (const m of opts.pigeonMessages.slice(-6)) {
        const txt = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 320);
        lines.push(`  * [${m.sender}] ${txt}`);
      }
    }
  }
  if (opts.chips.length > 0) {
    lines.push("- Pinned Page Notes / Elements:");
    for (const c of opts.chips) {
      lines.push(`  * ${c.label} (${c.selector})${c.note ? ` — Note: ${JSON.stringify(c.note)}` : ""}`);
    }
  }
  if (opts.attachments.length > 0) {
    lines.push("- Attached Screenshot(s) (inspect if supported):");
    for (const a of opts.attachments) {
      lines.push(`  * ${a.path} (${a.name})`);
    }
  }
  lines.push("");
  lines.push("[Question for the Council]");
  lines.push(opts.question);
  lines.push("");
  lines.push("Reply in exactly these 3 short sections:");
  lines.push("1. **Verdict:** your direct recommendation");
  lines.push("2. **Blind spot / risk:** the sharpest counter-argument or failure mode");
  lines.push("3. **Next concrete step:** exact next prompt or action");
  return lines.join("\n");
}

function parseAgyFinalOutput(stdout: string): { text: string; error?: string } {
  let acc = "";
  let resText = "";
  let resErr = "";
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    try {
      const ev = JSON.parse(line);
      if (ev.event === "step_update" && ev.step_update?.step_type === "agent_response" && typeof ev.step_update.text_delta === "string") {
        acc += ev.step_update.text_delta;
      } else if (ev.event === "result" && ev.result) {
        if (typeof ev.result.response === "string" && ev.result.response.trim()) resText = ev.result.response.trim();
        if (ev.result.error) resErr = typeof ev.result.error === "string" ? ev.result.error : JSON.stringify(ev.result.error);
      }
    } catch {}
  }
  const text = (resText.length > acc.trim().length ? resText : acc.trim()).trim();
  return { text, error: resErr || undefined };
}

function parseClaudeFinalOutput(stdout: string): { text: string; error?: string } {
  let acc = "";
  let resText = "";
  let resErr = "";
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
        acc += ev.event.delta.text;
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        const joined = ev.message.content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n\n")
          .trim();
        if (joined.length > acc.trim().length) acc = joined;
      } else if (ev.type === "result") {
        if (ev.is_error) resErr = String(ev.result || ev.error || "Claude error");
        else if (typeof ev.result === "string" && ev.result.trim()) resText = ev.result.trim();
      }
    } catch {}
  }
  const text = (resText.length > acc.trim().length ? resText : acc.trim()).trim();
  return { text, error: resErr || undefined };
}

async function runSingleCouncillor(
  lane: CouncilLaneSpec,
  prompt: string,
  opts: {
    cwd: string;
    attachmentsDir: string;
    attachments: AttachmentRecord[];
    timeoutMs: number;
    signal?: AbortSignal;
  }
): Promise<CouncilVerdict> {
  const started = Date.now();
  const bin = lane.resolveBin();
  if (!existsSync(bin)) {
    return {
      id: lane.id,
      company: lane.company,
      label: lane.label,
      accent: lane.accent,
      ok: false,
      text: "",
      error: `CLI not installed at ${bin}`,
      durationMs: Date.now() - started,
    };
  }

  let codexOutFile = "";
  let args: string[];
  if (lane.id === "gemini") {
    const model = process.env.TAB_AGENT_COUNCIL_GEMINI_MODEL || "gemini-4-carbon-high";
    args = [
      bin,
      `--print=${prompt}`,
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--mode",
      "read-only",
      "--dangerously-skip-permissions",
    ];
  } else if (lane.id === "claude") {
    const model = process.env.TAB_AGENT_COUNCIL_CLAUDE_MODEL || "opus";
    const addDirs = Array.from(
      new Set([opts.attachmentsDir, ...opts.attachments.map((a) => (a.path ? dirname(a.path) : "")).filter(Boolean)])
    );
    args = [
      bin,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      ...(addDirs.length ? ["--add-dir", ...addDirs] : []),
      "--allowedTools",
      "Read",
      "--model",
      model,
      "--effort",
      "high",
      "-p",
      prompt,
    ];
  } else if (lane.id === "codex") {
    codexOutFile = join(tmpdir(), `ta-council-codex-${randomUUID().slice(0, 8)}.txt`);
    const imgArgs = opts.attachments.flatMap((a) => (a.path && existsSync(a.path) ? ["-i", a.path] : []));
    args = [
      bin,
      "exec",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      opts.cwd,
      "-o",
      codexOutFile,
      ...imgArgs,
      prompt,
    ];
  } else {
    args = [bin, "-p", prompt, "--output-format", "text"];
  }

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    try { proc?.kill(); } catch {}
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    proc = Bun.spawn(args, {
      cwd: opts.cwd,
      env: process.env as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc?.kill(); } catch {}
    }, opts.timeoutMs);

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (aborted) {
      return {
        id: lane.id,
        company: lane.company,
        label: lane.label,
        accent: lane.accent,
        ok: false,
        text: "",
        error: "Cancelled",
        durationMs: Date.now() - started,
      };
    }

    let text = "";
    let err = "";
    if (lane.id === "gemini") {
      const parsed = parseAgyFinalOutput(stdout);
      text = parsed.text || stdout.trim();
      err = parsed.error || "";
    } else if (lane.id === "claude") {
      const parsed = parseClaudeFinalOutput(stdout);
      text = parsed.text || stdout.trim();
      err = parsed.error || "";
    } else if (lane.id === "codex") {
      if (codexOutFile && existsSync(codexOutFile)) {
        text = readFileSync(codexOutFile, "utf8").trim();
      }
      if (!text) text = stdout.trim();
    } else {
      text = stdout.trim();
    }

    if (timedOut && !text) {
      err = `Timed out after ${Math.round(opts.timeoutMs / 1000)}s`;
    } else if (!text && code !== 0) {
      err = stderr.trim().slice(0, 300) || `Exited with code ${code}`;
    } else if (!text && !err) {
      err = "Empty response";
    }

    return {
      id: lane.id,
      company: lane.company,
      label: lane.label,
      accent: lane.accent,
      ok: Boolean(text) && !err,
      text,
      error: err || undefined,
      durationMs: Date.now() - started,
    };
  } catch (e: any) {
    return {
      id: lane.id,
      company: lane.company,
      label: lane.label,
      accent: lane.accent,
      ok: false,
      text: "",
      error: e?.message || String(e),
      durationMs: Date.now() - started,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (codexOutFile) {
      try { rmSync(codexOutFile, { force: true }); } catch {}
    }
  }
}

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function simpleMdToHtml(md: string): string {
  const escaped = escapeHtml(md);
  return escaped
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>")
    .replace(/<\/ul>\s*<ul>/g, "")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br/>");
}

export function buildFallbackSynthesis(question: string, verdicts: CouncilVerdict[]): CouncilSynthesis {
  const okOnes = verdicts.filter((v) => v.ok);
  if (okOnes.length === 0) {
    return {
      markdown: `### Council Summary\nNo councillor returned a verdict (${verdicts.map((v) => `${v.label}: ${v.error || "failed"}`).join("; ")}).`,
      recommendedPrompt: "",
    };
  }
  const bullets = okOnes
    .map((v) => {
      const firstLine = v.text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)[0] || v.text.slice(0, 180);
      return `- **${v.label}** (${(v.durationMs / 1000).toFixed(1)}s): ${firstLine.slice(0, 220)}`;
    })
    .join("\n");
  const failed = verdicts.filter((v) => !v.ok);
  const failLine = failed.length
    ? `\n\n*Unavailable:* ${failed.map((v) => `${v.label} (${v.error || "failed"})`).join(", ")}`
    : "";

  // Extract a clean next-action prompt candidate from the first successful verdict
  let nextPrompt = "";
  for (const v of okOnes) {
    const m = v.text.match(/(?:next concrete step|next action|recommended prompt)[:*\s]+([\s\S]{15,500})/i);
    if (m && m[1]) {
      nextPrompt = m[1].trim().replace(/\n+/g, " ").slice(0, 420);
      break;
    }
  }
  if (!nextPrompt) {
    nextPrompt = `Based on our Frontier Council on "${question.slice(0, 100)}", proceed with the consensus plan and verify against our pass/kill bar.`;
  }

  return {
    markdown: `### Council Verdicts (${okOnes.length}/${verdicts.length})\n${bullets}${failLine}`,
    recommendedPrompt: nextPrompt,
  };
}

export function renderCouncilDossierHtml(opts: {
  question: string;
  session: SessionRecord;
  pigeonCubbyName?: string;
  verdicts: CouncilVerdict[];
  synthesisMarkdown: string;
  recommendedPrompt?: string;
  createdAt: number;
}): string {
  const dt = new Date(opts.createdAt).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const okCount = opts.verdicts.filter((v) => v.ok).length;
  const cardsHtml = opts.verdicts
    .map((v) => {
      const sec = (v.durationMs / 1000).toFixed(1) + "s";
      const body = v.ok
        ? `<div class="card-body"><p>${simpleMdToHtml(v.text)}</p></div>`
        : `<div class="card-err">Failed: ${escapeHtml(v.error || "Unknown error")}</div>`;
      return `<article class="card" style="--lane:${escapeHtml(v.accent)}">
        <header class="card-head">
          <div>
            <span class="company">${escapeHtml(v.company)}</span>
            <h3>${escapeHtml(v.label)}</h3>
          </div>
          <span class="badge ${v.ok ? "ok" : "err"}">${v.ok ? sec : "Failed"}</span>
        </header>
        ${body}
      </article>`;
    })
    .join("\n");

  const relayBlock = opts.recommendedPrompt
    ? `<div class="prompt-box">
        <div class="prompt-label">Recommended Next Prompt (staged in Tab-Agent)</div>
        <pre>${escapeHtml(opts.recommendedPrompt)}</pre>
      </div>`
    : "";

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Frontier Council · ${escapeHtml(opts.question.slice(0, 60))}</title>
<style>
  :root {
    --bg: #F4EFE4;
    --paper: #FAF7F0;
    --ink: #1F1D1A;
    --ink-2: #585249;
    --rule: #DDD4C3;
    --accent: #1E4E8C;
    --warn: #A23B17;
    --good: #146A43;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.58 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 28px 20px 64px;
  }
  .wrap { max-width: 1120px; margin: 0 auto; display: grid; gap: 20px; }
  .hero {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--accent);
    border-radius: 12px;
    padding: 20px 24px;
  }
  .kicker {
    font: 700 11px/1 ui-monospace, Menlo, monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
    margin-bottom: 8px;
  }
  h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.3; }
  .meta {
    display: flex; flex-wrap: wrap; gap: 10px;
    font: 500 12px ui-monospace, Menlo, monospace;
    color: var(--ink-2);
  }
  .pill {
    background: #EFE8D8;
    border: 1px solid var(--rule);
    padding: 2px 9px;
    border-radius: 999px;
  }
  .chair {
    background: #FFFDF8;
    border: 1.5px solid var(--accent);
    border-radius: 12px;
    padding: 18px 22px;
  }
  .chair h2 { margin: 0 0 8px; font-size: 16px; color: var(--accent); }
  .chair h3, .chair h4 { margin: 12px 0 6px; font-size: 14.5px; }
  .chair p { margin: 6px 0; }
  .chair ul { margin: 6px 0 6px 18px; padding: 0; }
  .prompt-box {
    margin-top: 14px;
    background: #FBF4E4;
    border: 1px solid #D9B77B;
    border-radius: 8px;
    padding: 10px 12px;
  }
  .prompt-label {
    font: 700 11px ui-monospace, Menlo, monospace;
    text-transform: uppercase;
    color: #8B5E1A;
    margin-bottom: 5px;
  }
  .prompt-box pre {
    margin: 0;
    white-space: pre-wrap;
    font: 13px/1.45 ui-monospace, Menlo, monospace;
    color: var(--ink);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 16px;
  }
  .card {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-top: 4px solid var(--lane, var(--accent));
    border-radius: 12px;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card-head {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
    border-bottom: 1px solid var(--rule); padding-bottom: 10px;
  }
  .company {
    display: block;
    font: 700 10.5px ui-monospace, Menlo, monospace;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--lane, var(--ink-2));
  }
  .card-head h3 { margin: 3px 0 0; font-size: 16px; }
  .badge {
    font: 700 11px ui-monospace, Menlo, monospace;
    padding: 3px 8px; border-radius: 999px;
  }
  .badge.ok { background: #E3F3EA; color: var(--good); }
  .badge.err { background: #FBE9E2; color: var(--warn); }
  .card-body p { margin: 6px 0; }
  .card-body ul { margin: 6px 0 6px 18px; padding: 0; }
  .card-body code { background: #EFE8D8; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  .card-err { color: var(--warn); font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
</style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div class="kicker">Tab-Agent Frontier Council &middot; ${okCount}/${opts.verdicts.length} Independent Verdicts</div>
    <h1>${escapeHtml(opts.question)}</h1>
    <div class="meta">
      <span class="pill">${escapeHtml(dt)}</span>
      <span class="pill">Repo: ${escapeHtml(opts.session.repoName)}</span>
      ${opts.pigeonCubbyName ? `<span class="pill">Pigeon-Hole: ${escapeHtml(opts.pigeonCubbyName)}</span>` : ""}
      ${opts.session.lastUrl ? `<span class="pill">${escapeHtml(opts.session.lastUrl.slice(0, 80))}</span>` : ""}
    </div>
  </section>

  <section class="chair">
    <h2>Chair Synthesis</h2>
    <div><p>${simpleMdToHtml(opts.synthesisMarkdown)}</p></div>
    ${relayBlock}
  </section>

  <section class="grid">
    ${cardsHtml}
  </section>
</div>
</body>
</html>`;
}

export async function runCouncil(opts: {
  question: string;
  requestedLanes: CouncilLaneId[] | null;
  session: SessionRecord;
  cwd: string;
  attachmentsDir: string;
  councilDir: string;
  chips: ElementChip[];
  attachments: AttachmentRecord[];
  pigeonContext?: PigeonTabContext | null;
  pigeonMessages?: Array<{ sender: string; time: string; text: string }>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number, summary: string) => void;
  onLaneDone?: (verdict: CouncilVerdict) => void;
}): Promise<{
  verdicts: CouncilVerdict[];
  synthesis: CouncilSynthesis;
  dossierPath: string;
  dossierUrl: string;
}> {
  const selectedIds: CouncilLaneId[] =
    opts.requestedLanes && opts.requestedLanes.length > 0
      ? opts.requestedLanes
      : COUNCIL_LANES.filter((l) => existsSync(l.resolveBin())).map((l) => l.id);

  const lanes = selectedIds
    .map((id) => COUNCIL_LANES.find((l) => l.id === id))
    .filter((l): l is CouncilLaneSpec => Boolean(l));

  if (lanes.length === 0) {
    throw new Error("No council CLI lanes installed (checked agy, claude, codex, kimi).");
  }

  const prompt = buildCouncilPrompt({
    question: opts.question,
    session: opts.session,
    chips: opts.chips,
    attachments: opts.attachments,
    pigeonContext: opts.pigeonContext,
    pigeonMessages: opts.pigeonMessages,
  });

  const timeoutMs = opts.timeoutMs ?? Number(process.env.TAB_AGENT_COUNCIL_TIMEOUT_MS || 120_000);
  const doneMap = new Map<CouncilLaneId, CouncilVerdict>();
  const statusLine = () => {
    const parts = lanes.map((l) => {
      const v = doneMap.get(l.id);
      if (!v) return `${l.id}…`;
      return v.ok ? `${l.id} ✓` : `${l.id} ✕`;
    });
    return `Council ${doneMap.size}/${lanes.length} · ${parts.join(" · ")}`;
  };
  opts.onProgress?.(0, lanes.length, statusLine());

  const verdicts = await Promise.all(
    lanes.map(async (lane) => {
      const v = await runSingleCouncillor(lane, prompt, {
        cwd: opts.cwd,
        attachmentsDir: opts.attachmentsDir,
        attachments: opts.attachments,
        timeoutMs,
        signal: opts.signal,
      });
      doneMap.set(lane.id, v);
      opts.onLaneDone?.(v);
      opts.onProgress?.(doneMap.size, lanes.length, statusLine());
      return v;
    })
  );

  const synthesis = buildFallbackSynthesis(opts.question, verdicts);

  mkdirSync(opts.councilDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = opts.question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "council";
  const dossierPath = join(opts.councilDir, `${stamp}-${slug}-${randomUUID().slice(0, 4)}.html`);
  const html = renderCouncilDossierHtml({
    question: opts.question,
    session: opts.session,
    pigeonCubbyName: opts.pigeonContext?.activeCubby?.name,
    verdicts,
    synthesisMarkdown: synthesis.markdown,
    recommendedPrompt: opts.pigeonContext?.isPigeonHole ? synthesis.recommendedPrompt : undefined,
    createdAt: Date.now(),
  });
  writeFileSync(dossierPath, html, "utf8");

  return {
    verdicts,
    synthesis,
    dossierPath,
    dossierUrl: `file://${dossierPath}`,
  };
}
