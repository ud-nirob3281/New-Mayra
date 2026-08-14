/**
 * memory_manager.ts — Safa Memory Manager (Stonic-Compatible Architecture)
 *
 * Two-tier persistent memory system mirroring Stonic AI's proven architecture:
 *   Tier A — MEMORY.md: curated long-term facts (§-delimited, frozen-snapshot injection)
 *   Tier B — session.sqlite: episodic/conversation history (FTS5 searchable, cross-session)
 *
 * This module exports a singleton `memoryManager` that wraps the hermes-agent
 * MemoryManager (provider orchestrator) with session DB integration for
 * context assembly, search, and persistence.
 *
 * Key patterns ported from Stonic:
 *   - Frozen-snapshot injection (memory loaded once at session start, not mutated mid-session)
 *   - Atomic writes with temp-file + rename
 *   - Injection/exfiltration content scanning
 *   - Cross-session context retrieval (last N messages + FTS5 search)
 *   - Session restore on reconnect (inject recent conversation context)
 */

import path from "path";
import crypto from "crypto";
import os from "os";
import { DATA_DIR } from "./server_paths";
import {
  addSessionMessage,
  getSessionMessages,
  searchSessionMessages,
  getOrCreateSession,
  getRecentMessagesForRestore,
  getMostRecentSession,
  ChatMessageRecord,
  formatSessionSearchResults,
} from "./session_db";
import {
  MemoryManager,
  BuiltinMemoryProvider,
  sanitizeContext as hermesSanitizeContext,
  StreamingContextScrubber,
  buildProvidersForSession,
} from "./hermes-agent";
import { BackgroundMemoryReviewer } from "./hermes-agent/memory/background_review";

const ENTRY_DELIMITER = "\n§\n";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  category: string;
  fact: string;
  timestamp: string;
}

export interface MemorySnapshot {
  agentMemory: string;
  userMemory: string;
  timestamp: string;
}

export interface ContextAssemblyResult {
  context: string;
  memoryTokenEstimate: number;
  restoreTokenEstimate: number;
  hasRestore: boolean;
  hasMemory: boolean;
}

type MemoryTarget = "MEMORY" | "USER";
type SessionRole = "user" | "model" | "system";

// ── Token Estimation ─────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 3.5);
}

// ── Sanitize Context (re-export from hermes-agent) ────────────────────────────

export function sanitizeContext(text: string): string {
  return hermesSanitizeContext(text);
}

// ── Singleton Memory Manager ──────────────────────────────────────────────────

/**
 * SafaMemoryManager wraps the hermes-agent MemoryManager with:
 * - Session DB integration (SQLite + FTS5)
 * - Context assembly (memory + session restore + search)
 * - Background review trigger
 * - Convenience methods for backward compatibility
 */
class SafaMemoryManager {
  private orchestrator: MemoryManager;
  private builtinProvider: BuiltinMemoryProvider;
  private dataDir: string;
  private _sessionId: string = "";
  private _turnCount: number = 0;
  private backgroundReviewer: BackgroundMemoryReviewer | null = null;

  constructor() {
    this.dataDir = DATA_DIR;
    this.orchestrator = new MemoryManager();
    this.builtinProvider = new BuiltinMemoryProvider({ dataDir: this.dataDir });
    this.orchestrator.addProvider(this.builtinProvider);

    // Activate the configured external memory plugin (Stonic pattern).
    try {
      for (const provider of buildProvidersForSession('')) {
        if (provider.name !== 'builtin') {
          this.orchestrator.addProvider(provider);
        }
      }
    } catch (e) {
      console.warn('[SafaMemoryManager] Plugin provider activation skipped:', e instanceof Error ? e.message : e);
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────

  initialize(sessionId?: string): void {
    if (sessionId) {
      this._sessionId = sessionId;
      this._turnCount = 0;
      this.orchestrator.initializeAll(sessionId, { hermesHome: this.dataDir });
      getOrCreateSession(sessionId);
    }
  }

  // ── Memory Tool (CRUD) ─────────────────────────────────────────────────────

  memoryTool(params: {
    action: string;
    target?: MemoryTarget | "memory" | "user";
    content?: string;
    oldText?: string;
    old_fact?: string;
  }): any {
    const action = (params.action || "").toLowerCase();
    const result = this.orchestrator.handleToolCall("memory", {
      action,
      content: params.content,
      old_text: params.oldText || params.old_fact,
    });
    try {
      return JSON.parse(result);
    } catch {
      return { success: false, error: "Failed to parse memory tool result" };
    }
  }

  addFact(target: MemoryTarget, _category: string, fact: string): boolean {
    return this.memoryTool({ action: "add", target, content: fact }).success === true;
  }

  updateFact(target: MemoryTarget, oldSubstring: string, newFact: string): boolean {
    return this.memoryTool({ action: "replace", target, content: newFact, oldText: oldSubstring }).success === true;
  }

  removeFact(target: MemoryTarget, textToMatch: string): boolean {
    return this.memoryTool({ action: "remove", target, oldText: textToMatch }).success === true;
  }

  readMemoryFile(_target: MemoryTarget = "MEMORY"): string {
    const entries = this.builtinProvider.getLiveEntries();
    return entries.join(ENTRY_DELIMITER);
  }

  writeMemoryFile(_target: MemoryTarget, content: string): void {
    // Parse content into entries and re-save
    const entries = content
      .split(ENTRY_DELIMITER)
      .map((e) => e.trim())
      .filter(Boolean);
    // Reset and add each entry
    for (const entry of entries) {
      this.memoryTool({ action: "add", content: entry });
    }
  }

  // ── System Prompt ──────────────────────────────────────────────────────────

  getMemorySnapshot(): MemorySnapshot {
    const snapshot = this.builtinProvider.getSnapshot();
    if (snapshot && "memory" in snapshot) {
      // Builtin provider returns { memory, user, timestamp }
      const s = snapshot as any;
      return {
        agentMemory: s.memory || "",
        userMemory: s.user || "",
        timestamp: s.timestamp || new Date().toISOString(),
      };
    }
    return { agentMemory: "", userMemory: "", timestamp: new Date().toISOString() };
  }

  formatForSystemPrompt(target: MemoryTarget = "MEMORY"): string | null {
    const block = this.orchestrator.buildSystemPrompt();
    return block || null;
  }

  buildSystemMemory(): string {
    return this.formatForSystemPrompt("MEMORY") || "";
  }

  getRelevantMemoryContext(_userPrompt?: string, _activeTaskContext?: string): string {
    return this.buildSystemMemory();
  }

  // ── Context Assembly (Stonic 3-part pattern) ────────────────────────────────

  assembleContext(params: {
    userPrompt?: string;
    sessionId?: string;
    maxMemoryTokens?: number;
    maxRestoreMessages?: number;
    maxSearchResults?: number;
  }): ContextAssemblyResult {
    const maxMemoryTokens = params.maxMemoryTokens || 9500;
    const maxRestoreMessages = params.maxRestoreMessages || 8;

    const parts: string[] = [];
    let memoryTokenEstimate = 0;
    let restoreTokenEstimate = 0;
    let hasMemory = false;
    let hasRestore = false;

    // Part 1: Memory bootstrap (frozen snapshot from providers)
    const memSnapshot = this.orchestrator.buildSystemPrompt();
    if (memSnapshot) {
      const memTokens = estimateTokens(memSnapshot);
      if (memTokens <= maxMemoryTokens) {
        parts.push(`[PERSISTENT MEMORY]\n${memSnapshot}`);
        memoryTokenEstimate = memTokens;
        hasMemory = true;
      } else {
        const truncated = memSnapshot.slice(0, maxMemoryTokens * 4);
        parts.push(`[PERSISTENT MEMORY (truncated)]\n${truncated}...`);
        memoryTokenEstimate = maxMemoryTokens;
        hasMemory = true;
      }
    }

    // Part 2: Session context restore
    const sid = params.sessionId || this._sessionId;
    if (sid) {
      try {
        const recent = getSessionMessages(sid, maxRestoreMessages);
        if (recent.length > 0) {
          const transcript = recent
            .map((m) => `${m.role === "user" ? "User" : "Safa"}: ${m.content}`)
            .join("\n");
          parts.push(
            `[SESSION CONTEXT RESTORE — last ${recent.length} messages from session ${sid}]\n` +
              `If the user asks what was just discussed, answer from this restored context first.\n\n${transcript}`
          );
          restoreTokenEstimate = estimateTokens(transcript);
          hasRestore = true;
        }
      } catch (err: any) {
        console.error("[SafaMemoryManager] Error fetching session messages:", err.message);
      }
    }

    // Cross-session: check most recent session if current is empty
    if (!hasRestore) {
      try {
        const mostRecent = getMostRecentSession();
        if (mostRecent && mostRecent.id !== sid) {
          const recentMsgs = getRecentMessagesForRestore(mostRecent.id, maxRestoreMessages);
          if (recentMsgs.length > 0) {
            const transcript = recentMsgs
              .map((m) => `${m.role === "user" ? "User" : "Safa"}: ${m.content}`)
              .join("\n");
            parts.push(
              `[CROSS-SESSION CONTEXT — most recent session "${mostRecent.title}" (${recentMsgs.length} messages)]\n${transcript}`
            );
            restoreTokenEstimate = estimateTokens(transcript);
            hasRestore = true;
          }
        }
      } catch (err: any) {
        console.error("[SafaMemoryManager] Error fetching cross-session context:", err.message);
      }
    }

    return {
      context: parts.join("\n\n"),
      memoryTokenEstimate,
      restoreTokenEstimate,
      hasRestore,
      hasMemory,
    };
  }

  async getAsyncRelevantMemoryContext(userPrompt?: string, sessionId?: string): Promise<string> {
    const assembled = this.assembleContext({ userPrompt, sessionId });

    // Part 3: Search past conversations
    let searchPart = "";
    if (userPrompt && userPrompt.trim()) {
      try {
        const matches = searchSessionMessages(userPrompt, 3);
        if (matches.length > 0) {
          searchPart = `\n[RELEVANT PAST CONVERSATION]\n${formatSessionSearchResults(matches)}`;
        }
      } catch (err: any) {
        console.error("[SafaMemoryManager] Error searching session history:", err.message);
      }
    }

    return assembled.context + searchPart;
  }

  async prefetchMemory(userPrompt?: string, sessionId?: string): Promise<string> {
    return this.getAsyncRelevantMemoryContext(userPrompt, sessionId);
  }

  async prefetch(query: string, sessionId?: string): Promise<string> {
    return this.prefetchMemory(query, sessionId);
  }

  // ── Session Sync ────────────────────────────────────────────────────────────

  async syncMemory(params: {
    sessionId: string;
    role: SessionRole;
    content: string;
    messageType?: string;
    thinkingSummary?: string;
    toolCalls?: any;
    toolResults?: any;
  }): Promise<ChatMessageRecord> {
    return this.saveSessionTurn(params);
  }

  async syncTurn(params: {
    sessionId: string;
    role: SessionRole;
    content: string;
    messageType?: string;
    thinkingSummary?: string;
    toolCalls?: any;
    toolResults?: any;
  }): Promise<ChatMessageRecord> {
    return this.syncMemory(params);
  }

  async saveSessionTurn(params: {
    sessionId: string;
    role: SessionRole;
    content: string;
    messageType?: string;
    thinkingSummary?: string;
    toolCalls?: any;
    toolResults?: any;
  }): Promise<ChatMessageRecord> {
    const sid = params.sessionId || this._sessionId || "safa-default";
    if (!this._sessionId && params.sessionId) {
      this._sessionId = params.sessionId;
    }
    getOrCreateSession(sid);

    // Increment turn count for user messages
    if (params.role === "user") {
      this._turnCount++;
      this.orchestrator.onTurnStart(this._turnCount, params.content);
    }

    return addSessionMessage({
      sessionId: sid,
      role: params.role,
      content: sanitizeContext(params.content || ""),
      messageType: params.messageType,
      thinkingSummary: params.thinkingSummary,
      toolCalls: params.toolCalls,
      toolResults: params.toolResults,
    });
  }

  // ── Session Search ──────────────────────────────────────────────────────────

  async searchSessionHistory(query: string, limit: number = 10): Promise<ChatMessageRecord[]> {
    return searchSessionMessages(query, limit);
  }

  async searchHistory(query: string, limit: number = 10): Promise<ChatMessageRecord[]> {
    return this.searchSessionHistory(query, limit);
  }

  async sessionSearch(params: {
    query?: string;
    limit?: number;
    sessionId?: string;
    aroundMessageId?: string;
    window?: number;
  }): Promise<any> {
    const limit = params.limit || 3;
    if (params.sessionId) {
      const messages = getSessionMessages(params.sessionId, params.window || 10);
      return { mode: "scroll", session_id: params.sessionId, messages };
    }
    if (!params.query || !params.query.trim()) {
      const messages = searchSessionMessages("", limit);
      return { mode: "browse", results: messages };
    }
    const results = searchSessionMessages(params.query, limit);
    return { mode: "discovery", query: params.query, results, formatted: formatSessionSearchResults(results) };
  }

  async getSessionHistory(sessionId: string, limit: number = 50): Promise<ChatMessageRecord[]> {
    return getSessionMessages(sessionId, limit);
  }

  async resumeSession(sessionId: string): Promise<ChatMessageRecord[]> {
    getOrCreateSession(sessionId);
    this._sessionId = sessionId;
    this.orchestrator.onSessionSwitch(sessionId, { reset: false });
    return getSessionMessages(sessionId, 100);
  }

  // ── Lifecycle Hooks ─────────────────────────────────────────────────────────

  onPreCompress(messages: Array<Record<string, any>>): string {
    return this.orchestrator.onPreCompress(messages);
  }

  onSessionEnd(): void {
    this.orchestrator.onSessionEnd([]);
    this._turnCount = 0;
  }

  onSessionSwitch(newSessionId: string, options?: { parentSessionId?: string; reset?: boolean }): void {
    this._sessionId = newSessionId;
    this._turnCount = 0;
    this.orchestrator.onSessionSwitch(newSessionId, options);
  }

  // ── Gemini Live Helpers ─────────────────────────────────────────────────────

  buildReplayTurns(dialogueHistory: { role: string; text: string }[], maxTurns: number = 6): any[] {
    if (!dialogueHistory.length) return [];
    const recent = dialogueHistory.slice(-maxTurns);
    return recent.map((item) => ({
      role: item.role === "model" ? "model" : "user",
      parts: [{ text: item.text }],
    }));
  }

  buildResumeDirective(): any {
    return {
      role: "user",
      parts: [{ text: "Resume from the restored conversation state and continue naturally. If we were in the middle of something, pick up where we left off." }],
    };
  }

  // ── Legacy Compatibility ────────────────────────────────────────────────────

  searchLongTermMemory(target: MemoryTarget): string {
    return this.readMemoryFile(target);
  }

  updateLongTermMemory(target: MemoryTarget, content: string): void {
    this.writeMemoryFile(target, content);
  }

  invalidateSnapshot(): void {
    // Re-initialize the builtin provider to refresh snapshot
    this.builtinProvider.initialize(this._sessionId, { hermesHome: this.dataDir });
  }

  // ── Provider Access ──────────────────────────────────────────────────────────

  getOrchestrator(): MemoryManager {
    return this.orchestrator;
  }

  getBuiltinProvider(): BuiltinMemoryProvider {
    return this.builtinProvider;
  }

  getLiveEntries(): string[] {
    return this.builtinProvider.getLiveEntries();
  }
}

// ── Singleton Export ──────────────────────────────────────────────────────────

export const memoryManager = new SafaMemoryManager();

// ── Background Review ──────────────────────────────────────────────────────────

export function triggerBackgroundMemoryReview(
  userMessage: string,
  assistantResponse: string,
  sessionId?: string,
  llmCall?: (systemPrompt: string, userPrompt: string) => Promise<string>
): void {
  if (!llmCall) return;
  if (!memoryManager["backgroundReviewer"]) {
    memoryManager["backgroundReviewer"] = new BackgroundMemoryReviewer({
      llmCall,
      saveFact: (_category, fact) => memoryManager.addFact("MEMORY", "", fact),
    });
  }
  memoryManager["backgroundReviewer"].reviewTurn(userMessage, assistantResponse, sessionId);
}

// ── Utility Exports ────────────────────────────────────────────────────────────

export async function getRelevantContextForPrompt(userPrompt: string, _apiKey?: string): Promise<string> {
  return memoryManager.getRelevantMemoryContext(userPrompt);
}

export function formatSystemInstructionsWithContext(base: string, ...rest: any[]): string {
  const memContext = memoryManager.buildSystemMemory();
  let result = memContext ? `${base}\n\n${memContext}` : base;

  // Stonic pattern: inject the prior conversation into the system instruction so
  // the model has permanent, uninterrupted access to the full history on resume.
  // This is more reliable than replaying turns via sendClientContent on Gemini
  // Live, which interrupts itself turn-by-turn.
  //
  // FIXED (Stonic parity): previously only the last 12 turns (2000 chars each)
  // were injected, so anything older than ~12 turns was invisible to the model
  // after a reconnect — it "forgot" earlier parts of the conversation. Stonic's
  // run_conversation(conversation_history=prior) hands over the ENTIRE stored
  // transcript, so we now inject up to 150 turns (12.5x the old window).
  const dialogueHistory = rest[2] as Array<{ role: string; text: string }> | undefined;
  if (Array.isArray(dialogueHistory) && dialogueHistory.length > 0) {
    const transcript = dialogueHistory
      .slice(-150)
      .map((t) => {
        const speaker = t.role === 'user' ? 'User' : assistantNameFor(dialogueHistory);
        return `${speaker}: ${(t.text || '').slice(0, 2000)}`;
      })
      .join('\n');
    result += `\n\n[PRIOR CONVERSATION CONTEXT (AUTHORITATIVE — this is our actual chat history, continue from here exactly)]\n${transcript}`;
  }
  return result;
}

function assistantNameFor(history: Array<{ role: string; text: string }>): string {
  // The assistant's display name isn't passed here; keep it neutral like Stonic.
  void history;
  return 'Safa';
}

export function getStableId(text: string): string {
  return crypto.createHash("sha1").update(text || "").digest("hex").slice(0, 16);
}

export async function loadMemories(): Promise<any[]> {
  const content = memoryManager.readMemoryFile("MEMORY");
  if (!content.trim()) return [];
  return content.split(ENTRY_DELIMITER).filter(Boolean).map((text) => ({
    id: getStableId(text),
    category: "behavior",
    text,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

export async function saveMemories(memories: any[]): Promise<void> {
  const entries = (memories || []).map((memory) => String(memory.text || memory.fact || "").trim()).filter(Boolean);
  memoryManager.writeMemoryFile("MEMORY", entries.join(ENTRY_DELIMITER));
}

export async function loadLearnedRules(): Promise<any[]> {
  return [];
}

export async function saveLearnedRules(_rules: any[]): Promise<void> {}

// ── Re-export StreamingContextScrubber ────────────────────────────────────────

export { StreamingContextScrubber };
