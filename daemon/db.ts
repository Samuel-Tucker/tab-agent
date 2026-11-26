import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type SessionState = "idle" | "working" | "needs-you";
export type AttentionKind = "" | "done" | "needs-you" | "error";
export type RepoSource = "pinned" | "localhost" | "repo-map" | "manual" | "scratch";
export type PigeonRelayMode = "ask" | "auto-queue";
export type PigeonRelayKind = "queue" | "steer" | "send";
export type PigeonRelayStatus = "staged" | "queued" | "steered" | "sent" | "undone" | "dismissed" | "failed";
export type PigeonTriggerStatus = "armed" | "fired" | "cancelled" | "failed";

export interface PigeonTriggerRecord {
  id: string;
  sessionId: string;
  targetSessionId: string;
  targetName: string;
  instruction: string;
  status: PigeonTriggerStatus;
  firedSummary: string;
  createdAt: number;
  firedAt: number | null;
}

export interface PigeonRelayRecord {
  id: string;
  sessionId: string;
  messageId: number | null;
  targetSessionId: string;
  targetName: string;
  mode: PigeonRelayKind;
  text: string;
  reason: string;
  status: PigeonRelayStatus;
  pigeonQueueId: number | null;
  pigeonMessageId: number | null;
  error: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ElementChip {
  selector: string;
  tag: string;
  label: string;
  text?: string;
  html?: string;
  xpath?: string;
  rect?: { x: number; y: number; width: number; height: number };
  note?: string;
  pinIndex?: number;
  attachmentName?: string;
}

export interface AttachmentRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  url: string;
}

export interface SessionRecord {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  repoSource: RepoSource;
  initialUrl: string;
  lastUrl: string;
  origin: string;
  pageTitle: string;
  state: SessionState;
  family: "AGY" | "CLAUDE";
  model: string;
  effort: string;
  harnessId: string;
  providerSessionId: string | null;
  pageAccess: boolean;
  pigeonRelayMode: PigeonRelayMode;
  questionSnippet: string;
  attentionState: AttentionKind;
  attentionDetail: string;
  attentionAt: number | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TabBindingRecord {
  tabId: number;
  sessionId: string;
  windowId: number | null;
  lastUrl: string;
  boundAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: number;
  sessionId: string;
  sender: "human" | "agent" | "system";
  time: string;
  text: string;
  chips: ElementChip[];
  attachments: AttachmentRecord[];
  isStreaming?: boolean;
  createdAt: number;
}

export interface HarnessEventRecord {
  id: number;
  sessionId: string;
  ts: string;
  kind: string;
  summary: string;
  createdAt: number;
}

export interface UrlRepoRule {
  id: number;
  pattern: string;
  repoPath: string;
  repoName: string;
  createdAt: number;
}

export interface SessionFull extends SessionRecord {
  tabId: number | null;
  messageCount: number;
  messages: MessageRecord[];
  events: HarnessEventRecord[];
  relays: PigeonRelayRecord[];
  triggers: PigeonTriggerRecord[];
}

export interface HistorySearchHit {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  lastUrl: string;
  origin: string;
  pageTitle: string;
  family: "AGY" | "CLAUDE";
  model: string;
  effort: string;
  state: SessionState;
  tabId: number | null;
  messageCount: number;
  snippet: string;
  updatedAt: number;
}

export function nowTimeShort(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function extractOrigin(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.origin;
    }
    return u.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

export function createDb(dbPath?: string): Database {
  const resolved =
    dbPath ||
    process.env.TAB_AGENT_DB ||
    join(import.meta.dir, "..", "data", "tab-agent.sqlite");
  if (resolved !== ":memory:") {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const conn = new Database(resolved, { create: true });
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA busy_timeout = 5000;");
  conn.exec("PRAGMA synchronous = NORMAL;");
  conn.exec("PRAGMA foreign_keys = ON;");

  conn.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      repo_source TEXT NOT NULL DEFAULT 'scratch',
      initial_url TEXT NOT NULL DEFAULT '',
      last_url TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT '',
      page_title TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'idle',
      family TEXT NOT NULL DEFAULT 'AGY',
      model TEXT NOT NULL DEFAULT 'NEON',
      effort TEXT NOT NULL DEFAULT 'low',
      harness_id TEXT NOT NULL DEFAULT 'agy-neon',
      provider_session_id TEXT,
      page_access INTEGER NOT NULL DEFAULT 0,
      question_snippet TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tab_bindings (
      tab_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      window_id INTEGER,
      last_url TEXT NOT NULL DEFAULT '',
      bound_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      time TEXT NOT NULL,
      text TEXT NOT NULL,
      chips TEXT NOT NULL DEFAULT '[]',
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS harness_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS url_repo_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL UNIQUE,
      repo_path TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pigeon_relays (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id INTEGER,
      target_session_id TEXT NOT NULL DEFAULT '',
      target_name TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'queue',
      text TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'staged',
      pigeon_queue_id INTEGER,
      pigeon_message_id INTEGER,
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS pigeon_triggers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      target_session_id TEXT NOT NULL,
      target_name TEXT NOT NULL DEFAULT '',
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'armed',
      fired_summary TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      fired_at INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED,
      name,
      last_url,
      origin,
      repo_name,
      page_title,
      body
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_origin ON sessions(origin, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bindings_session ON tab_bindings(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_session ON harness_events(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_relays_session ON pigeon_relays(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_triggers_session ON pigeon_triggers(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_triggers_armed ON pigeon_triggers(status, target_session_id);
  `);

  // Non-destructive migration for existing DBs created before attachments column
  const msgCols = conn.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!msgCols.some((c) => c.name === "attachments")) {
    conn.exec("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';");
  }

  // Non-destructive migration for Pigeon-Hole relay mode & persistent radar attention columns
  const sessCols = conn.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessCols.some((c) => c.name === "pigeon_relay_mode")) {
    conn.exec("ALTER TABLE sessions ADD COLUMN pigeon_relay_mode TEXT NOT NULL DEFAULT 'ask';");
  }
  if (!sessCols.some((c) => c.name === "attention_state")) {
    conn.exec("ALTER TABLE sessions ADD COLUMN attention_state TEXT NOT NULL DEFAULT '';");
  }
  if (!sessCols.some((c) => c.name === "attention_detail")) {
    conn.exec("ALTER TABLE sessions ADD COLUMN attention_detail TEXT NOT NULL DEFAULT '';");
  }
  if (!sessCols.some((c) => c.name === "attention_at")) {
    conn.exec("ALTER TABLE sessions ADD COLUMN attention_at INTEGER;");
  }

  return conn;
}

export class TabAgentStore {
  readonly db: Database;

  constructor(dbPath?: string) {
    this.db = createDb(dbPath);
  }

  close(): void {
    this.db.close();
  }

  private mapSessionRow(row: any): SessionRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      repoPath: String(row.repo_path),
      repoName: String(row.repo_name),
      repoSource: (row.repo_source || "scratch") as RepoSource,
      initialUrl: String(row.initial_url || ""),
      lastUrl: String(row.last_url || ""),
      origin: String(row.origin || ""),
      pageTitle: String(row.page_title || ""),
      state: (row.state || "idle") as SessionState,
      family: (row.family === "CLAUDE" ? "CLAUDE" : "AGY"),
      model: String(row.model || "NEON"),
      effort: String(row.effort || "low"),
      harnessId: String(row.harness_id || "agy-neon"),
      providerSessionId: row.provider_session_id ? String(row.provider_session_id) : null,
      pageAccess: Boolean(row.page_access),
      pigeonRelayMode: row.pigeon_relay_mode === "auto-queue" ? "auto-queue" : "ask",
      questionSnippet: String(row.question_snippet || ""),
      attentionState: (
        row.attention_state === "done" ||
        row.attention_state === "needs-you" ||
        row.attention_state === "error"
          ? row.attention_state
          : ""
      ) as AttentionKind,
      attentionDetail: String(row.attention_detail || ""),
      attentionAt: row.attention_at !== null && row.attention_at !== undefined ? Number(row.attention_at) : null,
      archived: Boolean(row.archived),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapMessageRow(row: any): MessageRecord {
    let chips: ElementChip[] = [];
    try {
      const parsed = JSON.parse(row.chips || "[]");
      if (Array.isArray(parsed)) chips = parsed;
    } catch {}
    let attachments: AttachmentRecord[] = [];
    try {
      const parsed = JSON.parse(row.attachments || "[]");
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {}
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      sender: row.sender as "human" | "agent" | "system",
      time: String(row.time),
      text: String(row.text),
      chips,
      attachments,
      createdAt: Number(row.created_at),
    };
  }

  private mapEventRow(row: any): HarnessEventRecord {
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      ts: String(row.ts),
      kind: String(row.kind),
      summary: String(row.summary),
      createdAt: Number(row.created_at),
    };
  }

  reindexSessionFts(sessionId: string): void {
    const sess = this.getSession(sessionId);
    this.db.query("DELETE FROM sessions_fts WHERE session_id = ?").run(sessionId);
    if (!sess) return;
    const msgs = this.db
      .query("SELECT text FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as Array<{ text: string }>;
    const body = msgs.map((m) => m.text).join("\n").slice(0, 60_000);
    this.db
      .query(
        `INSERT INTO sessions_fts (session_id, name, last_url, origin, repo_name, page_title, body)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sess.id,
        sess.name,
        sess.lastUrl,
        sess.origin,
        sess.repoName,
        sess.pageTitle,
        body
      );
  }

  createSession(input: {
    id: string;
    name: string;
    repoPath: string;
    repoName: string;
    repoSource: RepoSource;
    url?: string;
    pageTitle?: string;
    family?: "AGY" | "CLAUDE";
    model?: string;
    effort?: string;
    harnessId?: string;
    pageAccess?: boolean;
  }): SessionRecord {
    const now = Date.now();
    const url = input.url || "";
    const origin = extractOrigin(url);
    this.db
      .query(
        `INSERT INTO sessions (
          id, name, repo_path, repo_name, repo_source, initial_url, last_url, origin,
          page_title, state, family, model, effort, harness_id, provider_session_id,
          page_access, question_snippet, archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, NULL, ?, '', 0, ?, ?)`
      )
      .run(
        input.id,
        input.name,
        input.repoPath,
        input.repoName,
        input.repoSource,
        url,
        url,
        origin,
        input.pageTitle || "",
        input.family || "AGY",
        input.model || "NEON",
        input.effort || "low",
        input.harnessId || "agy-neon",
        input.pageAccess ? 1 : 0,
        now,
        now
      );
    this.reindexSessionFts(input.id);
    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? this.mapSessionRow(row) : null;
  }

  getSessionFull(id: string): SessionFull | null {
    const sess = this.getSession(id);
    if (!sess) return null;
    const binding = this.db
      .query("SELECT tab_id FROM tab_bindings WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(id) as { tab_id: number } | null;
    const messages = (
      this.db
        .query("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC")
        .all(id) as any[]
    ).map((r) => this.mapMessageRow(r));
    const events = (
      this.db
        .query("SELECT * FROM harness_events WHERE session_id = ? ORDER BY id DESC LIMIT 120")
        .all(id) as any[]
    )
      .reverse()
      .map((r) => this.mapEventRow(r));
    return {
      ...sess,
      tabId: binding ? Number(binding.tab_id) : null,
      messageCount: messages.length,
      messages,
      events,
      relays: this.listRelays(id),
      triggers: this.listTriggers(id),
    };
  }

  listSessions(limit = 100): SessionRecord[] {
    const rows = this.db
      .query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map((r) => this.mapSessionRow(r));
  }

  deleteSession(id: string): void {
    this.db.query("DELETE FROM sessions_fts WHERE session_id = ?").run(id);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  updateSessionName(id: string, name: string): void {
    this.db
      .query("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, Date.now(), id);
    this.reindexSessionFts(id);
  }

  updateSessionRepo(id: string, repoPath: string, repoName: string, repoSource: RepoSource): void {
    this.db
      .query(
        "UPDATE sessions SET repo_path = ?, repo_name = ?, repo_source = ?, updated_at = ? WHERE id = ?"
      )
      .run(repoPath, repoName, repoSource, Date.now(), id);
    this.reindexSessionFts(id);
  }

  updateSessionUrl(id: string, url: string, pageTitle?: string): void {
    const origin = extractOrigin(url);
    const now = Date.now();
    if (pageTitle !== undefined) {
      this.db
        .query(
          "UPDATE sessions SET last_url = ?, origin = ?, page_title = ?, updated_at = ? WHERE id = ?"
        )
        .run(url, origin, pageTitle, now, id);
    } else {
      this.db
        .query("UPDATE sessions SET last_url = ?, origin = ?, updated_at = ? WHERE id = ?")
        .run(url, origin, now, id);
    }
    this.reindexSessionFts(id);
  }

  updateSessionConfig(
    id: string,
    cfg: {
      family: "AGY" | "CLAUDE";
      model: string;
      effort: string;
      harnessId: string;
      resetProviderSession?: boolean;
    }
  ): void {
    const now = Date.now();
    if (cfg.resetProviderSession) {
      this.db
        .query(
          `UPDATE sessions
           SET family = ?, model = ?, effort = ?, harness_id = ?, provider_session_id = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(cfg.family, cfg.model, cfg.effort, cfg.harnessId, now, id);
    } else {
      this.db
        .query(
          `UPDATE sessions
           SET family = ?, model = ?, effort = ?, harness_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(cfg.family, cfg.model, cfg.effort, cfg.harnessId, now, id);
    }
  }

  updateProviderSessionId(id: string, providerSessionId: string | null): void {
    this.db
      .query("UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?")
      .run(providerSessionId, Date.now(), id);
  }

  updateSessionState(id: string, state: SessionState, snippet?: string): void {
    const now = Date.now();
    if (snippet !== undefined) {
      this.db
        .query("UPDATE sessions SET state = ?, question_snippet = ?, updated_at = ? WHERE id = ?")
        .run(state, snippet, now, id);
    } else {
      this.db
        .query("UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, id);
    }
  }

  setPageAccess(id: string, enabled: boolean): void {
    this.db
      .query("UPDATE sessions SET page_access = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  setPigeonRelayMode(id: string, mode: PigeonRelayMode): void {
    this.db
      .query("UPDATE sessions SET pigeon_relay_mode = ?, updated_at = ? WHERE id = ?")
      .run(mode === "auto-queue" ? "auto-queue" : "ask", Date.now(), id);
  }

  recoverStaleWorkingSessions(): number {
    const res = this.db
      .query("UPDATE sessions SET state = 'needs-you' WHERE state = 'working'")
      .run();
    return Number(res.changes || 0);
  }

  /* ---- Tab Bindings ---- */
  bindTab(tabId: number, sessionId: string, windowId: number | null = null, lastUrl = ""): TabBindingRecord {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO tab_bindings (tab_id, session_id, window_id, last_url, bound_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tab_id) DO UPDATE SET
           session_id = excluded.session_id,
           window_id = COALESCE(excluded.window_id, tab_bindings.window_id),
           last_url = CASE WHEN excluded.last_url != '' THEN excluded.last_url ELSE tab_bindings.last_url END,
           updated_at = excluded.updated_at`
      )
      .run(tabId, sessionId, windowId, lastUrl, now, now);
    this.db
      .query("UPDATE sessions SET archived = 0, updated_at = ? WHERE id = ?")
      .run(now, sessionId);
    return this.getTabBinding(tabId)!;
  }

  getTabBinding(tabId: number): TabBindingRecord | null {
    const row = this.db
      .query("SELECT * FROM tab_bindings WHERE tab_id = ?")
      .get(tabId) as any;
    if (!row) return null;
    return {
      tabId: Number(row.tab_id),
      sessionId: String(row.session_id),
      windowId: row.window_id !== null ? Number(row.window_id) : null,
      lastUrl: String(row.last_url || ""),
      boundAt: Number(row.bound_at),
      updatedAt: Number(row.updated_at),
    };
  }

  getTabIdForSession(sessionId: string): number | null {
    const row = this.db
      .query("SELECT tab_id FROM tab_bindings WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionId) as { tab_id: number } | null;
    return row ? Number(row.tab_id) : null;
  }

  setSessionAttention(sessionId: string, state: AttentionKind, detail = ""): boolean {
    const cur = this.getSession(sessionId);
    if (!cur) return false;
    const cleanDetail = state ? detail.slice(0, 200) : "";
    if (cur.attentionState === state && cur.attentionDetail === cleanDetail) return false;
    const at = state ? Date.now() : null;
    this.db
      .query("UPDATE sessions SET attention_state = ?, attention_detail = ?, attention_at = ? WHERE id = ?")
      .run(state, cleanDetail, at, sessionId);
    return true;
  }

  unbindTab(tabId: number): string | null {
    const existing = this.getTabBinding(tabId);
    if (!existing) return null;
    this.db.query("DELETE FROM tab_bindings WHERE tab_id = ?").run(tabId);
    const remaining = this.db
      .query("SELECT COUNT(*) as c FROM tab_bindings WHERE session_id = ?")
      .get(existing.sessionId) as { c: number };
    if (!remaining || remaining.c === 0) {
      this.db
        .query(
          "UPDATE sessions SET archived = 1, page_access = 0, attention_state = '', attention_detail = '', attention_at = NULL, updated_at = ? WHERE id = ?"
        )
        .run(Date.now(), existing.sessionId);
    }
    return existing.sessionId;
  }

  /**
   * Move a chat so it lives on exactly one tab: drop its other bindings, take over the target tab
   * (the chat previously on that tab is archived if it has no other tab), and return what changed.
   */
  moveSessionToTab(
    sessionId: string,
    tabId: number,
    windowId: number | null = null,
    lastUrl = ""
  ): { fromTabIds: number[]; displacedSessionId: string | null; binding: TabBindingRecord } {
    const run = this.db.transaction(() => {
      const fromTabIds = (
        this.db
          .query("SELECT tab_id FROM tab_bindings WHERE session_id = ? AND tab_id != ?")
          .all(sessionId, tabId) as Array<{ tab_id: number }>
      ).map((r) => Number(r.tab_id));
      const target = this.getTabBinding(tabId);
      const displacedSessionId = target && target.sessionId !== sessionId ? target.sessionId : null;

      this.db.query("DELETE FROM tab_bindings WHERE session_id = ? AND tab_id != ?").run(sessionId, tabId);
      const binding = this.bindTab(tabId, sessionId, windowId, lastUrl);

      if (displacedSessionId) {
        const remaining = this.db
          .query("SELECT COUNT(*) as c FROM tab_bindings WHERE session_id = ?")
          .get(displacedSessionId) as { c: number };
        if (!remaining || remaining.c === 0) {
          this.db
            .query("UPDATE sessions SET archived = 1, page_access = 0, updated_at = ? WHERE id = ?")
            .run(Date.now(), displacedSessionId);
        }
      }
      return { fromTabIds, displacedSessionId, binding };
    });
    return run();
  }

  /** Close a chat: take it off every tab and archive it. History stays; it can be attached again later. */
  closeSession(sessionId: string): number[] {
    const tabIds = (
      this.db.query("SELECT tab_id FROM tab_bindings WHERE session_id = ?").all(sessionId) as Array<{ tab_id: number }>
    ).map((r) => Number(r.tab_id));
    this.db.query("DELETE FROM tab_bindings WHERE session_id = ?").run(sessionId);
    this.db
      .query("UPDATE sessions SET archived = 1, page_access = 0, state = CASE WHEN state = 'working' THEN 'needs-you' ELSE state END, updated_at = ? WHERE id = ?")
      .run(Date.now(), sessionId);
    return tabIds;
  }

  listBindings(): TabBindingRecord[] {
    const rows = this.db
      .query("SELECT * FROM tab_bindings ORDER BY updated_at DESC")
      .all() as any[];
    return rows.map((row) => ({
      tabId: Number(row.tab_id),
      sessionId: String(row.session_id),
      windowId: row.window_id !== null ? Number(row.window_id) : null,
      lastUrl: String(row.last_url || ""),
      boundAt: Number(row.bound_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  /** Find most recent recoverable session for a given origin/domain (typically from a closed tab). */
  findRecentForOrigin(origin: string, excludeSessionId?: string): HistorySearchHit | null {
    if (!origin || !origin.startsWith("http")) return null;
    const row = this.db
      .query(
        `SELECT s.*,
          (SELECT tab_id FROM tab_bindings tb WHERE tb.session_id = s.id LIMIT 1) as bound_tab_id,
          (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as msg_count
         FROM sessions s
         WHERE s.origin = ?
           AND (? IS NULL OR s.id != ?)
           AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) > 0
         ORDER BY s.archived DESC, s.updated_at DESC
         LIMIT 1`
      )
      .get(origin, excludeSessionId ?? null, excludeSessionId ?? null) as any;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      repoPath: String(row.repo_path),
      repoName: String(row.repo_name),
      lastUrl: String(row.last_url || ""),
      origin: String(row.origin || ""),
      pageTitle: String(row.page_title || ""),
      family: row.family === "CLAUDE" ? "CLAUDE" : "AGY",
      model: String(row.model || "NEON"),
      effort: String(row.effort || "low"),
      state: (row.state || "idle") as SessionState,
      tabId: row.bound_tab_id !== null ? Number(row.bound_tab_id) : null,
      messageCount: Number(row.msg_count || 0),
      snippet: String(row.question_snippet || ""),
      updatedAt: Number(row.updated_at),
    };
  }

  /* ---- Messages & Events ---- */
  insertMessage(input: {
    sessionId: string;
    sender: "human" | "agent" | "system";
    text: string;
    chips?: ElementChip[];
    attachments?: AttachmentRecord[];
  }): MessageRecord {
    const now = Date.now();
    const time = nowTimeShort();
    const chipsJson = JSON.stringify(input.chips || []);
    const attJson = JSON.stringify(input.attachments || []);
    const res = this.db
      .query(
        `INSERT INTO messages (session_id, sender, time, text, chips, attachments, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.sessionId, input.sender, time, input.text, chipsJson, attJson, now);
    this.db
      .query("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(now, input.sessionId);
    this.reindexSessionFts(input.sessionId);
    const id = Number(res.lastInsertRowid);
    return {
      id,
      sessionId: input.sessionId,
      sender: input.sender,
      time,
      text: input.text,
      chips: input.chips || [],
      attachments: input.attachments || [],
      createdAt: now,
    };
  }

  updateMessageText(messageId: number, text: string, reindex = false): void {
    this.db.query("UPDATE messages SET text = ? WHERE id = ?").run(text, messageId);
    if (reindex) {
      const row = this.db
        .query("SELECT session_id FROM messages WHERE id = ?")
        .get(messageId) as { session_id: string } | null;
      if (row) this.reindexSessionFts(row.session_id);
    }
  }

  clearMessages(sessionId: string): void {
    this.db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.db
      .query("UPDATE sessions SET provider_session_id = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), sessionId);
    this.reindexSessionFts(sessionId);
  }

  insertEvent(input: { sessionId: string; kind: string; summary: string }): HarnessEventRecord {
    const now = Date.now();
    const ts = nowTimeShort();
    const res = this.db
      .query(
        `INSERT INTO harness_events (session_id, ts, kind, summary, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.sessionId, ts, input.kind, input.summary, now);
    return {
      id: Number(res.lastInsertRowid),
      sessionId: input.sessionId,
      ts,
      kind: input.kind,
      summary: input.summary,
      createdAt: now,
    };
  }

  /* ---- History FTS5 Search ---- */
  searchHistory(queryStr = "", limit = 40): HistorySearchHit[] {
    const q = queryStr.trim();
    if (!q) {
      const rows = this.db
        .query(
          `SELECT s.*,
            (SELECT tab_id FROM tab_bindings tb WHERE tb.session_id = s.id LIMIT 1) as bound_tab_id,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as msg_count
           FROM sessions s
           ORDER BY s.updated_at DESC
           LIMIT ?`
        )
        .all(limit) as any[];
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        repoPath: String(row.repo_path),
        repoName: String(row.repo_name),
        lastUrl: String(row.last_url || ""),
        origin: String(row.origin || ""),
        pageTitle: String(row.page_title || ""),
        family: row.family === "CLAUDE" ? "CLAUDE" : "AGY",
        model: String(row.model || "NEON"),
        effort: String(row.effort || "low"),
        state: (row.state || "idle") as SessionState,
        tabId: row.bound_tab_id !== null ? Number(row.bound_tab_id) : null,
        messageCount: Number(row.msg_count || 0),
        snippet: String(row.question_snippet || ""),
        updatedAt: Number(row.updated_at),
      }));
    }

    // Tokenise safely for FTS5 prefix matching (e.g. "acme-web.example spacing" -> '"acme-web"* "example"* "spacing"*')
    const tokens = q
      .replace(/["'()*:^~]/g, " ")
      .split(/[\s/]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return this.searchHistory("", limit);

    const ftsQuery = tokens.map((t) => `"${t}"*`).join(" AND ");
    try {
      const rows = this.db
        .query(
          `SELECT s.*,
            (SELECT tab_id FROM tab_bindings tb WHERE tb.session_id = s.id LIMIT 1) as bound_tab_id,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as msg_count,
            snippet(sessions_fts, 6, '', '', '…', 14) as match_snippet
           FROM sessions_fts f
           JOIN sessions s ON s.id = f.session_id
           WHERE sessions_fts MATCH ?
           ORDER BY bm25(sessions_fts), s.updated_at DESC
           LIMIT ?`
        )
        .all(ftsQuery, limit) as any[];
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        repoPath: String(row.repo_path),
        repoName: String(row.repo_name),
        lastUrl: String(row.last_url || ""),
        origin: String(row.origin || ""),
        pageTitle: String(row.page_title || ""),
        family: row.family === "CLAUDE" ? "CLAUDE" : "AGY",
        model: String(row.model || "NEON"),
        effort: String(row.effort || "low"),
        state: (row.state || "idle") as SessionState,
        tabId: row.bound_tab_id !== null ? Number(row.bound_tab_id) : null,
        messageCount: Number(row.msg_count || 0),
        snippet: String(row.match_snippet || row.question_snippet || ""),
        updatedAt: Number(row.updated_at),
      }));
    } catch {
      // Fallback LIKE search if FTS query syntax fails on unusual punctuation
      const like = `%${q}%`;
      const rows = this.db
        .query(
          `SELECT s.*,
            (SELECT tab_id FROM tab_bindings tb WHERE tb.session_id = s.id LIMIT 1) as bound_tab_id,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as msg_count
           FROM sessions s
           WHERE s.name LIKE ? OR s.last_url LIKE ? OR s.repo_name LIKE ? OR s.page_title LIKE ?
           ORDER BY s.updated_at DESC
           LIMIT ?`
        )
        .all(like, like, like, like, limit) as any[];
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        repoPath: String(row.repo_path),
        repoName: String(row.repo_name),
        lastUrl: String(row.last_url || ""),
        origin: String(row.origin || ""),
        pageTitle: String(row.page_title || ""),
        family: row.family === "CLAUDE" ? "CLAUDE" : "AGY",
        model: String(row.model || "NEON"),
        effort: String(row.effort || "low"),
        state: (row.state || "idle") as SessionState,
        tabId: row.bound_tab_id !== null ? Number(row.bound_tab_id) : null,
        messageCount: Number(row.msg_count || 0),
        snippet: String(row.question_snippet || ""),
        updatedAt: Number(row.updated_at),
      }));
    }
  }

  /* ---- URL -> Repo Rules ---- */
  listRules(): UrlRepoRule[] {
    const rows = this.db
      .query("SELECT * FROM url_repo_rules ORDER BY LENGTH(pattern) DESC, created_at DESC")
      .all() as any[];
    return rows.map((r) => ({
      id: Number(r.id),
      pattern: String(r.pattern),
      repoPath: String(r.repo_path),
      repoName: String(r.repo_name),
      createdAt: Number(r.created_at),
    }));
  }

  upsertRule(pattern: string, repoPath: string, repoName: string): UrlRepoRule {
    const norm = pattern.trim().toLowerCase();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO url_repo_rules (pattern, repo_path, repo_name, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pattern) DO UPDATE SET
           repo_path = excluded.repo_path,
           repo_name = excluded.repo_name`
      )
      .run(norm, repoPath, repoName, now);
    const row = this.db
      .query("SELECT * FROM url_repo_rules WHERE pattern = ?")
      .get(norm) as any;
    return {
      id: Number(row.id),
      pattern: String(row.pattern),
      repoPath: String(row.repo_path),
      repoName: String(row.repo_name),
      createdAt: Number(row.created_at),
    };
  }

  deleteRule(id: number): boolean {
    const res = this.db.query("DELETE FROM url_repo_rules WHERE id = ?").run(id);
    return Number(res.changes || 0) > 0;
  }

  /* ---- Pigeon-Hole Relays ---- */
  private mapRelayRow(row: any): PigeonRelayRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      messageId: row.message_id !== null && row.message_id !== undefined ? Number(row.message_id) : null,
      targetSessionId: String(row.target_session_id || ""),
      targetName: String(row.target_name || ""),
      mode: (row.mode === "steer" || row.mode === "send" ? row.mode : "queue") as PigeonRelayKind,
      text: String(row.text || ""),
      reason: String(row.reason || ""),
      status: String(row.status || "staged") as PigeonRelayStatus,
      pigeonQueueId: row.pigeon_queue_id !== null && row.pigeon_queue_id !== undefined ? Number(row.pigeon_queue_id) : null,
      pigeonMessageId: row.pigeon_message_id !== null && row.pigeon_message_id !== undefined ? Number(row.pigeon_message_id) : null,
      error: String(row.error || ""),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at !== null && row.resolved_at !== undefined ? Number(row.resolved_at) : null,
    };
  }

  insertRelay(input: {
    id: string;
    sessionId: string;
    messageId?: number | null;
    targetSessionId: string;
    targetName: string;
    mode: PigeonRelayKind;
    text: string;
    reason?: string;
    status?: PigeonRelayStatus;
    pigeonQueueId?: number | null;
    pigeonMessageId?: number | null;
    error?: string;
    resolvedAt?: number | null;
  }): PigeonRelayRecord {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO pigeon_relays (
          id, session_id, message_id, target_session_id, target_name, mode, text,
          reason, status, pigeon_queue_id, pigeon_message_id, error, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.sessionId,
        input.messageId ?? null,
        input.targetSessionId,
        input.targetName,
        input.mode,
        input.text,
        input.reason || "",
        input.status || "staged",
        input.pigeonQueueId ?? null,
        input.pigeonMessageId ?? null,
        input.error || "",
        now,
        input.resolvedAt ?? null
      );
    return this.getRelay(input.id)!;
  }

  getRelay(relayId: string): PigeonRelayRecord | null {
    const row = this.db.query("SELECT * FROM pigeon_relays WHERE id = ?").get(relayId);
    return row ? this.mapRelayRow(row) : null;
  }

  listRelays(sessionId: string, limit = 60): PigeonRelayRecord[] {
    const rows = this.db
      .query("SELECT * FROM pigeon_relays WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, limit) as any[];
    return rows.reverse().map((r) => this.mapRelayRow(r));
  }

  updateRelay(
    relayId: string,
    patch: Partial<
      Pick<
        PigeonRelayRecord,
        "targetSessionId" | "targetName" | "mode" | "text" | "status" | "pigeonQueueId" | "pigeonMessageId" | "error" | "resolvedAt"
      >
    >
  ): PigeonRelayRecord | null {
    const cur = this.getRelay(relayId);
    if (!cur) return null;
    const next = {
      targetSessionId: patch.targetSessionId !== undefined ? patch.targetSessionId : cur.targetSessionId,
      targetName: patch.targetName !== undefined ? patch.targetName : cur.targetName,
      mode: patch.mode !== undefined ? patch.mode : cur.mode,
      text: patch.text !== undefined ? patch.text : cur.text,
      status: patch.status !== undefined ? patch.status : cur.status,
      pigeonQueueId: patch.pigeonQueueId !== undefined ? patch.pigeonQueueId : cur.pigeonQueueId,
      pigeonMessageId: patch.pigeonMessageId !== undefined ? patch.pigeonMessageId : cur.pigeonMessageId,
      error: patch.error !== undefined ? patch.error : cur.error,
      resolvedAt: patch.resolvedAt !== undefined ? patch.resolvedAt : cur.resolvedAt,
    };
    this.db
      .query(
        `UPDATE pigeon_relays
         SET target_session_id = ?, target_name = ?, mode = ?, text = ?, status = ?,
             pigeon_queue_id = ?, pigeon_message_id = ?, error = ?, resolved_at = ?
         WHERE id = ?`
      )
      .run(
        next.targetSessionId,
        next.targetName,
        next.mode,
        next.text,
        next.status,
        next.pigeonQueueId,
        next.pigeonMessageId,
        next.error,
        next.resolvedAt,
        relayId
      );
    return this.getRelay(relayId);
  }

  /* ---- Pigeon-Hole /after Triggers ---- */
  private mapTriggerRow(row: any): PigeonTriggerRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      targetSessionId: String(row.target_session_id),
      targetName: String(row.target_name || row.target_session_id),
      instruction: String(row.instruction || ""),
      status: String(row.status || "armed") as PigeonTriggerStatus,
      firedSummary: String(row.fired_summary || ""),
      createdAt: Number(row.created_at),
      firedAt: row.fired_at !== null && row.fired_at !== undefined ? Number(row.fired_at) : null,
    };
  }

  insertTrigger(input: {
    id: string;
    sessionId: string;
    targetSessionId: string;
    targetName: string;
    instruction: string;
  }): PigeonTriggerRecord {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO pigeon_triggers (
          id, session_id, target_session_id, target_name, instruction, status, fired_summary, created_at, fired_at
        ) VALUES (?, ?, ?, ?, ?, 'armed', '', ?, NULL)`
      )
      .run(input.id, input.sessionId, input.targetSessionId, input.targetName, input.instruction, now);
    return this.getTrigger(input.id)!;
  }

  getTrigger(triggerId: string): PigeonTriggerRecord | null {
    const row = this.db.query("SELECT * FROM pigeon_triggers WHERE id = ?").get(triggerId);
    return row ? this.mapTriggerRow(row) : null;
  }

  listTriggers(sessionId?: string, limit = 30): PigeonTriggerRecord[] {
    if (sessionId) {
      const rows = this.db
        .query("SELECT * FROM pigeon_triggers WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(sessionId, limit) as any[];
      return rows.reverse().map((r) => this.mapTriggerRow(r));
    }
    const rows = this.db
      .query("SELECT * FROM pigeon_triggers ORDER BY created_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.reverse().map((r) => this.mapTriggerRow(r));
  }

  listArmedTriggers(targetSessionId?: string): PigeonTriggerRecord[] {
    if (targetSessionId) {
      const rows = this.db
        .query("SELECT * FROM pigeon_triggers WHERE status = 'armed' AND target_session_id = ? ORDER BY created_at ASC")
        .all(targetSessionId) as any[];
      return rows.map((r) => this.mapTriggerRow(r));
    }
    const rows = this.db
      .query("SELECT * FROM pigeon_triggers WHERE status = 'armed' ORDER BY created_at ASC")
      .all() as any[];
    return rows.map((r) => this.mapTriggerRow(r));
  }

  updateTriggerStatus(
    triggerId: string,
    status: PigeonTriggerStatus,
    firedSummary?: string
  ): PigeonTriggerRecord | null {
    const cur = this.getTrigger(triggerId);
    if (!cur) return null;
    const firedAt = status === "fired" ? Date.now() : cur.firedAt;
    this.db
      .query("UPDATE pigeon_triggers SET status = ?, fired_summary = ?, fired_at = ? WHERE id = ?")
      .run(status, firedSummary !== undefined ? firedSummary : cur.firedSummary, firedAt, triggerId);
    return this.getTrigger(triggerId);
  }
}
