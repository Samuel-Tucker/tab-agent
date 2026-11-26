import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAttachmentsDir } from "./attachments";
import { parseCouncilCommand, runCouncil } from "./council";
import type { AttachmentRecord, ElementChip, SessionRecord, TabAgentStore } from "./db";
import { nowTimeShort } from "./db";
import type { PigeonBridge, PigeonTabContext } from "./pigeon-bridge";
import { toTildePath } from "./url-repo";

export interface HarnessSpec {
  id: string;
  family: "AGY" | "CLAUDE";
  label: string;
  model: string;
  aliases: string[];
  runner: "agy" | "claude";
  baseModel: string;
  efforts: string[];
  defaultEffort: string;
}

export const HARNESS_CATALOGUE: HarnessSpec[] = [
  {
    id: "agy-neon",
    family: "AGY",
    label: "AGY · Neon",
    model: "NEON",
    aliases: ["neon", "agy", "agy-neon", "gemini-4-neon"],
    runner: "agy",
    baseModel: "gemini-4-neon",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "low",
  },
  {
    id: "agy-carbon",
    family: "AGY",
    label: "AGY · Carbon",
    model: "CARBON",
    aliases: ["carbon", "agy-carbon", "gemini-4-carbon"],
    runner: "agy",
    baseModel: "gemini-4-carbon",
    efforts: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "agy-argon",
    family: "AGY",
    label: "AGY · Argon",
    model: "ARGON",
    aliases: ["argon", "agy-argon", "gemini-4-argon"],
    runner: "agy",
    baseModel: "gemini-4-argon",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "agy-hydrogen",
    family: "AGY",
    label: "AGY · Hydrogen",
    model: "HYDROGEN",
    aliases: ["hydrogen", "agy-hydrogen", "gemini-4-hydrogen"],
    runner: "agy",
    baseModel: "gemini-4-hydrogen",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
  },
  {
    id: "claude-opus",
    family: "CLAUDE",
    label: "Claude · Opus",
    model: "OPUS",
    aliases: ["opus", "claude-opus", "claude"],
    runner: "claude",
    baseModel: "opus",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "claude-sonnet",
    family: "CLAUDE",
    label: "Claude · Sonnet",
    model: "SONNET",
    aliases: ["sonnet", "claude-sonnet"],
    runner: "claude",
    baseModel: "sonnet",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "claude-haiku",
    family: "CLAUDE",
    label: "Claude · Haiku",
    model: "HAIKU",
    aliases: ["haiku", "claude-haiku"],
    runner: "claude",
    baseModel: "haiku",
    efforts: ["low", "medium", "high"],
    defaultEffort: "low",
  },
];

export function getDefaultHarnessId(): string {
  if (process.env.TAB_AGENT_DEFAULT_HARNESS) {
    return getHarnessSpec(process.env.TAB_AGENT_DEFAULT_HARNESS).id;
  }
  if (existsSync(agyBin())) return "agy-neon";
  if (existsSync(claudeBin())) return "claude-sonnet";
  return "claude-sonnet";
}

export function getHarnessSpec(id: string): HarnessSpec {
  return HARNESS_CATALOGUE.find((h) => h.id === id) || HARNESS_CATALOGUE[0];
}

export function findHarnessByQuery(q: string): HarnessSpec | null {
  const norm = q.trim().toLowerCase();
  if (!norm) return null;
  return (
    HARNESS_CATALOGUE.find(
      (h) =>
        h.id.toLowerCase() === norm ||
        h.model.toLowerCase() === norm ||
        h.baseModel.toLowerCase() === norm ||
        h.aliases.includes(norm)
    ) ||
    HARNESS_CATALOGUE.find(
      (h) =>
        h.id.toLowerCase().includes(norm) ||
        h.model.toLowerCase().includes(norm) ||
        h.aliases.some((a) => a.includes(norm))
    ) ||
    null
  );
}

export function normalizeEffort(spec: HarnessSpec, requested?: string): string {
  if (!requested) return spec.defaultEffort;
  const clean = requested.trim().toLowerCase();
  if (spec.efforts.includes(clean)) return clean;
  if (clean === "med" && spec.efforts.includes("medium")) return "medium";
  if (clean === "max" && !spec.efforts.includes("max")) return spec.efforts[spec.efforts.length - 1];
  if (clean === "xhigh" && !spec.efforts.includes("xhigh")) {
    return spec.efforts.includes("high") ? "high" : spec.efforts[spec.efforts.length - 1];
  }
  return spec.defaultEffort;
}

export function safeSnippet(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#>*_`]/g, "")
    .trim();
  if (!clean) return "Turn finished.";
  const paras = clean
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const last = paras[paras.length - 1] || clean;
  return last.length > 160 ? last.slice(0, 157) + "…" : last;
}

export function buildTabContextEnvelope(
  session: SessionRecord,
  promptText: string,
  chips: ElementChip[] = [],
  opts: {
    isFirstTurn?: boolean;
    urlChanged?: boolean;
    attachments?: AttachmentRecord[];
    pigeonContext?: PigeonTabContext | null;
  } = {}
): string {
  const lines: string[] = [];
  lines.push("[Tab-Agent Browser Context]");
  if (session.lastUrl) lines.push(`- Active Tab URL: ${session.lastUrl}`);
  if (session.pageTitle) lines.push(`- Page Title: ${session.pageTitle}`);
  lines.push(`- Linked Workspace: ${session.repoName} (${toTildePath(session.repoPath)}, source: ${session.repoSource})`);
  lines.push(
    session.pageAccess
      ? "- Page Inspection (See Page): ENABLED — you may call tab-agent MCP tools (tab_dom, tab_console, tab_network, tab_snapshot, tab_screenshot, tab_eval, tab_click, tab_type, tab_fill, tab_reload)."
      : "- Page Inspection (See Page): OFF — you know the URL/title above, but live DOM/DevTools inspection is gated off until the user clicks 'See Page' (⌘.) in the sidebar."
  );
  lines.push(
    "- Peer Sessions: Other Tab-Agent tabs can be found and talked to by repo name without the user acting as middle-man via `tab-peer list [query]`, `tab-peer read <repo>`, and `tab-peer send <repo> \"<message>\"` (waits for their reply by default; Claude also has peer_list / peer_read / peer_send MCP tools)."
  );
  if (opts.urlChanged) {
    lines.push("- Note: The tab navigated to this URL since the previous turn.");
  }
  const pc = opts.pigeonContext;
  if (pc && pc.isPigeonHole) {
    lines.push("[Pigeon-Hole Target]");
    if (!pc.online) {
      lines.push(`- Pigeon-Hole on ${pc.baseUrl} is currently offline.`);
    } else if (pc.activeCubby) {
      const c = pc.activeCubby;
      lines.push(
        `- Open Cubby: ${c.name} (id: ${c.id}, state: ${c.state}, model: ${c.family} · ${c.model} · ${c.effort}, repo: ${c.displayPath}, queued: ${c.queuedCount}${c.steerState ? `, steer: ${c.steerState}` : ""})`
      );
    } else {
      const list = pc.cubbies.map((c) => `${c.name} (${c.id}, ${c.state})`).join(", ") || "none";
      lines.push(`- Pigeon-Hole Board (no cubby selected in URL). Active cubbies: ${list}`);
    }
    lines.push(
      `- Relay Mode: ${session.pigeonRelayMode} — you may call pigeon_status (read-only, includes last 6 messages), pigeon_send(text, mode="queue"|"steer"|"send"), and pigeon_watch(instruction, targetSessionId?) to arm an /after wake-up when a cubby finishes its turn (all work with See Page OFF).`
    );
  }
  if (chips.length > 0) {
    const pinnedChips = chips.filter((c) => typeof c.note === "string" || typeof c.pinIndex === "number");
    const plainChips = chips.filter((c) => typeof c.note !== "string" && typeof c.pinIndex !== "number");
    if (pinnedChips.length > 0) {
      lines.push("- Pinned Page Notes (clicked elements on the live tab):");
      pinnedChips.forEach((c, idx) => {
        const num = c.pinIndex || idx + 1;
        const rectPart = c.rect ? `, rect: ${c.rect.width}×${c.rect.height} at (${c.rect.x},${c.rect.y})` : "";
        const notePart = c.note?.trim() ? ` — Note: ${JSON.stringify(c.note.trim())}` : "";
        const cropPart = c.attachmentName ? ` [crop: ${c.attachmentName}]` : "";
        const snippet = c.text ? ` text=${JSON.stringify(c.text.slice(0, 140))}` : "";
        const htmlPart = c.html ? ` html=${JSON.stringify(c.html.slice(0, 260))}` : "";
        lines.push(
          `  * Pin #${num}: ${c.label} (selector: \`${c.selector}\`${c.xpath ? `, xpath: \`${c.xpath}\`` : ""}${rectPart})${notePart}${cropPart}${snippet}${htmlPart}`
        );
      });
    }
    if (plainChips.length > 0) {
      lines.push("- Selected Page Elements:");
      for (const c of plainChips) {
        const snippet = c.text ? ` text=${JSON.stringify(c.text.slice(0, 140))}` : "";
        const htmlPart = c.html ? ` html=${JSON.stringify(c.html.slice(0, 260))}` : "";
        lines.push(`  * ${c.label} (selector: \`${c.selector}\`${c.xpath ? `, xpath: \`${c.xpath}\`` : ""}${snippet}${htmlPart})`);
      }
    }
  }
  const attachments = opts.attachments || [];
  if (attachments.length > 0) {
    const toolHint = session.family === "CLAUDE" ? "the Read tool" : "read_file";
    lines.push(`- Attached Image(s) saved locally — inspect them with ${toolHint}:`);
    for (const a of attachments) {
      lines.push(`  * ${a.path} (${a.name}, ${a.mimeType})`);
    }
  }
  const hasPinnedNotes = chips.some((c) => Boolean(c.note?.trim()));
  const cleanBody =
    promptText.trim() ||
    (hasPinnedNotes
      ? "Please address the pinned page note(s) above."
      : "Please inspect the attached image(s).");
  return `${lines.join("\n")}\n\n${cleanBody}`;
}

/* =========================================================================
   AGY STREAM-JSON PARSER
   ========================================================================= */
export interface AgyStreamState {
  conversationId: string | null;
  accumulated: string;
  seenToolSteps: Set<number>;
  resultError: string | null;
}

export function createAgyStreamState(): AgyStreamState {
  return {
    conversationId: null,
    accumulated: "",
    seenToolSteps: new Set<number>(),
    resultError: null,
  };
}

export interface ParsedStreamStep {
  providerSessionId?: string;
  fullText?: string;
  isResult?: boolean;
  events: Array<{ kind: string; summary: string }>;
}

function truncate(s: string, max = 72): string {
  const c = s.replace(/\s+/g, " ").trim();
  return c.length <= max ? c : c.slice(0, max - 1) + "…";
}

function extractToolTarget(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const p = params as Record<string, unknown>;
  for (const k of ["Path", "path", "file_path", "CommandLine", "command", "selector", "url", "expression", "query"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return truncate(v, 68);
  }
  return "";
}

export function parseAgyStreamLine(line: string, state: AgyStreamState): ParsedStreamStep | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  let ev: any;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const events: Array<{ kind: string; summary: string }> = [];
  let providerSessionId: string | undefined;
  let fullText: string | undefined;

  if (ev.event === "init") {
    if (ev.conversation_id) {
      state.conversationId = String(ev.conversation_id);
      providerSessionId = state.conversationId;
    }
    events.push({
      kind: "init",
      summary: `AGY conv ${(state.conversationId || "init").slice(0, 8)}`,
    });
    return { providerSessionId, events };
  }

  if (ev.event === "step_update" && ev.step_update && typeof ev.step_update === "object") {
    const su = ev.step_update;
    if (su.step_type === "agent_response" && typeof su.text_delta === "string" && su.text_delta) {
      state.accumulated += su.text_delta;
      fullText = state.accumulated;
    } else if (su.step_type === "tool") {
      const idx = typeof su.step_index === "number" ? su.step_index : -1;
      if (idx < 0 || !state.seenToolSteps.has(idx)) {
        if (idx >= 0) state.seenToolSteps.add(idx);
        const name = su.tool_name || su.tool_info?.name || "tool";
        const target = extractToolTarget(su.tool_info?.parameters);
        events.push({
          kind: "tool",
          summary: target ? `${name}: ${target}` : String(name),
        });
      }
    }
    return { fullText, events };
  }

  if (ev.event === "result" && ev.result && typeof ev.result === "object") {
    const res = ev.result;
    if (typeof res.conversation_id === "string" && res.conversation_id) {
      state.conversationId = res.conversation_id;
      providerSessionId = res.conversation_id;
    }
    if (typeof res.response === "string" && res.response.trim()) {
      const t = res.response.trim();
      if (t.length > state.accumulated.trim().length) {
        state.accumulated = t;
        fullText = t;
      }
    }
    if (res.error) {
      state.resultError =
        typeof res.error === "string" ? res.error : String(res.error?.message || JSON.stringify(res.error));
      events.push({ kind: "error", summary: `AGY error: ${state.resultError}` });
    }
    const tok = res.usage?.total_tokens;
    events.push({
      kind: "result",
      summary: `Done${typeof tok === "number" ? ` · ${tok} tok` : ""}`,
    });
    return { providerSessionId, fullText, isResult: true, events };
  }

  return null;
}

/* =========================================================================
   CLAUDE CODE STREAM-JSON PARSER
   ========================================================================= */
export interface ClaudeStreamState {
  sessionId: string | null;
  accumulated: string;
  seenTools: Set<string>;
  resultError: string | null;
}

export function createClaudeStreamState(): ClaudeStreamState {
  return {
    sessionId: null,
    accumulated: "",
    seenTools: new Set<string>(),
    resultError: null,
  };
}

export function parseClaudeStreamLine(line: string, state: ClaudeStreamState): ParsedStreamStep | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  let ev: any;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const events: Array<{ kind: string; summary: string }> = [];
  let providerSessionId: string | undefined;
  let fullText: string | undefined;

  if (typeof ev.session_id === "string" && ev.session_id && ev.session_id !== state.sessionId) {
    state.sessionId = ev.session_id;
    providerSessionId = ev.session_id;
  }

  if (ev.type === "system" && ev.subtype === "init") {
    events.push({
      kind: "init",
      summary: `Claude session ${(state.sessionId || "init").slice(0, 8)}`,
    });
    return { providerSessionId, events };
  }

  // Incremental partial stream events (--include-partial-messages)
  if (ev.type === "stream_event" && ev.event) {
    const inner = ev.event;
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
      state.accumulated += inner.delta.text;
      fullText = state.accumulated;
      return { providerSessionId, fullText, events };
    }
    if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
      const tid = String(inner.content_block.id || inner.content_block.name || "");
      const tname = String(inner.content_block.name || "tool");
      if (tid && !state.seenTools.has(tid)) {
        state.seenTools.add(tid);
        events.push({ kind: "tool", summary: tname });
      }
      return { providerSessionId, events };
    }
  }

  // Complete assistant message blocks (captures tool inputs + full text if partial events were absent)
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    let textParts: string[] = [];
    for (const block of ev.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block?.type === "tool_use") {
        const tid = String(block.id || `${block.name}-${Math.random()}`);
        const target = extractToolTarget(block.input);
        if (!state.seenTools.has(tid)) {
          state.seenTools.add(tid);
          events.push({
            kind: "tool",
            summary: target ? `${block.name}: ${target}` : String(block.name || "tool"),
          });
        }
      }
    }
    const joined = textParts.join("\n\n").trim();
    if (joined && joined.length > state.accumulated.trim().length) {
      state.accumulated = joined;
      fullText = joined;
    }
    return { providerSessionId, fullText, events };
  }

  if (ev.type === "result") {
    if (ev.is_error) {
      state.resultError = String(ev.result || ev.error || "Claude CLI error");
      events.push({ kind: "error", summary: `Claude error: ${state.resultError}` });
    } else if (typeof ev.result === "string" && ev.result.trim()) {
      const t = ev.result.trim();
      if (t.length > state.accumulated.trim().length) {
        state.accumulated = t;
        fullText = t;
      }
    }
    const cost = typeof ev.total_cost_usd === "number" ? ` · $${ev.total_cost_usd.toFixed(4)}` : "";
    events.push({ kind: "result", summary: `Done${cost}` });
    return { providerSessionId, fullText, isResult: true, events };
  }

  return providerSessionId ? { providerSessionId, events } : null;
}

/* =========================================================================
   RUNNER CLASS
   ========================================================================= */
export type BroadcastFn = (payload: Record<string, unknown>) => void;

export interface RunStatus {
  activeAgentMessageId: number;
  startedAt: number;
  lastActivityAt: number;
  phase: "starting" | "thinking" | "tool" | "streaming";
  currentStep: string;
  stepCount: number;
  queuedCount: number;
}

interface ActiveRun {
  abort: () => void;
  agentMsgId: number;
  getAccumulated: () => string;
  startedAt: number;
  lastActivityAt: number;
  phase: "starting" | "thinking" | "tool" | "streaming";
  currentStep: string;
  stepCount: number;
}

const HOME = homedir();
// Read at spawn time so tests (and a changed install) can point at another binary.
const agyBin = () => process.env.AGY_BIN || join(HOME, ".local", "bin", "agy");
const claudeBin = () => process.env.CLAUDE_BIN || join(HOME, ".local", "bin", "claude");

/** A turn whose CLI prints nothing for this long is treated as stuck and stopped (env TAB_AGENT_STALL_MIN). */
export const DEFAULT_STALL_MS = Math.max(1, Number(process.env.TAB_AGENT_STALL_MIN || 30)) * 60_000;
const MCP_BRIDGE_PATH = join(import.meta.dir, "mcp-tab-bridge.mjs");
const TAB_AGENT_BIN_DIR = join(import.meta.dir, "..", "bin");

async function readNdjson(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const drain = () => {
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    drain();
  }
  buf += dec.decode();
  drain();
  if (buf.trim()) onLine(buf.trim());
}

export function buildClaudeSpawnArgs(opts: {
  bin: string;
  prompt: string;
  model: string;
  effort: string;
  mcpConfigPath: string;
  providerSessionId?: string | null;
  addDirs?: string[];
  allowedTools?: string[];
}): string[] {
  const dirs = Array.from(new Set((opts.addDirs || []).filter(Boolean)));
  const tools =
    opts.allowedTools && opts.allowedTools.length > 0
      ? opts.allowedTools
      : ["Read", "mcp__tab-agent__*"];
  const permMode = (process.env.TAB_AGENT_CLAUDE_PERMISSION_MODE || "bypass").trim();
  const permArgs =
    permMode === "bypass"
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", permMode];
  return [
    opts.bin,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...permArgs,
    ...(dirs.length > 0 ? ["--add-dir", ...dirs] : []),
    "--allowedTools",
    tools.join(","),
    "--model",
    opts.model,
    "--effort",
    opts.effort,
    "--mcp-config",
    opts.mcpConfigPath,
    ...(opts.providerSessionId ? ["--resume", opts.providerSessionId] : []),
    "-p",
    opts.prompt,
  ];
}

export class HarnessRunner {
  private activeRuns = new Map<string, ActiveRun>();
  private lastUrlBySession = new Map<string, string>();
  private queues = new Map<
    string,
    Array<{
      text: string;
      chips: ElementChip[];
      attachments: AttachmentRecord[];
      peerDepth?: number;
      onComplete?: (reply: string, isError: boolean) => void;
    }>
  >();
  private mcpConfigDir: string;
  private councilDir: string;

  private readonly stallMs: number;
  private readonly attachmentsDir: string;
  private readonly pigeonBridge?: PigeonBridge;
  private readonly onTurnLifecycle?: (info: {
    sessionId: string;
    phase: "start" | "end" | "abort";
    isError?: boolean;
    durationMs?: number;
    snippet?: string;
    fromTrigger?: boolean;
  }) => void;

  constructor(
    private readonly store: TabAgentStore,
    private readonly broadcast: BroadcastFn,
    private readonly daemonConfig: {
      port: number;
      token: string;
      attachmentsDir?: string;
      stallMs?: number;
      pigeonBridge?: PigeonBridge;
      onTurnLifecycle?: (info: {
        sessionId: string;
        phase: "start" | "end" | "abort";
        isError?: boolean;
        durationMs?: number;
        snippet?: string;
        fromTrigger?: boolean;
      }) => void;
    }
  ) {
    this.stallMs = daemonConfig.stallMs ?? DEFAULT_STALL_MS;
    this.attachmentsDir = getAttachmentsDir(daemonConfig.attachmentsDir);
    this.pigeonBridge = daemonConfig.pigeonBridge;
    this.onTurnLifecycle = daemonConfig.onTurnLifecycle;
    this.mcpConfigDir = join(import.meta.dir, "..", "data", "mcp");
    this.councilDir = join(import.meta.dir, "..", "data", "council");
    mkdirSync(this.mcpConfigDir, { recursive: true });
    mkdirSync(this.councilDir, { recursive: true });
  }

  isRunning(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  getActiveAgentMessageId(sessionId: string): number | null {
    return this.activeRuns.get(sessionId)?.agentMsgId ?? null;
  }

  getRunStatus(sessionId: string): RunStatus | null {
    const run = this.activeRuns.get(sessionId);
    if (!run) return null;
    return {
      activeAgentMessageId: run.agentMsgId,
      startedAt: run.startedAt,
      lastActivityAt: run.lastActivityAt,
      phase: run.phase,
      currentStep: run.currentStep,
      stepCount: run.stepCount,
      queuedCount: (this.queues.get(sessionId) || []).length,
    };
  }

  private emitRunStatus(sessionId: string): void {
    this.broadcast({
      type: "run_status",
      sessionId,
      runStatus: this.getRunStatus(sessionId),
    });
  }

  private writeClaudeMcpConfig(sessionId: string): string {
    const cfgPath = join(this.mcpConfigDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    const cfg = {
      mcpServers: {
        "tab-agent": {
          command: process.execPath || "bun",
          args: [MCP_BRIDGE_PATH],
          env: {
            TAB_AGENT_SESSION: sessionId,
            TAB_AGENT_PORT: String(this.daemonConfig.port),
            TAB_AGENT_TOKEN: this.daemonConfig.token,
          },
        },
      },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return cfgPath;
  }

  /** Stop every running turn (daemon shutdown), so no CLI process is left running without a parent. */
  abortAll(): number {
    const ids = this.getActiveSessionIds();
    for (const id of ids) this.abort(id, true);
    return ids.length;
  }

  abort(sessionId: string, silent = false): boolean {
    this.queues.delete(sessionId);
    const run = this.activeRuns.get(sessionId);
    if (!run) return false;
    run.abort();
    this.activeRuns.delete(sessionId);
    const partial = run.getAccumulated().trim();
    const finalText = partial ? `${partial}\n\n*(Stopped)*` : "*(Stopped)*";
    this.store.updateMessageText(run.agentMsgId, finalText, true);
    if (!silent) {
      this.store.updateSessionState(sessionId, "needs-you", "Stopped by user.");
      const ev = this.store.insertEvent({ sessionId, kind: "abort", summary: "Stopped active turn." });
      this.broadcast({ type: "harness_event", sessionId, event: ev });
      this.broadcast({
        type: "message_end",
        sessionId,
        messageId: run.agentMsgId,
        text: finalText,
        time: nowTimeShort(),
      });
      this.broadcast({ type: "session_state", sessionId, state: "needs-you", questionSnippet: "Stopped by user.", runStatus: null });
      this.onTurnLifecycle?.({ sessionId, phase: "abort" });
    }
    return true;
  }

  private postSystemReply(sessionId: string, text: string): void {
    const msg = this.store.insertMessage({ sessionId, sender: "agent", text });
    const snippet = safeSnippet(text);
    this.store.updateSessionState(sessionId, "needs-you", snippet);
    this.broadcast({ type: "message_start", sessionId, message: msg });
    this.broadcast({ type: "message_end", sessionId, messageId: msg.id, text, time: msg.time });
    this.broadcast({ type: "session_state", sessionId, state: "needs-you", questionSnippet: snippet });
  }

  private handleLocalSlash(sessionId: string, raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return false;
    const sess = this.store.getSession(sessionId);
    if (!sess) return false;

    const [cmdRaw, ...rest] = trimmed.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = rest.join(" ").trim();
    const currentSpec = getHarnessSpec(sess.harnessId);

    if (cmd === "/model") {
      if (!arg) {
        const list = HARNESS_CATALOGUE.map((h) => `- \`${h.aliases[0]}\` (${h.label})`).join("\n");
        this.postSystemReply(sessionId, `Current: **${sess.family} · ${sess.model} (${sess.effort})**\n\nSwitch with \`/model <name> [effort]\`:\n${list}`);
        return true;
      }
      const parts = arg.split(/\s+/);
      const next = findHarnessByQuery(parts[0]);
      if (!next) {
        this.postSystemReply(sessionId, `Unknown model \`${parts[0]}\`. Try \`neon\`, \`carbon\`, \`argon\`, \`opus\`, \`sonnet\`, or \`haiku\`.`);
        return true;
      }
      const effort = normalizeEffort(next, parts[1] || sess.effort);
      const resetProviderSession = next.runner !== currentSpec.runner;
      this.store.updateSessionConfig(sessionId, {
        family: next.family,
        model: next.model,
        effort,
        harnessId: next.id,
        resetProviderSession,
      });
      const updated = this.store.getSessionFull(sessionId);
      if (updated) this.broadcast({ type: "session_updated", session: updated });
      this.postSystemReply(sessionId, `Switched to **${next.family} · ${next.model} (${effort.toUpperCase()})**${resetProviderSession ? " (fresh CLI context)" : ""}.`);
      return true;
    }

    if (cmd === "/effort" || cmd === "/thinking") {
      if (!arg) {
        this.postSystemReply(sessionId, `Current effort: **${sess.effort.toUpperCase()}**. Options: ${currentSpec.efforts.map((e) => `\`${e}\``).join(", ")}`);
        return true;
      }
      const effort = normalizeEffort(currentSpec, arg);
      this.store.updateSessionConfig(sessionId, {
        family: currentSpec.family,
        model: currentSpec.model,
        effort,
        harnessId: currentSpec.id,
      });
      const updated = this.store.getSessionFull(sessionId);
      if (updated) this.broadcast({ type: "session_updated", session: updated });
      this.postSystemReply(sessionId, `Thinking effort set to **${effort.toUpperCase()}**.`);
      return true;
    }

    if (cmd === "/new" || cmd === "/reset") {
      this.store.updateProviderSessionId(sessionId, null);
      this.postSystemReply(sessionId, "Reset underlying CLI conversation ID — next message starts a fresh context.");
      return true;
    }

    if (cmd === "/clear") {
      this.store.clearMessages(sessionId);
      const updated = this.store.getSessionFull(sessionId);
      if (updated) this.broadcast({ type: "session_updated", session: updated });
      this.postSystemReply(sessionId, "Cleared messages and started a fresh context.");
      return true;
    }

    if (cmd === "/help") {
      this.postSystemReply(
        sessionId,
        "**Tab-Agent Slash Commands:**\n- `/council <question>` — run an independent multi-company Frontier Council (Gemini + Claude + Codex + Kimi) in parallel, generate an `Open ↗` `.html` comparison dossier, and stage a Pigeon-Hole Relay Card (`/council gemini,claude,codex | <question>` to pick lanes)\n- `/model <neon|carbon|argon|opus|sonnet|haiku> [effort]`\n- `/effort <low|medium|high|xhigh|max>`\n- `/after [cubby] <instruction>` — wake this chat when a Pigeon-Hole cubby finishes its turn (`/after list`, `/after cancel`)\n- `/new` — reset CLI context · `/clear` — clear chat history\n- **Peer talk:** Ask any tab to talk to another repo's tab — agents use `tab-peer list / read / send`\n- Shortcuts: `Shift+Enter` send · `⌘K` switcher · `⌘.` See Page · `⌘⇧↩` confirm staged Relay"
      );
      return true;
    }

    return false;
  }

  private async handleAfterSlash(sessionId: string, raw: string): Promise<boolean> {
    const trimmed = raw.trim();
    if (!/^\/after(?:\s|$)/i.test(trimmed)) return false;
    if (!this.pigeonBridge) {
      this.postSystemReply(sessionId, "Pigeon-Hole bridge is not enabled.");
      return true;
    }
    const arg = trimmed.replace(/^\/after\s*/i, "").trim();
    if (!arg || arg.toLowerCase() === "list") {
      const armed = this.store.listTriggers(sessionId).filter((t) => t.status === "armed");
      if (armed.length === 0) {
        this.postSystemReply(
          sessionId,
          "No armed `/after` watchers on this chat.\n\nUsage: `/after <instruction>` (on a Pigeon-Hole tab) or `/after <cubby-id> <instruction>`."
        );
      } else {
        const lines = armed.map((t) => `- **${t.targetName}** (\`${t.targetSessionId}\`): ${t.instruction}`).join("\n");
        this.postSystemReply(sessionId, `**Armed \`/after\` watchers:**\n${lines}\n\nRun \`/after cancel\` to disarm.`);
      }
      return true;
    }
    if (arg.toLowerCase() === "cancel" || arg.toLowerCase() === "clear") {
      const armed = this.store.listTriggers(sessionId).filter((t) => t.status === "armed");
      if (armed.length === 0) {
        this.postSystemReply(sessionId, "No armed `/after` watchers to cancel.");
        return true;
      }
      for (const t of armed) this.pigeonBridge.cancelTrigger(t.id);
      this.postSystemReply(sessionId, `Cancelled ${armed.length} armed \`/after\` watcher${armed.length === 1 ? "" : "s"}.`);
      return true;
    }

    // Detect whether the first word is an explicit cubby ID/name or part of the instruction
    const parts = arg.split(/\s+/);
    let targetQuery: string | undefined;
    let instruction = arg;
    if (parts.length >= 2) {
      const boot = await this.pigeonBridge.fetchBootstrap(1_500);
      const firstLow = parts[0].toLowerCase();
      const matched = boot.cubbies.find(
        (c) => c.id.toLowerCase() === firstLow || c.name.toLowerCase() === firstLow
      );
      if (matched) {
        targetQuery = matched.id;
        instruction = parts.slice(1).join(" ").trim();
      }
    }

    const res = await this.pigeonBridge.armTrigger(sessionId, { targetQuery, instruction });
    if (!res.ok || !res.trigger) {
      this.postSystemReply(sessionId, `Could not arm \`/after\`: ${res.error}`);
      return true;
    }
    this.postSystemReply(
      sessionId,
      `⏰ Armed \`/after\` on **${res.trigger.targetName}** (\`${res.trigger.targetSessionId}\`).\n\nWhen that cubby finishes its current turn, this chat will wake automatically and run:\n> ${res.trigger.instruction}`
    );
    return true;
  }

  private async executeCouncilTurn(
    sessionId: string,
    question: string,
    requestedLanes: Array<"gemini" | "claude" | "codex" | "kimi"> | null,
    chips: ElementChip[],
    attachments: AttachmentRecord[]
  ): Promise<void> {
    const sess = this.store.getSession(sessionId);
    if (!sess) return;
    if (!question.trim()) {
      this.postSystemReply(
        sessionId,
        "Usage: `/council <question>` or `/council gemini,claude,codex | <question>`\n\nRuns independent frontier models in parallel, writes an `Open ↗` `.html` comparison dossier, and stages a Pigeon-Hole Relay Card when on a Pigeon-Hole tab."
      );
      return;
    }

    const cwd = existsSync(sess.repoPath) ? sess.repoPath : HOME;

    this.store.updateSessionState(sessionId, "working", "");
    this.broadcast({ type: "session_state", sessionId, state: "working", questionSnippet: "" });

    const agentMsg = this.store.insertMessage({ sessionId, sender: "agent", text: "" });
    this.broadcast({ type: "message_start", sessionId, message: { ...agentMsg, isStreaming: true } });

    const evStart = this.store.insertEvent({
      sessionId,
      kind: "council",
      summary: `Council started: ${question.slice(0, 72)}`,
    });
    this.broadcast({ type: "harness_event", sessionId, event: evStart });

    const controller = new AbortController();
    const runStartedAt = Date.now();
    let aborted = false;
    let accumulated = "";

    const runEntry: ActiveRun = {
      agentMsgId: agentMsg.id,
      getAccumulated: () => accumulated,
      startedAt: runStartedAt,
      lastActivityAt: runStartedAt,
      phase: "tool",
      currentStep: "Starting Frontier Council…",
      stepCount: 0,
      abort: () => {
        aborted = true;
        controller.abort();
      },
    };
    this.activeRuns.set(sessionId, runEntry);
    this.emitRunStatus(sessionId);
    this.onTurnLifecycle?.({ sessionId, phase: "start", fromTrigger: false });

    let pigeonContext = null;
    let pigeonMessages: Array<{ sender: string; time: string; text: string }> = [];
    if (this.pigeonBridge && sess.lastUrl) {
      pigeonContext = await this.pigeonBridge.getContextForTab(sess.lastUrl, { timeoutMs: 1_200 }).catch(() => null);
      if (pigeonContext?.isPigeonHole && pigeonContext.activeCubby) {
        const st = await this.pigeonBridge
          .handleMcpStatus(sessionId, { targetSessionId: pigeonContext.activeCubby.id, includeMessages: true })
          .catch(() => null);
        if (st?.ok && Array.isArray((st.data as any)?.recentMessages)) {
          pigeonMessages = (st.data as any).recentMessages;
        }
      }
    }

    let finalText = "";
    let isError = false;
    try {
      const result = await runCouncil({
        question,
        requestedLanes,
        session: sess,
        cwd,
        attachmentsDir: this.attachmentsDir,
        councilDir: this.councilDir,
        chips,
        attachments,
        pigeonContext,
        pigeonMessages,
        signal: controller.signal,
        onProgress: (done, _total, summary) => {
          runEntry.lastActivityAt = Date.now();
          runEntry.stepCount = done;
          runEntry.currentStep = summary;
          this.emitRunStatus(sessionId);
        },
        onLaneDone: (verdict) => {
          const ev = this.store.insertEvent({
            sessionId,
            kind: "council",
            summary: verdict.ok
              ? `${verdict.label} replied (${(verdict.durationMs / 1000).toFixed(1)}s)`
              : `${verdict.label} failed: ${verdict.error || "error"}`,
          });
          this.broadcast({ type: "harness_event", sessionId, event: ev });
        },
      });

      if (aborted) return;

      const lines: string[] = [];
      lines.push(result.synthesis.markdown);
      lines.push("");
      lines.push(`**Full comparison dossier:** \`${result.dossierUrl}\``);

      // Stage an editable Pigeon-Hole Relay Card automatically when on a Pigeon-Hole tab
      if (
        this.pigeonBridge &&
        pigeonContext?.isPigeonHole &&
        pigeonContext.activeCubby &&
        result.synthesis.recommendedPrompt
      ) {
        const relayRes = await this.pigeonBridge.createFromUserAction(sessionId, {
          text: result.synthesis.recommendedPrompt,
          mode: pigeonContext.activeCubby.state === "working" ? "queue" : "send",
          targetSessionId: pigeonContext.activeCubby.id,
          messageId: agentMsg.id,
          executeNow: false,
        });
        if (relayRes.ok) {
          lines.push(
            `\n*Staged a Pigeon-Hole Relay Card below for **${pigeonContext.activeCubby.name}** — press \`⌘⇧↩\` to send it.*`
          );
        }
      }

      finalText = lines.join("\n");
      accumulated = finalText;
      isError = result.verdicts.every((v) => !v.ok);
    } catch (err: any) {
      if (aborted) return;
      finalText = `Harness error: Council failed — ${err?.message || err}`;
      isError = true;
    } finally {
      if (this.activeRuns.get(sessionId)?.agentMsgId === agentMsg.id) {
        this.activeRuns.delete(sessionId);
      }
    }

    if (aborted) return;

    this.store.updateMessageText(agentMsg.id, finalText, true);
    const snippet = safeSnippet(finalText);
    this.store.updateSessionState(sessionId, "needs-you", snippet);
    this.broadcast({
      type: "message_end",
      sessionId,
      messageId: agentMsg.id,
      text: finalText,
      time: nowTimeShort(),
    });
    this.broadcast({
      type: "session_state",
      sessionId,
      state: "needs-you",
      questionSnippet: snippet,
      runStatus: null,
    });
    const updated = this.store.getSessionFull(sessionId);
    if (updated) this.broadcast({ type: "session_updated", session: updated });
    this.onTurnLifecycle?.({
      sessionId,
      phase: "end",
      isError,
      durationMs: Date.now() - runStartedAt,
      snippet,
      fromTrigger: false,
    });
  }

  async dispatch(
    sessionId: string,
    promptText: string,
    chips: ElementChip[] = [],
    attachments: AttachmentRecord[] = [],
    opts: {
      displayText?: string;
      fromTrigger?: boolean;
      peerDepth?: number;
      onComplete?: (reply: string, isError: boolean) => void;
    } = {}
  ): Promise<void> {
    const sess = this.store.getSession(sessionId);
    if (!sess) throw new Error(`Unknown session: ${sessionId}`);

    // Auto-name session from first user prompt if still generic
    if (
      !opts.fromTrigger &&
      (sess.name === "New Chat" || sess.name.startsWith("Tab ") || sess.name === sess.repoName) &&
      !promptText.trim().startsWith("/")
    ) {
      const autoTitle =
        promptText.trim().replace(/\s+/g, " ").slice(0, 52) ||
        (chips.find((c) => c.note?.trim())?.note?.trim()
          ? `Pin: ${chips.find((c) => c.note?.trim())!.note!.trim().slice(0, 46)}`
          : "") ||
        (attachments[0]?.name ? `Image: ${attachments[0].name.slice(0, 42)}` : "");
      if (autoTitle.length >= 4) {
        this.store.updateSessionName(sessionId, autoTitle);
      }
    }

    const humanMsg = this.store.insertMessage({
      sessionId,
      sender: opts.fromTrigger ? "system" : "human",
      text: opts.displayText ?? promptText,
      chips,
      attachments,
    });
    this.broadcast({ type: "human_message", sessionId, message: humanMsg });

    if (!opts.fromTrigger) {
      const council = parseCouncilCommand(promptText);
      if (council.isCouncil) {
        await this.executeCouncilTurn(sessionId, council.question, council.lanes, chips, attachments);
        opts.onComplete?.("", false);
        return;
      }
      if (attachments.length === 0) {
        if (this.handleLocalSlash(sessionId, promptText)) {
          opts.onComplete?.("", false);
          return;
        }
        if (await this.handleAfterSlash(sessionId, promptText)) {
          opts.onComplete?.("", false);
          return;
        }
      }
    }

    if (this.activeRuns.has(sessionId)) {
      const q = this.queues.get(sessionId) || [];
      q.push({
        text: promptText,
        chips,
        attachments,
        peerDepth: opts.peerDepth,
        onComplete: opts.onComplete,
      });
      this.queues.set(sessionId, q);
      const ev = this.store.insertEvent({
        sessionId,
        kind: "queue",
        summary: `Queued follow-up (#${q.length})${attachments.length ? ` · ${attachments.length} img` : ""}`,
      });
      this.broadcast({ type: "harness_event", sessionId, event: ev });
      this.emitRunStatus(sessionId);
      return;
    }

    await this.executeTurn(
      sessionId,
      promptText,
      chips,
      attachments,
      Boolean(opts.fromTrigger),
      opts.peerDepth ?? 0,
      opts.onComplete
    );
  }

  private async executeTurn(
    sessionId: string,
    promptText: string,
    chips: ElementChip[],
    attachments: AttachmentRecord[] = [],
    fromTrigger = false,
    peerDepth = 0,
    onComplete?: (reply: string, isError: boolean) => void
  ): Promise<void> {
    const sess = this.store.getSession(sessionId);
    if (!sess) {
      onComplete?.("", true);
      return;
    }

    const spec = getHarnessSpec(sess.harnessId);
    const effort = normalizeEffort(spec, sess.effort);
    const cwd = existsSync(sess.repoPath) ? sess.repoPath : HOME;

    const prevUrl = this.lastUrlBySession.get(sessionId);
    const urlChanged = Boolean(prevUrl && sess.lastUrl && prevUrl !== sess.lastUrl);
    if (sess.lastUrl) this.lastUrlBySession.set(sessionId, sess.lastUrl);

    const pigeonContext =
      this.pigeonBridge && sess.lastUrl
        ? await this.pigeonBridge.getContextForTab(sess.lastUrl, { timeoutMs: 1_200 }).catch(() => null)
        : null;

    const effectivePrompt = buildTabContextEnvelope(sess, promptText, chips, {
      isFirstTurn: !sess.providerSessionId,
      urlChanged,
      attachments,
      pigeonContext,
    });

    this.store.updateSessionState(sessionId, "working", "");
    this.broadcast({ type: "session_state", sessionId, state: "working", questionSnippet: "" });

    const agentMsg = this.store.insertMessage({ sessionId, sender: "agent", text: "" });
    this.broadcast({ type: "message_start", sessionId, message: { ...agentMsg, isStreaming: true } });

    const imgNote = attachments.length ? ` · ${attachments.length} img` : "";
    const evStart = this.store.insertEvent({
      sessionId,
      kind: "user",
      summary: `→ ${spec.family} · ${spec.model} (${effort.toUpperCase()}) in ${sess.repoName}${imgNote}`,
    });
    this.broadcast({ type: "harness_event", sessionId, event: evStart });

    const basePath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: basePath.includes(TAB_AGENT_BIN_DIR) ? basePath : `${TAB_AGENT_BIN_DIR}:${basePath}`,
      TAB_AGENT_SESSION: sessionId,
      TAB_AGENT_PORT: String(this.daemonConfig.port),
      TAB_AGENT_TOKEN: this.daemonConfig.token,
      TAB_AGENT_PEER_DEPTH: String(peerDepth),
    };

    let aborted = false;
    let stalled = false;
    let sawResultEvent = false;
    let accumulated = "";
    let finalError: string | null = null;
    let exitCode = 0;
    let stderrText = "";
    const runStartedAt = Date.now();

    const savePartial = (() => {
      let lastAt = Date.now();
      return (txt: string) => {
        const now = Date.now();
        if (now - lastAt >= 1200) {
          lastAt = now;
          this.store.updateMessageText(agentMsg.id, txt, false);
        }
      };
    })();

    try {
      let args: string[];
      if (spec.runner === "agy") {
        const modelArg = `${spec.baseModel}-${effort}`;
        args = [
          agyBin(),
          `--print=${effectivePrompt}`,
          "--model",
          modelArg,
          "--output-format",
          "stream-json",
          "--mode",
          "accept-edits",
          "--dangerously-skip-permissions",
          ...(sess.providerSessionId ? ["--conversation", sess.providerSessionId] : []),
        ];
      } else {
        const mcpCfg = this.writeClaudeMcpConfig(sessionId);
        const addDirs = [
          this.attachmentsDir,
          ...attachments.map((a) => (a.path ? dirname(a.path) : "")).filter(Boolean),
        ];
        args = buildClaudeSpawnArgs({
          bin: claudeBin(),
          prompt: effectivePrompt,
          model: spec.baseModel,
          effort,
          mcpConfigPath: mcpCfg,
          providerSessionId: sess.providerSessionId,
          addDirs,
          allowedTools: ["Read", "mcp__tab-agent__*"],
        });
      }

      const proc = Bun.spawn(args, {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const agyState = createAgyStreamState();
      const claudeState = createClaudeStreamState();

      const runEntry: ActiveRun = {
        agentMsgId: agentMsg.id,
        getAccumulated: () => accumulated,
        startedAt: runStartedAt,
        lastActivityAt: runStartedAt,
        phase: "starting",
        currentStep: `Starting ${spec.family} · ${spec.model}…`,
        stepCount: 0,
        abort: () => {
          aborted = true;
          try {
            proc.kill();
          } catch {}
        },
      };
      this.activeRuns.set(sessionId, runEntry);
      this.emitRunStatus(sessionId);
      this.onTurnLifecycle?.({ sessionId, phase: "start", fromTrigger });

      const stderrPromise = new Response(proc.stderr).text().catch(() => "");

      // Stall watchdog: long turns are fine while the CLI keeps printing; total silence means it is stuck.
      let lastOutputAt = Date.now();
      let lastHeartbeatBroadcastAt = runStartedAt;
      const stallTimer = setInterval(() => {
        if (Date.now() - lastOutputAt < this.stallMs || aborted) return;
        stalled = true;
        clearInterval(stallTimer);
        try {
          proc.kill();
        } catch {}
      }, Math.min(60_000, Math.max(50, Math.floor(this.stallMs / 4))));

      await readNdjson(proc.stdout, (line) => {
        const now = Date.now();
        lastOutputAt = now;
        runEntry.lastActivityAt = now;
        if (aborted) return;
        const parsed =
          spec.runner === "agy"
            ? parseAgyStreamLine(line, agyState)
            : parseClaudeStreamLine(line, claudeState);
        if (!parsed) {
          // Even unrecognized progress/thinking JSON lines prove the runner is alive
          if (now - lastHeartbeatBroadcastAt >= 1500) {
            lastHeartbeatBroadcastAt = now;
            if (runEntry.phase === "starting") {
              runEntry.phase = "thinking";
              runEntry.currentStep = "Thinking…";
            }
            this.emitRunStatus(sessionId);
          }
          return;
        }

        if (parsed.isResult) sawResultEvent = true;

        let statusChanged = false;
        if (parsed.providerSessionId) {
          this.store.updateProviderSessionId(sessionId, parsed.providerSessionId);
        }
        if (parsed.fullText !== undefined) {
          accumulated = parsed.fullText;
          savePartial(accumulated);
          if (runEntry.phase !== "streaming") {
            runEntry.phase = "streaming";
            runEntry.currentStep = "Writing reply…";
            statusChanged = true;
          }
          this.broadcast({
            type: "message_delta",
            sessionId,
            messageId: agentMsg.id,
            text: accumulated,
          });
        }
        for (const e of parsed.events) {
          if (e.kind === "init" && runEntry.phase === "starting") {
            runEntry.phase = "thinking";
            runEntry.currentStep = "Thinking…";
            statusChanged = true;
          } else if (e.kind === "tool") {
            runEntry.phase = "tool";
            runEntry.currentStep = e.summary;
            runEntry.stepCount += 1;
            statusChanged = true;
          }
          const rec = this.store.insertEvent({ sessionId, kind: e.kind, summary: e.summary });
          this.broadcast({ type: "harness_event", sessionId, event: rec });
        }
        if (statusChanged || now - lastHeartbeatBroadcastAt >= 1500) {
          lastHeartbeatBroadcastAt = now;
          this.emitRunStatus(sessionId);
        }
      });

      exitCode = await proc.exited;
      clearInterval(stallTimer);
      stderrText = (await stderrPromise).trim();
      finalError = spec.runner === "agy" ? agyState.resultError : claudeState.resultError;
    } catch (err: any) {
      finalError = err?.message || String(err);
    } finally {
      if (this.activeRuns.get(sessionId)?.agentMsgId === agentMsg.id) {
        this.activeRuns.delete(sessionId);
      }
    }

    if (aborted) {
      onComplete?.("*(Stopped)*", true);
      return;
    }

    let finalText = accumulated.trim();
    if (stalled) {
      const mins = Math.round(this.stallMs / 60_000);
      const note = `*(Stopped: no output from the CLI for ${mins >= 1 ? `${mins} min` : `${this.stallMs} ms`}. Send a message to carry on; the conversation resumes where it was.)*`;
      finalText = finalText ? `${finalText}\n\n${note}` : note;
      const ev = this.store.insertEvent({ sessionId, kind: "stall", summary: `Stopped stuck turn (no output for ${mins} min)` });
      this.broadcast({ type: "harness_event", sessionId, event: ev });
    } else if (!finalText) {
      if (finalError) finalText = `Harness error: ${finalError}`;
      else if (stderrText) finalText = `Harness error:\n${stderrText.slice(0, 800)}`;
      else if (exitCode !== 0) finalText = `Harness error: CLI exited with code ${exitCode} before producing a reply.`;
      else if (!sawResultEvent) {
        finalText = "Harness error: CLI exited silently without a response (code 0). Retry or check ~/Library/Logs/tab-agent.log.";
        const ev = this.store.insertEvent({ sessionId, kind: "error", summary: "CLI exited silently without result (code 0)" });
        this.broadcast({ type: "harness_event", sessionId, event: ev });
      } else finalText = "*(Turn finished with no text reply.)*";
    } else if (finalError && !finalText.includes(finalError)) {
      finalText += `\n\nHarness error: ${finalError}`;
    }

    this.store.updateMessageText(agentMsg.id, finalText, true);
    const snippet = safeSnippet(finalText);
    this.store.updateSessionState(sessionId, "needs-you", snippet);

    this.broadcast({
      type: "message_end",
      sessionId,
      messageId: agentMsg.id,
      text: finalText,
      time: nowTimeShort(),
    });
    this.broadcast({
      type: "session_state",
      sessionId,
      state: "needs-you",
      questionSnippet: snippet,
      runStatus: null,
    });

    const updated = this.store.getSessionFull(sessionId);
    if (updated) this.broadcast({ type: "session_updated", session: updated });

    const isError =
      stalled ||
      /^\s*Harness error:/i.test(finalText) ||
      Boolean(finalError);
    this.onTurnLifecycle?.({
      sessionId,
      phase: "end",
      isError,
      durationMs: Date.now() - runStartedAt,
      snippet,
      fromTrigger,
    });
    onComplete?.(finalText, isError);

    // Drain next queued follow-up if any
    const q = this.queues.get(sessionId);
    if (q && q.length > 0) {
      const next = q.shift()!;
      if (q.length === 0) this.queues.delete(sessionId);
      await this.executeTurn(
        sessionId,
        next.text,
        next.chips,
        next.attachments,
        false,
        next.peerDepth ?? 0,
        next.onComplete
      );
    }
  }
}
