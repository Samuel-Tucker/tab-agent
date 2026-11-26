import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { TabAgentStore } from "./db";
import type { BroadcastFn } from "./harnesses";
import { toTildePath } from "./url-repo";

export type ShellRunStatus = "running" | "done" | "error" | "killed";

export interface ShellRunRecord {
  id: string;
  sessionId: string;
  messageId: number | null;
  blockIdx: number | null;
  command: string;
  cwd: string;
  displayCwd: string;
  status: ShellRunStatus;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  startedAt: number;
  finishedAt: number | null;
}

const MAX_OUTPUT_CHARS = 64_000;
const MAX_RUNS_PER_SESSION = 20;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface ActiveShell {
  record: ShellRunRecord;
  kill: () => void;
}

function isSelfReloadCommand(cmd: string): boolean {
  return /\btab-agent\s+(?:reload|restart)\b/.test(cmd);
}

export class ShellRunner {
  private runsById = new Map<string, ShellRunRecord>();
  private runIdsBySession = new Map<string, string[]>();
  private activeById = new Map<string, ActiveShell>();
  private readonly timeoutMs: number;

  constructor(
    private readonly store: TabAgentStore,
    private readonly broadcast: BroadcastFn,
    opts: { timeoutMs?: number } = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getRun(runId: string): ShellRunRecord | null {
    return this.runsById.get(runId) || null;
  }

  listRuns(sessionId: string): ShellRunRecord[] {
    const ids = this.runIdsBySession.get(sessionId) || [];
    return ids.map((id) => this.runsById.get(id)).filter((r): r is ShellRunRecord => Boolean(r));
  }

  kill(runId: string): boolean {
    const active = this.activeById.get(runId);
    if (!active) return false;
    active.kill();
    return true;
  }

  killAll(): number {
    let count = 0;
    for (const active of this.activeById.values()) {
      active.kill();
      count++;
    }
    return count;
  }

  private rememberRun(rec: ShellRunRecord): void {
    this.runsById.set(rec.id, rec);
    const list = this.runIdsBySession.get(rec.sessionId) || [];
    list.push(rec.id);
    while (list.length > MAX_RUNS_PER_SESSION) {
      const oldId = list.shift();
      if (oldId && !this.activeById.has(oldId)) {
        this.runsById.delete(oldId);
      }
    }
    this.runIdsBySession.set(rec.sessionId, list);
  }

  start(
    sessionId: string,
    input: {
      command: string;
      messageId?: number | null;
      blockIdx?: number | null;
      cwd?: string;
    }
  ): { ok: boolean; run?: ShellRunRecord; error?: string } {
    const sess = this.store.getSession(sessionId);
    if (!sess) return { ok: false, error: "Session not found" };

    const command = String(input.command || "").trim();
    if (!command) return { ok: false, error: "command is required" };

    const requestedCwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : sess.repoPath;
    const cwd = existsSync(requestedCwd) ? requestedCwd : homedir();
    const id = `run-${randomUUID().slice(0, 8)}`;

    const record: ShellRunRecord = {
      id,
      sessionId,
      messageId: typeof input.messageId === "number" ? input.messageId : null,
      blockIdx: typeof input.blockIdx === "number" ? input.blockIdx : null,
      command,
      cwd,
      displayCwd: toTildePath(cwd),
      status: "running",
      exitCode: null,
      output: "",
      truncated: false,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.rememberRun(record);

    const ev = this.store.insertEvent({
      sessionId,
      kind: "shell",
      summary: `Ran in sidebar: ${command.replace(/\s+/g, " ").slice(0, 64)}`,
    });
    this.broadcast({ type: "harness_event", sessionId, event: ev });
    this.broadcast({ type: "shell_start", sessionId, run: { ...record } });

    // Self-reload commands would kill this daemon mid-response if run inline; detach cleanly instead.
    if (isSelfReloadCommand(command)) {
      try {
        const detached = Bun.spawn(
          ["/bin/bash", "-c", `nohup /bin/zsh -lc ${JSON.stringify(`sleep 1 && ${command}`)} </dev/null >/tmp/tab-agent-reload.log 2>&1 &`],
          { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
        );
        detached.unref();
        record.output = "Scheduled detached Tab-Agent daemon reload (~1s).\nThe sidebar will reconnect automatically once the new daemon is up.";
        record.status = "done";
        record.exitCode = 0;
        record.finishedAt = Date.now();
        this.broadcast({ type: "shell_end", sessionId, run: { ...record } });
        return { ok: true, run: { ...record } };
      } catch (err: any) {
        record.output = `Failed to schedule detached reload: ${err?.message || String(err)}`;
        record.status = "error";
        record.exitCode = 1;
        record.finishedAt = Date.now();
        this.broadcast({ type: "shell_end", sessionId, run: { ...record } });
        return { ok: true, run: { ...record } };
      }
    }

    this.executeAsync(record).catch((err) => {
      record.output += `\n[shell error] ${err?.message || String(err)}`;
      record.status = "error";
      record.exitCode = 1;
      record.finishedAt = Date.now();
      this.activeById.delete(record.id);
      this.broadcast({ type: "shell_end", sessionId: record.sessionId, run: { ...record } });
    });

    return { ok: true, run: { ...record } };
  }

  private async executeAsync(record: ShellRunRecord): Promise<void> {
    let killed = false;
    let timedOut = false;

    const proc = Bun.spawn(["/bin/zsh", "-lc", record.command], {
      cwd: record.cwd,
      env: {
        ...(process.env as Record<string, string>),
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const killProc = () => {
      killed = true;
      try {
        proc.kill("SIGTERM");
      } catch {}
      const hardTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 1500);
      if (typeof (hardTimer as any)?.unref === "function") (hardTimer as any).unref();
    };

    this.activeById.set(record.id, { record, kill: killProc });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProc();
    }, this.timeoutMs);
    if (typeof (timeoutTimer as any)?.unref === "function") (timeoutTimer as any).unref();

    let lastBroadcastAt = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const emitDelta = () => {
      lastBroadcastAt = Date.now();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      this.broadcast({
        type: "shell_delta",
        sessionId: record.sessionId,
        runId: record.id,
        output: record.output,
        truncated: record.truncated,
      });
    };

    const appendText = (chunk: string) => {
      if (!chunk) return;
      if (record.output.length < MAX_OUTPUT_CHARS) {
        const remaining = MAX_OUTPUT_CHARS - record.output.length;
        if (chunk.length > remaining) {
          record.output += chunk.slice(0, remaining);
          record.truncated = true;
        } else {
          record.output += chunk;
        }
      } else {
        record.truncated = true;
      }
      const now = Date.now();
      if (now - lastBroadcastAt >= 80) {
        emitDelta();
      } else if (!flushTimer) {
        flushTimer = setTimeout(emitDelta, 80);
      }
    };

    const pump = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          appendText(dec.decode(value, { stream: true }));
        }
        const tail = dec.decode();
        if (tail) appendText(tail);
      } catch {}
    };

    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const exitCode = await proc.exited;
    clearTimeout(timeoutTimer);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    this.activeById.delete(record.id);

    if (timedOut) {
      appendText(`\n[Timed out after ${Math.round(this.timeoutMs / 1000)}s]`);
      record.status = "killed";
    } else if (killed) {
      appendText("\n[Stopped by user]");
      record.status = "killed";
    } else {
      record.status = exitCode === 0 ? "done" : "error";
    }
    record.exitCode = exitCode;
    record.finishedAt = Date.now();

    this.broadcast({ type: "shell_end", sessionId: record.sessionId, run: { ...record } });
  }
}
