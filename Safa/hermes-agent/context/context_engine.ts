/**
 * ContextEngine — Orchestrates context assembly for each turn.
 *
 * TypeScript adaptation of Stonic AI's context engine pattern.
 *
 * Assembles 3 parts of context (Stonic pattern):
 *   Part 1 — Memory bootstrap (frozen MEMORY.md snapshot)
 *   Part 2 — Session context restore (last N messages from current session)
 *   Part 3 — Relevant past conversation (FTS5 search on user prompt)
 *
 * Also provides compression hooks via the context compressor.
 */

import { sanitizeContext } from "../memory/streaming_scrubber";

export interface ContextAssemblyResult {
  /** Combined context string ready for system prompt injection */
  context: string;
  /** Token estimate of the memory portion */
  memoryTokenEstimate: number;
  /** Token estimate of the restore portion */
  restoreTokenEstimate: number;
  /** Whether restore context was found */
  hasRestore: boolean;
  /** Whether memory content exists */
  hasMemory: boolean;
}

export interface ContextAssemblyParams {
  userPrompt?: string;
  sessionId?: string;
  maxMemoryTokens?: number;
  maxRestoreMessages?: number;
  maxSearchResults?: number;
}

/** Rough token estimate: ~3.5 chars per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export interface ContextEngineDeps {
  /** Get the frozen memory snapshot text */
  getMemorySnapshot: () => string;
  /** Get recent session messages for restore */
  getRecentMessages: (sessionId: string, count: number) => Array<{ role: string; content: string }>;
  /** Search past conversations (FTS5) */
  searchHistory?: (query: string, limit: number) => Array<{ role: string; content: string; sessionTitle?: string }>;
  /** Get most recent session for cross-session restore */
  getMostRecentSession?: () => { id: string; title: string } | null;
  /** Get recent messages from a different session (cross-session) */
  getRecentMessagesForRestore?: (sessionId: string, count: number) => Array<{ role: string; content: string }>;
}

/**
 * Context engine that assembles memory + session + search context.
 * Mirrors Stonic AI's assembleContext pattern.
 */
export class ContextEngine {
  constructor(private deps: ContextEngineDeps) {}

  /**
   * Stonic-compatible 3-part context assembly:
   *   Part 1 — Memory bootstrap (frozen snapshot)
   *   Part 2 — Session context restore (last N messages)
   *   Part 3 — Relevant past conversation (FTS5 search)
   */
  assemble(params: ContextAssemblyParams): ContextAssemblyResult {
    const maxMemoryTokens = params.maxMemoryTokens || 9500;
    const maxRestoreMessages = params.maxRestoreMessages || 8;

    const parts: string[] = [];
    let memoryTokenEstimate = 0;
    let restoreTokenEstimate = 0;
    let hasMemory = false;
    let hasRestore = false;

    // Part 1: Memory bootstrap (frozen snapshot)
    const memSnapshot = this.deps.getMemorySnapshot();
    if (memSnapshot) {
      const clean = sanitizeContext(memSnapshot);
      const memTokens = estimateTokens(clean);
      if (memTokens <= maxMemoryTokens) {
        parts.push(`[PERSISTENT MEMORY]\n${clean}`);
        memoryTokenEstimate = memTokens;
        hasMemory = true;
      } else {
        const truncated = clean.slice(0, maxMemoryTokens * 4);
        parts.push(`[PERSISTENT MEMORY (truncated)]\n${truncated}...`);
        memoryTokenEstimate = maxMemoryTokens;
        hasMemory = true;
      }
    }

    // Part 2: Session context restore
    const sid = params.sessionId;
    if (sid) {
      try {
        const recent = this.deps.getRecentMessages(sid, maxRestoreMessages);
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
      } catch (e) {
        // Non-fatal
      }
    }

    // Cross-session: check most recent session if current session is empty
    if (!hasRestore && this.deps.getMostRecentSession && this.deps.getRecentMessagesForRestore) {
      try {
        const mostRecent = this.deps.getMostRecentSession();
        if (mostRecent && mostRecent.id !== sid) {
          const recentMsgs = this.deps.getRecentMessagesForRestore(mostRecent.id, maxRestoreMessages);
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
      } catch (e) {
        // Non-fatal
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

  /**
   * Async context assembly with search (for voice connect).
   * Adds Part 3: search past conversations via FTS5.
   */
  async assembleWithSearch(params: ContextAssemblyParams): Promise<string> {
    const assembled = this.assemble(params);

    // Part 3: Search past conversations
    let searchPart = "";
    if (params.userPrompt && params.userPrompt.trim() && this.deps.searchHistory) {
      try {
        const matches = this.deps.searchHistory(params.userPrompt, params.maxSearchResults || 3);
        if (matches.length > 0) {
          const formatted = matches
            .map(
              (m) =>
                `- ${m.sessionTitle ? `Session: ${m.sessionTitle} | ` : ""}${m.role === "user" ? "User" : "Safa"}: ${m.content}`
            )
            .join("\n");
          searchPart = `\n[RELEVANT PAST CONVERSATION]\n${formatted}`;
        }
      } catch (e) {
        // Non-fatal
      }
    }

    return assembled.context + searchPart;
  }
}
