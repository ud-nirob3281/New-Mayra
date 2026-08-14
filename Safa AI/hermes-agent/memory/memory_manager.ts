/**
 * MemoryManager — Orchestrates memory providers for the agent.
 *
 * TypeScript port of Stonic AI's hermes-agent/agent/memory_manager.py (MemoryManager).
 *
 * Single integration point. Delegates to registered providers.
 * Only ONE external plugin provider is allowed at a time — attempting to
 * register a second external provider is rejected with a warning.
 *
 * The builtin provider is always first. Only one non-builtin (external)
 * provider is allowed. Failures in one provider never block the other.
 *
 * Lifecycle wiring (mirrors Stonic's run_agent.py):
 *   manager.addProvider(builtinProvider);
 *   manager.addProvider(pluginProvider);  // optional, only one
 *
 *   promptParts.push(manager.buildSystemPrompt());
 *   context = manager.prefetchAll(userMessage);
 *   manager.syncAll(userMsg, assistantResponse);
 *   manager.queuePrefetchAll(userMsg);
 */

import { MemoryProvider, ToolSchema, ProviderInitOptions, MemoryWriteMetadata } from "./memory_provider";
import { StreamingContextScrubber, sanitizeContext, buildMemoryContextBlock } from "./streaming_scrubber";

export {
  StreamingContextScrubber,
  sanitizeContext,
  buildMemoryContextBlock,
};

export type { MemoryProvider, ToolSchema, ProviderInitOptions, MemoryWriteMetadata };

export class MemoryManager {
  private providers: MemoryProvider[] = [];
  private toolToProvider = new Map<string, MemoryProvider>();
  private hasExternal = false;
  private _sessionId: string = "";
  private _initialized = false;

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a memory provider.
   * Built-in provider (name "builtin") is always accepted.
   * Only ONE external (non-builtin) provider is allowed.
   */
  addProvider(provider: MemoryProvider): void {
    const isBuiltin = provider.name === "builtin";

    if (!isBuiltin) {
      if (this.hasExternal) {
        const existing =
          this.providers.find((p) => p.name !== "builtin")?.name || "unknown";
        console.warn(
          `[MemoryManager] Rejected memory provider '${provider.name}' — external provider '${existing}' is ` +
            `already registered. Only one external memory provider is allowed at a time.`
        );
        return;
      }
      this.hasExternal = true;
    }

    this.providers.push(provider);

    // Index tool names → provider for routing
    for (const schema of provider.getToolSchemas()) {
      if (schema.name && !this.toolToProvider.has(schema.name)) {
        this.toolToProvider.set(schema.name, provider);
      } else if (schema.name && this.toolToProvider.has(schema.name)) {
        console.warn(
          `[MemoryManager] Memory tool name conflict: '${schema.name}' already registered, ignoring from ${provider.name}`
        );
      }
    }

    console.info(
      `[MemoryManager] Memory provider '${provider.name}' registered (${provider.getToolSchemas().length} tools)`
    );
  }

  get providersList(): MemoryProvider[] {
    return [...this.providers];
  }

  getProvider(name: string): MemoryProvider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  getBuiltinProvider(): MemoryProvider | undefined {
    return this.providers.find((p) => p.name === "builtin");
  }

  // ── System prompt ─────────────────────────────────────────────────────────

  /**
   * Collect system prompt blocks from all providers.
   * Each non-empty block is included. Failures in one provider don't block others.
   */
  buildSystemPrompt(): string {
    const blocks: string[] = [];
    for (const provider of this.providers) {
      try {
        const block = provider.systemPromptBlock();
        if (block && block.trim()) blocks.push(block);
      } catch (e) {
        console.warn(`[MemoryManager] Provider '${provider.name}' systemPromptBlock() failed:`, e);
      }
    }
    return blocks.join("\n\n");
  }

  // ── Prefetch / recall ─────────────────────────────────────────────────────

  /**
   * Collect prefetch context from all providers.
   * Returns merged context text labeled by provider. Empty providers are skipped.
   */
  prefetchAll(query: string, sessionId?: string): string {
    const parts: string[] = [];
    for (const provider of this.providers) {
      try {
        const result = provider.prefetch(query, sessionId);
        if (result && result.trim()) parts.push(result);
      } catch (e) {
        // Non-fatal — one provider failing shouldn't block others
      }
    }
    return parts.join("\n\n");
  }

  /** Queue background prefetch on all providers for the next turn. */
  queuePrefetchAll(query: string, sessionId?: string): void {
    for (const provider of this.providers) {
      try {
        provider.queuePrefetch(query, sessionId);
      } catch (e) {
        // Non-fatal
      }
    }
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /** Sync a completed turn to all providers. */
  syncAll(userContent: string, assistantContent: string, sessionId?: string): void {
    for (const provider of this.providers) {
      try {
        provider.syncTurn(userContent, assistantContent, sessionId);
      } catch (e) {
        console.warn(`[MemoryManager] Provider '${provider.name}' syncTurn failed:`, e);
      }
    }
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  /** Collect tool schemas from all providers (deduplicated by name). */
  getAllToolSchemas(): ToolSchema[] {
    const schemas: ToolSchema[] = [];
    const seen = new Set<string>();
    for (const provider of this.providers) {
      try {
        for (const schema of provider.getToolSchemas()) {
          if (schema.name && !seen.has(schema.name)) {
            schemas.push(schema);
            seen.add(schema.name);
          }
        }
      } catch (e) {
        // Non-fatal
      }
    }
    return schemas;
  }

  getAllToolNames(): Set<string> {
    return new Set(this.toolToProvider.keys());
  }

  hasTool(toolName: string): boolean {
    return this.toolToProvider.has(toolName);
  }

  /** Route a tool call to the correct provider. Returns JSON string result. */
  handleToolCall(toolName: string, args: Record<string, any>): string {
    const provider = this.toolToProvider.get(toolName);
    if (!provider) {
      return JSON.stringify({ success: false, error: `No memory provider handles tool '${toolName}'` });
    }
    try {
      return provider.handleToolCall(toolName, args);
    } catch (e: any) {
      console.error(`[MemoryManager] Provider '${provider.name}' handleToolCall(${toolName}) failed:`, e);
      return JSON.stringify({ success: false, error: `Memory tool '${toolName}' failed: ${e.message}` });
    }
  }

  // ── Lifecycle hooks ───────────────────────────────────────────────────────

  onTurnStart(turnNumber: number, message: string, kwargs?: Record<string, any>): void {
    for (const provider of this.providers) {
      try {
        provider.onTurnStart(turnNumber, message, kwargs);
      } catch (e) {
        // Non-fatal
      }
    }
  }

  onSessionEnd(messages: Array<Record<string, any>>): void {
    for (const provider of this.providers) {
      try {
        provider.onSessionEnd(messages);
      } catch (e) {
        // Non-fatal
      }
    }
  }

  onSessionSwitch(
    newSessionId: string,
    options?: { parentSessionId?: string; reset?: boolean }
  ): void {
    if (!newSessionId) return;
    this._sessionId = newSessionId;
    for (const provider of this.providers) {
      try {
        provider.onSessionSwitch(newSessionId, options);
      } catch (e) {
        // Non-fatal
      }
    }
  }

  /**
   * Notify all providers before context compression.
   * Returns combined text from providers to include in the compression summary.
   */
  onPreCompress(messages: Array<Record<string, any>>): string {
    const parts: string[] = [];
    for (const provider of this.providers) {
      try {
        const result = provider.onPreCompress(messages);
        if (result && result.trim()) parts.push(result);
      } catch (e) {
        // Non-fatal
      }
    }
    return parts.join("\n\n");
  }

  /** Notify external providers when the built-in memory tool writes. */
  onMemoryWrite(
    action: string,
    target: string,
    content: string,
    metadata?: MemoryWriteMetadata
  ): void {
    for (const provider of this.providers) {
      if (provider.name === "builtin") continue;
      try {
        provider.onMemoryWrite(action, target, content, metadata);
      } catch (e) {
        // Non-fatal
      }
    }
  }

  onDelegation(task: string, result: string, childSessionId?: string): void {
    for (const provider of this.providers) {
      try {
        provider.onDelegation(task, result, childSessionId);
      } catch (e) {
        // Non-fatal
      }
    }
  }

  /** Initialize all providers. */
  initializeAll(sessionId: string, options?: ProviderInitOptions): void {
    if (this._initialized && this._sessionId === sessionId) return;
    this._sessionId = sessionId;
    this._initialized = true;
    for (const provider of this.providers) {
      try {
        provider.initialize(sessionId, options);
      } catch (e) {
        console.warn(`[MemoryManager] Provider '${provider.name}' initialize failed:`, e);
      }
    }
  }

  /** Shut down all providers (reverse order for clean teardown). */
  shutdownAll(): void {
    for (let i = this.providers.length - 1; i >= 0; i--) {
      try {
        this.providers[i].shutdown();
      } catch (e) {
        console.warn(`[MemoryManager] Provider '${this.providers[i].name}' shutdown failed:`, e);
      }
    }
    this._initialized = false;
  }
}
