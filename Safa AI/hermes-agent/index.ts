/**
 * hermes-agent — TypeScript adaptation of Stonic AI's Hermes Agent framework.
 *
 * This module provides the memory, context, and provider infrastructure that
 * powers Maira3's conversation system. It mirrors Stonic AI's architecture but
 * is implemented in TypeScript for the Electron/Node.js runtime.
 *
 * Architecture:
 *   hermes-agent/
 *   ├── memory/
 *   │   ├── memory_provider.ts      — Abstract provider interface (lifecycle)
 *   │   ├── memory_manager.ts       — Orchestrator (builtin + 1 external provider)
 *   │   ├── streaming_scrubber.ts   — Stateful <memory-context> tag scrubber
 *   │   └── background_review.ts    — Proactive memory extraction after each turn
 *   ├── context/
 *   │   ├── context_engine.ts       — 3-part context assembly (memory+session+search)
 *   │   └── context_compressor.ts   — Token-aware compression with pre-compress hook
 *   └── index.ts                    — This barrel export
 *
 * Usage:
 *   import { MemoryManager, ContextEngine, StreamingContextScrubber } from './hermes-agent';
 */

// ── Memory ──────────────────────────────────────────────────────────────────
export { MemoryManager } from "./memory/memory_manager";
export { MemoryProvider } from "./memory/memory_provider";
export { BuiltinMemoryProvider } from "./memory/builtin_provider";
export type {
  ToolSchema,
  ConfigField,
  ProviderInitOptions,
  MemoryWriteMetadata,
} from "./memory/memory_provider";

// ── Memory plugins ──────────────────────────────────────────────────────────
// Importing a plugin module registers itself with the plugin registry.
import "./memory/plugins/http_memory_provider";
export {
  registerMemoryPlugin,
  listMemoryPlugins,
  buildProvidersForSession,
  resolveActiveProviderName,
} from "./memory/plugin_registry";
export type { MemoryPluginManifest } from "./memory/plugin_registry";

export {
  StreamingContextScrubber,
  sanitizeContext,
  buildMemoryContextBlock,
} from "./memory/streaming_scrubber";

export {
  BackgroundMemoryReviewer,
  MEMORY_REVIEW_PROMPT,
} from "./memory/background_review";
export type { MemoryReviewResult, BackgroundReviewOptions } from "./memory/background_review";

// ── Context ─────────────────────────────────────────────────────────────────
export { ContextEngine, estimateTokens } from "./context/context_engine";
export type { ContextAssemblyResult, ContextAssemblyParams, ContextEngineDeps } from "./context/context_engine";

export {
  compressDialogueHistory,
  compressDialogueHistorySync,
  isCompressionNeeded,
} from "./context/context_compressor";
export type {
  DialogueTurn,
  CompressionResult,
  CompressionOptions,
} from "./context/context_compressor";
