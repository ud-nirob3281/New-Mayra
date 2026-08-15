/**
 * session_db.ts — Maira3 Persistent Session Database
 *
 * Upgraded from sql.js (WASM, no FTS5) to better-sqlite3 (native, full FTS5 + trigram).
 * Mirrors Stonic AI's state.db architecture (schema v11) while preserving Maira3's
 * TypeScript/Electron architecture and existing interfaces.
 *
 * Key improvements over maira2:
 * - Native FTS5 + trigram tokenizer (was broken in sql.js WASM)
 * - WAL mode with periodic checkpointing
 * - Session lineage via parent_session_id
 * - Cached prepared statements for performance
 * - Write contention retries with jitter (Stonic pattern)
 * - Token billing columns
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { DATA_DIR } from "./server_paths";
import { sanitizeContext } from "./memory_manager";

const DB_FILE = path.join(DATA_DIR, "session.sqlite");
const SCHEMA_VERSION = 3;

export type MessageType =
  | "user_voice" | "user_text"
  | "maira_thinking" | "maira_voice" | "maira_text"
  | "tool_result"
  | "safa_thinking" | "safa_voice" | "safa_text";

export type SessionRole = "user" | "model" | "system";

export interface ChatMessageRecord {
  id: string;
  session_id: string;
  role: SessionRole;
  content: string;
  message_type?: MessageType | string;
  thinking_summary?: string;
  tool_calls?: string;
  tool_results?: string;
  timestamp: string;
  rank?: number;
  snippet?: string;
  session_title?: string;
  tool_name?: string;
  token_count?: number;
  reasoning?: string;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  metadata?: string;
  source?: string;
  parent_session_id?: string | null;
  system_prompt?: string | null;
  model?: string | null;
  message_count?: number;
  tool_call_count?: number;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let dbInstance: Database.Database | null = null;
let fts5Supported = false;
let writeCount = 0;
const CHECKPOINT_INTERVAL = 50;

// Cached prepared statements (recreated after schema init)
let stmtGetSession: Database.Statement;
let stmtInsertSession: Database.Statement;
let stmtInsertMessage: Database.Statement;
let stmtUpdateSessionCounts: Database.Statement;
let stmtGetSessionMessages: Database.Statement;
let stmtGetAllRecentMessages: Database.Statement;
let stmtFtsSearch: Database.Statement;
let stmtLikeSearch: Database.Statement;
let stmtDupCheck: Database.Statement;
let stmtIdCheck: Database.Statement;
let stmtDeleteMessagesForSession: Database.Statement;
let stmtClearAllMessages: Database.Statement;
let stmtUpdateSessionPrompt: Database.Statement;
  let stmtUpdateSessionTitle: Database.Statement;
let stmtListSessions: Database.Statement;
let stmtUpdateSessionEnd: Database.Statement;
let stmtPruneOldSessions: Database.Statement;
let stmtContextPrev: Database.Statement;
let stmtContextNext: Database.Statement;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function decodeContent(content: any): string {
  const value = content == null ? "" : String(content);
  return sanitizeContext(value).trim();
}

function rowToMessage(row: any): ChatMessageRecord {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    role: row.role as SessionRole,
    content: decodeContent(row.content),
    message_type: row.message_type || (row.role === "user" ? "user_text" : "safa_text"),
    thinking_summary: row.thinking_summary || "",
    tool_calls: row.tool_calls || "",
    tool_results: row.tool_results || "",
    tool_name: row.tool_name || "",
    timestamp: row.timestamp,
    rank: typeof row.rank === "number" ? row.rank : undefined,
    snippet: row.snippet || undefined,
    session_title: row.session_title || undefined,
    token_count: row.token_count || undefined,
    reasoning: row.reasoning || undefined,
  };
}

/** Attempt a write with retries and random jitter (Stonic pattern: 15 retries, 20-150ms). */
function withWriteRetry<T>(fn: () => T, retries = 15): T {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return fn();
    } catch (err: any) {
      if (err.message?.includes("SQLITE_BUSY") && attempt < retries - 1) {
        const jitter = 20 + Math.floor(Math.random() * 130);
        const delay = Math.min(jitter * Math.pow(1.5, attempt), 1000);
        // Synchronous sleep via Atomics (Node 16+)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Write retry exhausted");
}

/** Periodic WAL checkpoint (every N writes, like Stonic). */
function maybeCheckpoint(): void {
  if (++writeCount >= CHECKPOINT_INTERVAL) {
    writeCount = 0;
    try {
      dbInstance!.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
  }
}

// ─── Database Initialization ────────────────────────────────────────────────

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const isNew = !fs.existsSync(DB_FILE) || fs.statSync(DB_FILE).size === 0;
  dbInstance = new Database(DB_FILE);

  // WAL mode for concurrent read performance (Stonic pattern)
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("busy_timeout = 5000");

  // ── Schema creation ──
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'maira-live',
      user_id TEXT,
      model TEXT,
      model_config TEXT,
      system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      message_type TEXT,
      thinking_summary TEXT,
      tool_results TEXT,
      timestamp TEXT NOT NULL,
      token_count INTEGER,
      finish_reason TEXT,
      reasoning TEXT,
      reasoning_content TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);

    CREATE TABLE IF NOT EXISTS state_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // ── Schema migration ──
  const metaVersion = dbInstance.prepare("SELECT value FROM state_meta WHERE key = 'schema_version'").get();
  const currentVersion = (metaVersion as any)?.value ? parseInt((metaVersion as any).value) : 0;

  // Migration: add missing columns to sessions
  if (currentVersion < 2) {
    const sessionColumns = [
      "source TEXT DEFAULT 'maira-live'",
      "user_id TEXT",
      "model TEXT",
      "model_config TEXT",
      "system_prompt TEXT",
      "parent_session_id TEXT",
      "started_at REAL",
      "ended_at REAL",
      "end_reason TEXT",
      "message_count INTEGER DEFAULT 0",
      "tool_call_count INTEGER DEFAULT 0",
      "input_tokens INTEGER DEFAULT 0",
      "output_tokens INTEGER DEFAULT 0",
      "cache_read_tokens INTEGER DEFAULT 0",
      "cache_write_tokens INTEGER DEFAULT 0",
      "title TEXT",
      "created_at TEXT",
      "updated_at TEXT",
      "metadata TEXT DEFAULT '{}'",
    ];
    for (const col of sessionColumns) {
      try { dbInstance.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch {}
    }

    const messageColumns = [
      "tool_call_id TEXT",
      "tool_calls TEXT",
      "tool_name TEXT",
      "message_type TEXT",
      "thinking_summary TEXT",
      "tool_results TEXT",
      "token_count INTEGER",
      "finish_reason TEXT",
      "reasoning TEXT",
      "reasoning_content TEXT",
    ];
    for (const col of messageColumns) {
      try { dbInstance.exec(`ALTER TABLE messages ADD COLUMN ${col}`); } catch {}
    }

    // Create state_meta table if missing
    try { dbInstance.exec(`CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT)`); } catch {}
  }

  // ── FTS5 migration: v3 converts the index from external-content to
  // standalone. The old external-content schema declared a `message_id`
  // column that does not exist in `messages`, so SQLite failed with
  // "no such column: T.message_id" whenever a message row was deleted
  // (e.g. session/transcript deletion). Standalone FTS5 stores its own
  // content, so all triggers (insert/update/delete) and search work.
  if (currentVersion < 3) {
    try {
      dbInstance.exec(`
        DROP TRIGGER IF EXISTS messages_fts_ai;
        DROP TRIGGER IF EXISTS messages_fts_ad;
        DROP TRIGGER IF EXISTS messages_fts_au;
        DROP TRIGGER IF EXISTS messages_fts_tri_ai;
        DROP TRIGGER IF EXISTS messages_fts_tri_ad;
        DROP TRIGGER IF EXISTS messages_fts_tri_au;
        DROP TABLE IF EXISTS messages_fts;
        DROP TABLE IF EXISTS messages_fts_trigram;
      `);
    } catch (migErr: any) {
      console.warn("[SessionDB] FTS rebuild (v3) failed:", migErr.message);
    }
  }

  // ── FTS5 (native — will always succeed with better-sqlite3) ──
  try {
    dbInstance.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        message_id UNINDEXED,
        session_id UNINDEXED,
        tool_name
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, message_id, session_id, tool_name) VALUES (
          new.rowid,
          COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '') || ' ' || COALESCE(new.thinking_summary, ''),
          new.id,
          new.session_id,
          COALESCE(new.tool_name, '')
        );
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, content, message_id, session_id, tool_name) VALUES (
          new.rowid,
          COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '') || ' ' || COALESCE(new.thinking_summary, ''),
          new.id,
          new.session_id,
          COALESCE(new.tool_name, '')
        );
      END;
    `);
    fts5Supported = true;
    console.log("[SessionDB] FTS5 + external content enabled (native better-sqlite3).");
  } catch (error) {
    console.error("[SessionDB] FTS5 creation failed (unexpected with better-sqlite3):", error);
    fts5Supported = false;
  }

  // Try to add trigram tokenizer FTS (Stonic pattern — for CJK/substring matching)
  try {
    dbInstance.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
        content,
        message_id UNINDEXED,
        session_id UNINDEXED,
        tokenize="trigram"
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_tri_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts_trigram(rowid, content, message_id, session_id) VALUES (
          new.rowid,
          COALESCE(new.content, ''),
          new.id,
          new.session_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_tri_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts_trigram WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_tri_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts_trigram WHERE rowid = old.rowid;
        INSERT INTO messages_fts_trigram(rowid, content, message_id, session_id) VALUES (
          new.rowid, COALESCE(new.content, ''), new.id, new.session_id
        );
      END;
    `);
    console.log("[SessionDB] Trigram FTS5 index created.");
  } catch (error) {
    console.warn("[SessionDB] Trigram FTS5 not available (requires custom tokenizer):", (error as any).message);
  }

  // ── Rebuild FTS index from existing rows (v3 migration / fresh start) ──
  // Populate standalone FTS tables so pre-existing history is searchable
  // and delete triggers stay consistent after the schema upgrade. Only runs
  // when the FTS table is empty, so it is idempotent across restarts.
  try {
    const ftsCount = (dbInstance.prepare("SELECT COUNT(*) AS c FROM messages_fts").get() as any).c;
    if (ftsCount === 0) {
      dbInstance.exec(`
        INSERT INTO messages_fts(rowid, content, message_id, session_id, tool_name)
        SELECT rowid, COALESCE(content, '') || ' ' || COALESCE(tool_name, '') || ' ' || COALESCE(tool_calls, '') || ' ' || COALESCE(thinking_summary, ''), id, session_id, COALESCE(tool_name, '')
        FROM messages;

        INSERT INTO messages_fts_trigram(rowid, content, message_id, session_id)
        SELECT rowid, COALESCE(content, ''), id, session_id
        FROM messages;
      `);
      console.log(`[SessionDB] FTS index rebuilt from existing messages.`);
    }
  } catch (reindexErr: any) {
    console.warn("[SessionDB] FTS reindex failed (non-fatal):", reindexErr.message);
  }

  // Update schema version
  dbInstance.prepare("INSERT OR REPLACE INTO state_meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);

  // ── Prepare cached statements ──
  prepareStatements();

  return dbInstance;
}

function prepareStatements(): void {
  const db = dbInstance!;
  stmtGetSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  stmtInsertSession = db.prepare(
    "INSERT INTO sessions (id, source, title, parent_session_id, created_at, updated_at, started_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  stmtInsertMessage = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, message_type, thinking_summary, tool_results, timestamp, finish_reason, reasoning, reasoning_content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmtUpdateSessionCounts = db.prepare(
    "UPDATE sessions SET updated_at = ?, message_count = COALESCE(message_count, 0) + 1, tool_call_count = COALESCE(tool_call_count, 0) + ? WHERE id = ?"
  );
  stmtGetSessionMessages = db.prepare("SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC");
  stmtGetAllRecentMessages = db.prepare(
    "SELECT m.*, s.title AS session_title FROM messages m LEFT JOIN sessions s ON s.id = m.session_id ORDER BY m.timestamp DESC LIMIT ?"
  );
  stmtFtsSearch = db.prepare(`
    SELECT m.*, s.title AS session_title, bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    LEFT JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  stmtLikeSearch = db.prepare(`
    SELECT m.*, s.title AS session_title
    FROM messages m
    LEFT JOIN sessions s ON s.id = m.session_id
    WHERE m.content LIKE ? OR m.thinking_summary LIKE ? OR m.tool_calls LIKE ? OR m.tool_results LIKE ?
    ORDER BY m.timestamp DESC
    LIMIT ?
  `);
  stmtDupCheck = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? AND role = ? AND content = ? ORDER BY timestamp DESC LIMIT 1"
  );
  stmtIdCheck = db.prepare("SELECT * FROM messages WHERE id = ?");
  stmtDeleteMessagesForSession = db.prepare("DELETE FROM messages WHERE session_id = ?");
  stmtClearAllMessages = db.prepare("DELETE FROM messages");
  stmtUpdateSessionPrompt = db.prepare("UPDATE sessions SET system_prompt = ?, updated_at = ? WHERE id = ?");
  stmtUpdateSessionTitle = db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?");
  stmtListSessions = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC");
  stmtUpdateSessionEnd = db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ?");
  stmtPruneOldSessions = db.prepare("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE ended_at < ? AND ended_at IS NOT NULL)");
  stmtContextPrev = db.prepare("SELECT * FROM messages WHERE session_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?");
  stmtContextNext = db.prepare("SELECT * FROM messages WHERE session_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?");
}

// ─── Session Operations ───────────────────────────────────────────────────────

export function getOrCreateSession(sessionId?: string, title?: string): ChatSessionRecord {
  const db = getDb();
  const id = sessionId || `maira-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const row = stmtGetSession.get(id) as any;
  if (row) {
    return {
      id: row.id,
      title: row.title || title || "Conversation",
      created_at: row.created_at || row.updated_at || nowIso(),
      updated_at: row.updated_at || row.created_at || nowIso(),
      metadata: row.metadata || "{}",
      source: row.source || "maira-live",
      parent_session_id: row.parent_session_id || null,
      system_prompt: row.system_prompt || null,
      model: row.model || null,
      message_count: row.message_count || 0,
      tool_call_count: row.tool_call_count || 0,
    };
  }

  const now = nowIso();
  withWriteRetry(() => {
    stmtInsertSession.run(id, "maira-live", title || "Conversation", null, now, now, Date.now() / 1000, "{}");
  });
  maybeCheckpoint();

  return { id, title: title || "Conversation", created_at: now, updated_at: now, metadata: "{}", source: "maira-live", parent_session_id: null };
}

export function updateSessionSystemPrompt(sessionId: string, systemPrompt: string): void {
  const db = getDb();
  getOrCreateSession(sessionId);
  withWriteRetry(() => {
    stmtUpdateSessionPrompt.run(systemPrompt, nowIso(), sessionId);
  });
  maybeCheckpoint();
}

export function renameSession(sessionId: string, title: string): void {
  const db = getDb();
  getOrCreateSession(sessionId);
  withWriteRetry(() => {
    stmtUpdateSessionTitle.run(title, nowIso(), sessionId);
  });
  maybeCheckpoint();
}

/** End the session with a reason (e.g. 'branched', 'compressed') so lineage stays intact. */
export function markSessionEnded(sessionId: string, reason: string): void {
  const db = getDb();
  withWriteRetry(() => {
    stmtUpdateSessionEnd.run(Date.now() / 1000, reason, nowIso(), sessionId);
  });
  maybeCheckpoint();
}

/**
 * Create a child session linked to a parent (compression lineage / branching).
 * Mirrors Stonic's compression split: the parent holds the old turns, the child
 * receives the continuation.
 */
export function createChildSession(parentId: string, title: string): ChatSessionRecord {
  const db = getDb();
  getOrCreateSession(parentId);
  const id = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = nowIso();
  withWriteRetry(() => {
    stmtInsertSession.run(id, "maira-live", title || "Conversation", parentId, now, now, Date.now() / 1000, "{}");
  });
  maybeCheckpoint();
  return { id, title: title || "Conversation", created_at: now, updated_at: now, metadata: "{}", source: "maira-live", parent_session_id: parentId };
}

/**
 * Walk parent_session_id forward from session_id and return the first descendant
 * that actually has message rows. Mirrors Stonic's resolve_resume_session_id:
 * after compression the messages live in the child, so /resume should point there.
 */
export function resolveResumeSessionId(sessionId: string): string {
  if (!sessionId) return sessionId;
  const db = getDb();

  const hasMessages = (sid: string): boolean => {
    try {
      const row = stmtGetSessionMessages.get(sid, 1) as any;
      return !!row;
    } catch {
      return false;
    }
  };

  if (hasMessages(sessionId)) return sessionId;

  let current = sessionId;
  const seen = new Set([current]);
  for (let i = 0; i < 32; i++) {
    try {
      const childRow = db
        .prepare("SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
        .get(current) as any;
      if (!childRow || !childRow.id || seen.has(childRow.id)) return sessionId;
      seen.add(childRow.id);
      if (hasMessages(childRow.id)) return childRow.id;
      current = childRow.id;
    } catch {
      return sessionId;
    }
  }
  return sessionId;
}

/** All session ids from the lineage root to the given tip (ancestors + self). */
export function getSessionLineage(sessionId: string): string[] {
  const db = getDb();
  const ids: string[] = [];
  let current: string | null = sessionId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    ids.unshift(current);
    seen.add(current);
    try {
      const row = db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get(current) as any;
      current = row?.parent_session_id || null;
    } catch {
      break;
    }
  }
  return ids;
}

/** Copy messages from a parent session into a branch/child session. */
export function copyMessagesToSession(sourceSessionId: string, targetSessionId: string): number {
  const db = getDb();
  const rows = stmtGetSessionMessages.all(sourceSessionId, 100000) as any[];
  let count = 0;
  withWriteRetry(() => {
    for (const row of rows) {
      try {
        stmtInsertMessage.run(
          row.id ? `${row.id}-${targetSessionId}` : undefined,
          targetSessionId,
          row.role,
          row.content,
          row.tool_call_id,
          row.tool_calls,
          row.tool_name,
          row.message_type,
          row.thinking_summary,
          row.tool_results,
          row.timestamp,
          row.finish_reason,
          row.reasoning,
          row.reasoning_content
        );
        count++;
      } catch {
        // skip duplicates
      }
    }
  });
  maybeCheckpoint();
  return count;
}

export function endSession(sessionId: string, reason?: string): void {
  const db = getDb();
  const now = Date.now() / 1000;
  withWriteRetry(() => {
    stmtUpdateSessionEnd.run(now, reason || "normal", nowIso(), sessionId);
  });
  maybeCheckpoint();
}

export function pruneOldSessions(olderThanDays: number = 90): number {
  const db = getDb();
  const cutoff = Date.now() / 1000 - (olderThanDays * 86400);
  let changes = 0;
  withWriteRetry(() => {
    const info = stmtPruneOldSessions.run(cutoff);
    changes = info.changes;
  });
  maybeCheckpoint();
  return changes;
}

// ─── Message Operations ───────────────────────────────────────────────────────

export function addSessionMessage(params: {
  id?: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  messageType?: MessageType | string;
  thinkingSummary?: string;
  toolCalls?: any;
  toolResults?: any;
  toolName?: string;
  toolCallId?: string;
  finishReason?: string;
  reasoning?: string;
  reasoningContent?: string;
}): ChatMessageRecord {
  const db = getDb();
  const { sessionId, role } = params;
  const content = decodeContent(params.content);
  getOrCreateSession(sessionId);

  // Idempotency: if same ID exists, return existing
  if (params.id) {
    const existing = stmtIdCheck.get(params.id) as any;
    if (existing) return rowToMessage(existing);
  }

  // Dedup: skip exact same content within 3 seconds
  const dup = stmtDupCheck.get(sessionId, role, content) as any;
  if (dup) {
    const previousTime = Date.parse(dup.timestamp || "");
    if (!Number.isNaN(previousTime) && Date.now() - previousTime < 3000) {
      return rowToMessage(dup);
    }
  }

  const msgId = params.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const timestamp = nowIso();
  const toolCalls = params.toolCalls ? JSON.stringify(params.toolCalls) : "";
  const toolResults = params.toolResults ? JSON.stringify(params.toolResults) : "";
  const messageType = params.messageType || (role === "user" ? "user_text" : "safa_text");

  withWriteRetry(() => {
    const info = stmtInsertMessage.run(
      msgId, sessionId, role, content,
      params.toolCallId || "",
      toolCalls, params.toolName || "",
      messageType, params.thinkingSummary || "",
      toolResults, timestamp,
      params.finishReason || "",
      params.reasoning || "",
      params.reasoningContent || ""
    );
    // Update session counters
    stmtUpdateSessionCounts.run(timestamp, toolCalls ? 1 : 0, sessionId);
  });
  maybeCheckpoint();

  return {
    id: msgId,
    session_id: sessionId,
    role,
    content,
    message_type: messageType,
    thinking_summary: params.thinkingSummary || "",
    tool_calls: toolCalls,
    tool_results: toolResults,
    timestamp,
  };
}

export function getSessionMessages(sessionId: string, limit: number = 100): ChatMessageRecord[] {
  const db = getDb();
  const rows = stmtGetSessionMessages.all(sessionId, limit) as any[];
  return rows.map(rowToMessage);
}

/** Get the last N messages for session context restore (Stonic pattern). */
export function getRecentMessagesForRestore(sessionId: string, count: number = 8): ChatMessageRecord[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?"
  ).all(sessionId, count) as any[];
  return rows.reverse().map(rowToMessage);
}

/** Get the most recently active session (for cross-session resume). */
export function getMostRecentSession(): ChatSessionRecord | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1"
  ).get() as any;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || "Conversation",
    created_at: row.created_at || nowIso(),
    updated_at: row.updated_at || nowIso(),
    metadata: row.metadata || "{}",
    source: row.source || "maira-live",
    parent_session_id: row.parent_session_id || null,
    system_prompt: row.system_prompt || null,
    model: row.model || null,
    message_count: row.message_count || 0,
  };
}

export function getAllRecentMessages(limit: number = 100): ChatMessageRecord[] {
  const db = getDb();
  const rows = stmtGetAllRecentMessages.all(limit) as any[];
  return rows.reverse().map(rowToMessage);
}

export function clearSessionMessages(sessionId?: string): void {
  const db = getDb();
  withWriteRetry(() => {
    if (sessionId) {
      stmtDeleteMessagesForSession.run(sessionId);
      db.prepare(
        "UPDATE sessions SET message_count = 0, tool_call_count = 0, updated_at = ? WHERE id = ?"
      ).run(nowIso(), sessionId);
    } else {
      stmtClearAllMessages.run();
      db.prepare("UPDATE sessions SET message_count = 0, tool_call_count = 0, updated_at = ?").run(nowIso());
    }
  });
  maybeCheckpoint();
}

/**
 * Permanently delete a session and its lineage (messages, FTS rows, child
 * sessions, and the session row itself). Matches Stonic's session removal.
 */
export function deleteSession(sessionId: string): void {
  const db = getDb();
  withWriteRetry(() => {
    // Delete the session and any child sessions created from it (lineage).
    const targets: string[] = [sessionId];
    const walk = (parent: string) => {
      const children = db
        .prepare("SELECT id FROM sessions WHERE parent_session_id = ?")
        .all(parent) as any[];
      for (const child of children) {
        if (targets.includes(child.id)) continue;
        targets.push(child.id);
        walk(child.id);
      }
    };
    walk(sessionId);

    for (const sid of targets) {
      db.prepare(
        "DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE session_id = ?)"
      ).run(sid);
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(sid);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    }
  });
  maybeCheckpoint();
}

// ─── Search ────────────────────────────────────────────────────────────────────

function sanitizeFtsQuery(query: string): string {
  // FTS5 special chars: " * ( ) : ^ ? and standalone punctuation that breaks
  // the query parser (e.g. Bengali text ending in "?" -> fts5 syntax error).
  return query
    .replace(/["*()^:?\\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(OR|AND|NOT)\b/gi, "");
}

function extractSearchTerms(query: string): string[] {
  const stopWords = new Set([
    "what", "was", "were", "the", "that", "this", "with", "from", "have", "told",
    "you", "your", "tell", "about", "previous", "conversation", "chat", "before",
    "remember", "recall", "please", "amar", "ami", "koro", "korte", "eita", "ota",
  ]);
  return Array.from(new Set((query || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}-]{4,}/gu) || []))
    .filter((term) => !stopWords.has(term))
    .slice(0, 8);
}

function fetchContextRows(db: Database.Database, matches: any[], window = 2): ChatMessageRecord[] {
  const byId = new Map<string, any>();
  for (const match of matches) {
    const ts = match.timestamp;
    const sid = match.session_id;

    const prevRows = stmtContextPrev.all(sid, ts, window) as any[];
    for (const row of prevRows) byId.set(String(row.id), row);

    byId.set(String(match.id), match);

    const nextRows = stmtContextNext.all(sid, ts, window) as any[];
    for (const row of nextRows) byId.set(String(row.id), row);
  }
  return Array.from(byId.values()).map(rowToMessage)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function searchSessionMessages(query: string, limit: number = 10): ChatMessageRecord[] {
  const db = getDb();
  const cleanQuery = (query || "").trim();
  if (!cleanQuery) return getAllRecentMessages(limit);

  const matches: any[] = [];

  // Strategy 1: FTS5 search (fast, ranked)
  if (fts5Supported) {
    try {
      const ftsQuery = sanitizeFtsQuery(cleanQuery);
      if (ftsQuery) {
        const rows = stmtFtsSearch.all(ftsQuery, limit) as any[];
        matches.push(...rows);
      }
    } catch (error) {
      console.warn("[SessionDB] FTS search failed; falling back to LIKE.", error);
    }
  }

  // Strategy 2: LIKE fallback (exact phrase match)
  if (!matches.length) {
    const likePattern = `%${cleanQuery}%`;
    const rows = stmtLikeSearch.all(likePattern, likePattern, likePattern, likePattern, limit) as any[];
    matches.push(...rows);
  }

  // Strategy 3: Individual search terms (token-level OR matching)
  if (!matches.length) {
    const terms = extractSearchTerms(cleanQuery);
    if (terms.length > 0) {
      const clauses = terms.map(() =>
        "(m.content LIKE ? OR m.thinking_summary LIKE ? OR m.tool_calls LIKE ? OR m.tool_results LIKE ?)"
      ).join(" OR ");

      const bindings = terms.flatMap(t => [ `%${t}%`, `%${t}%`, `%${t}%`, `%${t}%` ]);
      const rows = db.prepare(`
        SELECT m.*, s.title AS session_title
        FROM messages m
        LEFT JOIN sessions s ON s.id = m.session_id
        WHERE ${clauses}
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(...bindings, limit) as any[];
      matches.push(...rows);
    }
  }

  // Deduplicate by message id
  const seen = new Set<string>();
  const unique = matches.filter((m: any) => {
    const key = String(m.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return fetchContextRows(db, unique, 2);
}

export function formatSessionSearchResults(results: ChatMessageRecord[]): string {
  if (!results.length) return "No matching past conversation found.";
  return results.map((message) => {
    const speaker = message.role === "user" ? "User" : "Safa";
    return `- Session: ${message.session_title || message.session_id} | Time: ${message.timestamp} | ${speaker}: ${message.content}`;
  }).join("\n");
}

// ─── Session Listing ──────────────────────────────────────────────────────────

export function listSessions(): ChatSessionRecord[] {
  const db = getDb();
  const rows = stmtListSessions.all() as any[];
  return rows.map((row: any) => ({
    id: row.id,
    title: row.title || "Conversation",
    created_at: row.created_at || row.updated_at,
    updated_at: row.updated_at || row.created_at,
    metadata: row.metadata || "{}",
    source: row.source || "maira-live",
    parent_session_id: row.parent_session_id || null,
    system_prompt: row.system_prompt || null,
    model: row.model || null,
    message_count: row.message_count || 0,
    tool_call_count: row.tool_call_count || 0,
  }));
}

/**
 * Generate the next sequential chat title ("Chat 1", "Chat 2", ...).
 * Scans existing session titles so the numbering never collides.
 */
export function nextChatTitle(): string {
  const rows = listSessions();
  let max = 0;
  for (const s of rows) {
    const m = /^Chat\s+(\d+)$/i.exec((s.title || "").trim());
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `Chat ${max + 1}`;
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    dbInstance.close();
    dbInstance = null;
  }
}
