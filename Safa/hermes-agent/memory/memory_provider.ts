/**
 * MemoryProvider — Abstract base class for pluggable memory providers.
 *
 * TypeScript port of Stonic AI's hermes-agent/agent/memory_provider.py.
 *
 * Memory providers give the agent persistent recall across sessions.
 * The MemoryManager enforces a one-external-provider limit to prevent
 * tool schema bloat and conflicting memory backends.
 *
 * Lifecycle (called by MemoryManager):
 *   initialize()           — connect, create resources, warm up
 *   systemPromptBlock()     — static text for the system prompt
 *   prefetch(query)         — background recall before each turn
 *   queuePrefetch(query)    — queue recall for the NEXT turn
 *   syncTurn(user, asst)    — async write after each turn
 *   getToolSchemas()        — tool schemas to expose to the model
 *   handleToolCall()        — dispatch a tool call
 *   shutdown()              — clean exit
 *
 * Optional hooks (override to opt in):
 *   onTurnStart(turn, message)
 *   onSessionEnd(messages)
 *   onSessionSwitch(newSessionId)
 *   onPreCompress(messages) → string
 *   onMemoryWrite(action, target, content, metadata)
 *   onDelegation(task, result)
 */

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ConfigField {
  key: string;
  description: string;
  secret?: boolean;
  required?: boolean;
  default?: any;
  choices?: string[];
  url?: string;
  envVar?: string;
}

export interface ProviderInitOptions {
  hermesHome?: string;
  platform?: string;
  agentContext?: string;
  agentIdentity?: string;
  agentWorkspace?: string;
  parentSessionId?: string;
  userId?: string;
}

export interface MemoryWriteMetadata {
  writeOrigin?: string;
  executionContext?: string;
  sessionId?: string;
  parentSessionId?: string;
  platform?: string;
  toolName?: string;
}

/**
 * Abstract base class for memory providers.
 * External providers (Mem0, Supermemory, Hindsight, Honcho, etc.) are registered
 * and managed via MemoryManager. Only one external provider runs at a time.
 */
export abstract class MemoryProvider {
  /** Short identifier (e.g. 'builtin', 'mem0', 'hindsight'). */
  abstract get name(): string;

  // ── Core lifecycle (implement these) ────────────────────────────────────

  /**
   * Return true if this provider is configured, has credentials, and is ready.
   * Called during agent init to decide whether to activate the provider.
   * Should not make network calls — just check config and installed deps.
   */
  abstract isAvailable(): boolean;

  /**
   * Initialize for a session. Called once at startup.
   * May create resources (tables, connections), start background work, etc.
   */
  abstract initialize(sessionId: string, options?: ProviderInitOptions): void;

  /**
   * Return text to include in the system prompt.
   * For STATIC provider info (instructions, status). Prefetched recall context
   * is injected separately via prefetch(). Return "" to skip.
   */
  systemPromptBlock(): string {
    return "";
  }

  /**
   * Recall relevant context for the upcoming turn.
   * Called before each API call. Return formatted text to inject as context,
   * or "" if nothing relevant. Should be FAST — use background work for actual recall.
   */
  prefetch(query: string, sessionId?: string): string {
    return "";
  }

  /**
   * Queue a background recall for the NEXT turn.
   * Called after each turn completes. Default is no-op.
   */
  queuePrefetch(query: string, sessionId?: string): void {}

  /**
   * Persist a completed turn to the backend.
   * Should be non-blocking — queue for background processing if the backend has latency.
   */
  syncTurn(userContent: string, assistantContent: string, sessionId?: string): void {}

  /**
   * Return tool schemas this provider exposes.
   * Each schema follows the function calling format.
   * Return [] if this provider has no tools (context-only).
   */
  abstract getToolSchemas(): ToolSchema[];

  /**
   * Handle a tool call for one of this provider's tools.
   * Must return a JSON string (the tool result).
   * Only called for tool names returned by getToolSchemas().
   */
  handleToolCall(toolName: string, args: Record<string, any>): string {
    throw new Error(`Provider ${this.name} does not handle tool ${toolName}`);
  }

  /** Clean shutdown — flush queues, close connections. */
  shutdown(): void {}

  // ── Optional hooks (override to opt in) ─────────────────────────────────

  /** Called at the start of each turn with the user message. */
  onTurnStart(turnNumber: number, message: string, kwargs?: Record<string, any>): void {}

  /** Called when a session ends (explicit exit or timeout). */
  onSessionEnd(messages: Array<Record<string, any>>): void {}

  /**
   * Called when the agent switches session_id mid-process.
   * Fires on /resume, /branch, /reset, /new, and context compression.
   */
  onSessionSwitch(
    newSessionId: string,
    options?: { parentSessionId?: string; reset?: boolean }
  ): void {}

  /**
   * Called before context compression discards old messages.
   * Return text to include in the compression summary prompt so the
   * compressor preserves provider-extracted insights.
   */
  onPreCompress(messages: Array<Record<string, any>>): string {
    return "";
  }

  /**
   * Called when the built-in memory tool writes an entry.
   * Use to mirror built-in memory writes to your backend.
   */
  onMemoryWrite(
    action: string,
    target: string,
    content: string,
    metadata?: MemoryWriteMetadata
  ): void {}

  /** Called on the PARENT agent when a subagent completes. */
  onDelegation(task: string, result: string, childSessionId?: string): void {}

  /** Return config fields this provider needs for setup. */
  getConfigSchema(): ConfigField[] {
    return [];
  }
}
