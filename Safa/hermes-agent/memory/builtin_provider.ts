/**
 * BuiltinMemoryProvider — File-backed persistent memory provider.
 *
 * TypeScript port of Stonic AI's hermes-agent/tools/memory_tool.py (MemoryStore).
 *
 * Provides bounded, file-backed memory that persists across sessions:
 *   - MEMORY.md: curated long-term facts (§-delimited, frozen-snapshot injection)
 *
 * Key patterns from Stonic:
 *   - Frozen snapshot injection (memory loaded once at session start, not mutated mid-session)
 *   - Atomic writes with temp-file + rename
 *   - Cross-platform file locking
 *   - Injection/exfiltration content scanning
 *   - Character limits (model-independent)
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { MemoryProvider, ToolSchema, ProviderInitOptions, MemoryWriteMetadata } from "./memory_provider";

const ENTRY_DELIMITER = "\n§\n";

// ── Security: Injection/Exfiltration Scanner ────────────────────────────────

const MEMORY_THREAT_PATTERNS: Array<[RegExp, string]> = [
  // Prompt injection
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
  // Exfiltration via curl/wget with secrets
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  // Persistence/backdoors
  [/authorized_keys/i, "ssh_backdoor"],
  [/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access"],
  [/\$HOME\/\.hermes\/\.env|~\/\.hermes\/\.env/i, "hermes_env"],
];

const INVISIBLE_CHARS = new Set([
  "​", "‌", "‍", "⁠", "﻿",
  "‪", "‫", "‬", "‭", "‮",
]);

function scanMemoryContent(content: string): string | null {
  // Check invisible unicode
  for (const char of INVISIBLE_CHARS) {
    if (content.includes(char)) {
      return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} (possible injection).`;
    }
  }
  // Check threat patterns
  for (const [pattern, pid] of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content matches threat pattern '${pid}'. Memory entries are injected into the system prompt and must not contain injection or exfiltration payloads.`;
    }
  }
  return null;
}

// ── Atomic Write Helper ─────────────────────────────────────────────────────

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.mem_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmpPath, content, "utf-8");
  // Sync to disk before rename for durability. Open in read-write mode — a
  // read-only handle makes fsync fail with EPERM on Windows. fsync is purely
  // a durability optimization, so a failure is non-fatal.
  try {
    const fd = fs.openSync(tmpPath, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    // Non-fatal: the write already succeeded; only the flush is skipped.
  }
  fs.renameSync(tmpPath, filePath);
}

// ── File Locking (Cross-platform) ───────────────────────────────────────────

/**
 * Simple cross-platform file lock using a separate .lock file.
 * On Windows, uses fs-ext if available, otherwise falls back to mkdir-based locking.
 * On Unix, uses flock if available.
 */
class FileLock {
  private lockPath: string;
  private locked = false;

  constructor(private filePath: string) {
    this.lockPath = filePath + ".lock";
  }

  async acquire(): Promise<void> {
    const dir = path.dirname(this.lockPath);
    fs.mkdirSync(dir, { recursive: true });

    // Simple spin-lock with timeout
    const maxAttempts = 50;
    const delayMs = 20;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        // Try to create lock file exclusively
        const fd = fs.openSync(this.lockPath, "wx");
        fs.closeSync(fd);
        this.locked = true;
        return;
      } catch (e: any) {
        if (e.code === "EEXIST") {
          // Lock file exists, wait and retry
          await new Promise((r) => setTimeout(r, delayMs));
          attempts++;
          // Check for stale lock (older than 5 seconds)
          try {
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs > 5000) {
              // Stale lock, remove it
              fs.unlinkSync(this.lockPath);
            }
          } catch {
            // Lock was removed by another process
          }
        } else {
          throw e;
        }
      }
    }
    throw new Error(`Could not acquire lock for ${this.filePath} after ${maxAttempts} attempts`);
  }

  release(): void {
    if (this.locked) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // Ignore if already removed
      }
      this.locked = false;
    }
  }
}

async function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = new FileLock(filePath);
  await lock.acquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// ── MemoryStore Class ───────────────────────────────────────────────────────

interface MemorySnapshot {
  memory: string;
  user: string;
  timestamp: string;
}

/**
 * Bounded curated memory with file persistence.
 * Maintains two parallel states:
 *   - _systemPromptSnapshot: frozen at load time, used for system prompt injection.
 *     Never mutated mid-session. Keeps prefix cache stable.
 *   - memoryEntries: live state, mutated by tool calls, persisted to disk.
 *     Tool responses always reflect this live state.
 */
class MemoryStore {
  private memoryEntries: string[] = [];
  private memoryCharLimit: number;
  private systemPromptSnapshot: MemorySnapshot = {
    memory: "",
    user: "",
    timestamp: new Date().toISOString(),
  };

  private memoryDir: string;
  private memoryPath: string;

  constructor(options?: { dataDir?: string; charLimit?: number }) {
    this.memoryDir = options?.dataDir || path.join(os.homedir(), ".safa", "data");
    this.memoryPath = path.join(this.memoryDir, "MEMORY.md");
    this.memoryCharLimit = options?.charLimit || 3575; // 2200 + 1375 from Stonic
  }

  loadFromDisk(): void {
    fs.mkdirSync(this.memoryDir, { recursive: true });

    if (!fs.existsSync(this.memoryPath)) {
      fs.writeFileSync(this.memoryPath, "", "utf-8");
    }

    this.memoryEntries = this.readFile(this.memoryPath);

    // Deduplicate entries (preserves order, keeps first occurrence)
    this.memoryEntries = [...new Set(this.memoryEntries)];

    // Capture frozen snapshot for system prompt injection
    this.systemPromptSnapshot = {
      memory: this.renderBlock("memory", this.memoryEntries),
      user: "",
      timestamp: new Date().toISOString(),
    };
  }

  private readFile(filePath: string): string[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) return [];

    // Split by delimiter, handling legacy formats
    if (raw.includes("§")) {
      return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
    }
    // Legacy: line-based format
    return raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-*]\s*/, "").replace(/^\s*#+\s*/, "").trim())
      .filter(Boolean);
  }

  private writeFile(): void {
    const content = this.memoryEntries.join(ENTRY_DELIMITER);
    atomicWriteFile(this.memoryPath, content);
  }

  private charCount(entries: string[] = this.memoryEntries): number {
    if (!entries.length) return 0;
    return entries.join(ENTRY_DELIMITER).length;
  }

  private successResponse(message?: string): Record<string, any> {
    const current = this.charCount();
    const pct = Math.min(100, Math.floor((current / this.memoryCharLimit) * 100));
    return {
      success: true,
      target: "memory",
      entries: [...this.memoryEntries],
      usage: `${pct}% — ${current.toLocaleString()}/${this.memoryCharLimit.toLocaleString()} chars`,
      entry_count: this.memoryEntries.length,
      ...(message ? { message } : {}),
    };
  }

  private renderBlock(target: string, entries: string[]): string {
    if (!entries.length) return "";
    const content = entries.join(ENTRY_DELIMITER);
    const current = content.length;
    const pct = Math.min(100, Math.floor((current / this.memoryCharLimit) * 100));
    const header = target === "user"
      ? `USER PROFILE (who the user is) [${pct}% — ${current.toLocaleString()}/${this.memoryCharLimit.toLocaleString()} chars]`
      : `MEMORY (your personal notes) [${pct}% — ${current.toLocaleString()}/${this.memoryCharLimit.toLocaleString()} chars]`;
    const separator = "═".repeat(46);
    return `${separator}\n${header}\n${separator}\n${content}`;
  }

  // ── CRUD Operations ────────────────────────────────────────────────────────

  add(content: string): Record<string, any> {
    content = content.trim();
    if (!content) {
      return { success: false, error: "Content cannot be empty." };
    }

    const scanError = scanMemoryContent(content);
    if (scanError) {
      return { success: false, error: scanError };
    }

    // Check for duplicate
    if (this.memoryEntries.includes(content)) {
      return this.successResponse("Entry already exists (no duplicate added).");
    }

    // Check char limit
    const newEntries = [...this.memoryEntries, content];
    const newTotal = this.charCount(newEntries);

    if (newTotal > this.memoryCharLimit) {
      const current = this.charCount();
      return {
        success: false,
        error: `Memory at ${current.toLocaleString()}/${this.memoryCharLimit.toLocaleString()} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
        current_entries: this.memoryEntries,
        usage: `${current.toLocaleString()}/${this.memoryCharLimit.toLocaleString()}`,
      };
    }

    this.memoryEntries = newEntries;
    this.writeFile();

    return this.successResponse("Entry added.");
  }

  replace(oldText: string, newContent: string): Record<string, any> {
    oldText = oldText.trim();
    newContent = newContent.trim();

    if (!oldText) {
      return { success: false, error: "old_text cannot be empty." };
    }
    if (!newContent) {
      return { success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };
    }

    const scanError = scanMemoryContent(newContent);
    if (scanError) {
      return { success: false, error: scanError };
    }

    const matches = this.memoryEntries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.includes(oldText));

    if (!matches.length) {
      return { success: false, error: `No entry matched '${oldText}'.` };
    }

    if (matches.length > 1) {
      const uniqueEntries = new Set(matches.map((m) => m.entry));
      if (uniqueEntries.size > 1) {
        return {
          success: false,
          error: `Multiple entries matched '${oldText}'. Be more specific.`,
          matches: matches.map((m) => m.entry.slice(0, 80) + (m.entry.length > 80 ? "..." : "")),
        };
      }
    }

    const idx = matches[0].index;
    const testEntries = [...this.memoryEntries];
    testEntries[idx] = newContent;
    const newTotal = this.charCount(testEntries);

    if (newTotal > this.memoryCharLimit) {
      return {
        success: false,
        error: `Replacement would put memory at ${newTotal.toLocaleString()}/${this.memoryCharLimit.toLocaleString()} chars. Shorten the new content or remove other entries first.`,
      };
    }

    this.memoryEntries = testEntries;
    this.writeFile();

    return this.successResponse("Entry replaced.");
  }

  remove(oldText: string): Record<string, any> {
    oldText = oldText.trim();
    if (!oldText) {
      return { success: false, error: "old_text cannot be empty." };
    }

    const matches = this.memoryEntries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.includes(oldText));

    if (!matches.length) {
      return { success: false, error: `No entry matched '${oldText}'.` };
    }

    if (matches.length > 1) {
      const uniqueEntries = new Set(matches.map((m) => m.entry));
      if (uniqueEntries.size > 1) {
        return {
          success: false,
          error: `Multiple entries matched '${oldText}'. Be more specific.`,
          matches: matches.map((m) => m.entry.slice(0, 80) + (m.entry.length > 80 ? "..." : "")),
        };
      }
    }

    this.memoryEntries.splice(matches[0].index, 1);
    this.writeFile();

    return this.successResponse("Entry removed.");
  }

  read(): Record<string, any> {
    return this.successResponse();
  }

  // ── System Prompt Integration ──────────────────────────────────────────────

  getSnapshot(): MemorySnapshot {
    return { ...this.systemPromptSnapshot };
  }

  formatForSystemPrompt(): string | null {
    const block = this.systemPromptSnapshot.memory;
    return block || null;
  }

  getLiveEntries(): string[] {
    return [...this.memoryEntries];
  }

  getCharLimit(): number {
    return this.memoryCharLimit;
  }

  getPath(): string {
    return this.memoryPath;
  }
}

// ── Tool Schema ─────────────────────────────────────────────────────────────

const MEMORY_TOOL_SCHEMA: ToolSchema = {
  name: "memory",
  description: `Save durable information to persistent memory that survives across sessions. Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.

WHEN TO SAVE (do this proactively, don't wait to be asked):
- User corrects you or says 'remember this' / 'don't do that again'
- User shares a preference, habit, or personal detail (name, role, timezone, coding style)
- You discover something about the environment (OS, installed tools, project structure)
- You learn a convention, API quirk, or workflow specific to this user's setup
- You identify a stable fact that will be useful again in future sessions

PRIORITY: User preferences and corrections > environment facts > procedural knowledge. The most valuable memory prevents the user from having to repeat themselves.

Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to memory; use session_search to recall those from past transcripts.

ACTIONS: add (new entry), replace (update existing -- old_text identifies it), remove (delete -- old_text identifies it), read (list all entries).

SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.`,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "replace", "remove", "read"],
        description: "The action to perform.",
      },
      content: {
        type: "string",
        description: "The entry content. Required for 'add' and 'replace'.",
      },
      old_text: {
        type: "string",
        description: "Short unique substring identifying the entry to replace or remove.",
      },
    },
    required: ["action"],
  },
};

// ── BuiltinMemoryProvider ───────────────────────────────────────────────────

export class BuiltinMemoryProvider extends MemoryProvider {
  private store: MemoryStore | null = null;
  private dataDir: string;
  private sessionId: string = "";
  private onMemoryWriteHook?: (action: string, target: string, content: string, metadata?: MemoryWriteMetadata) => void;

  constructor(options?: { dataDir?: string; charLimit?: number }) {
    super();
    this.dataDir = options?.dataDir || path.join(os.homedir(), ".safa", "data");
  }

  get name(): string {
    return "builtin";
  }

  isAvailable(): boolean {
    return true; // Builtin provider is always available
  }

  initialize(sessionId: string, options?: ProviderInitOptions): void {
    this.sessionId = sessionId;
    this.store = new MemoryStore({
      dataDir: options?.hermesHome || this.dataDir,
    });
    this.store.loadFromDisk();
    console.log(`[BuiltinMemoryProvider] Initialized with session ${sessionId}. Loaded ${this.store.getLiveEntries().length} entries.`);
  }

  systemPromptBlock(): string {
    if (!this.store) return "";
    const block = this.store.formatForSystemPrompt();
    return block || "";
  }

  prefetch(_query: string, _sessionId?: string): string {
    // Builtin provider returns frozen snapshot via systemPromptBlock()
    // No dynamic prefetch needed
    return "";
  }

  syncTurn(_userContent: string, _assistantContent: string, _sessionId?: string): void {
    // Builtin provider doesn't auto-sync turns to MEMORY.md
    // Only explicit writes via the memory tool are persisted
  }

  getToolSchemas(): ToolSchema[] {
    return [MEMORY_TOOL_SCHEMA];
  }

  handleToolCall(toolName: string, args: Record<string, any>): string {
    if (toolName !== "memory") {
      return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` });
    }

    if (!this.store) {
      return JSON.stringify({ success: false, error: "Memory store not initialized." });
    }

    const action = (args.action || "").toLowerCase();
    let result: Record<string, any>;

    switch (action) {
      case "add":
        result = this.store.add(args.content || "");
        break;
      case "replace":
        result = this.store.replace(args.old_text || "", args.content || "");
        break;
      case "remove":
        result = this.store.remove(args.old_text || "");
        break;
      case "read":
        result = this.store.read();
        break;
      default:
        result = { success: false, error: `Unknown action '${action}'. Use: add, replace, remove, read.` };
    }

    // Notify external providers on successful write
    if (result.success && (action === "add" || action === "replace" || action === "remove")) {
      if (this.onMemoryWriteHook) {
        this.onMemoryWriteHook(action, "memory", args.content || args.old_text || "", {
          sessionId: this.sessionId,
          toolName: "memory",
        });
      }
    }

    return JSON.stringify(result);
  }

  // ── Additional Methods for Direct Access ───────────────────────────────────

  getStore(): MemoryStore | null {
    return this.store;
  }

  getLiveEntries(): string[] {
    return this.store?.getLiveEntries() || [];
  }

  getSnapshot(): MemorySnapshot | null {
    return this.store?.getSnapshot() || null;
  }

  setOnMemoryWriteHook(hook: (action: string, target: string, content: string, metadata?: MemoryWriteMetadata) => void): void {
    this.onMemoryWriteHook = hook;
  }
}
