/**
 * ContextCompressor — Intelligent context window compression.
 *
 * TypeScript adaptation of Stonic AI's ContextCompressor pattern.
 *
 * Upgrades Maira3's basic truncation to Stonic-style compression:
 * - Token-aware budget management (absolute token counts, NOT fractions)
 * - Pre-compression memory extraction hook (preserve key facts)
 * - Condenses older turns while preserving recent verbatim
 * - Optionally uses LLM to generate a proper summary (not just truncation)
 *
 * This replaces context_compression.ts's basic approach with a richer one.
 */

export interface DialogueTurn {
  role: "user" | "model" | "system";
  text: string;
}

export interface CompressionResult {
  compressedHistory: DialogueTurn[];
  summaryBlock: string;
  wasCompressed: boolean;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  savedTokens: number;
}

export interface CompressionOptions {
  maxTurnsThreshold?: number;
  maxCharLength?: number;
  keepRecentTurns?: number;
  /** Hook to extract insights before compression (Stonic on_pre_compress) */
  onPreCompress?: (messages: DialogueTurn[]) => string;
  /** Optional LLM summarizer (if provided, uses LLM; otherwise uses heuristic) */
  llmSummarize?: (olderTurns: DialogueTurn[]) => Promise<string>;
}

const DEFAULT_OPTIONS: CompressionOptions = {
  maxTurnsThreshold: 16,
  maxCharLength: 12000,
  keepRecentTurns: 6,
};

/** Rough token estimate: ~3.5 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 3.5);
}

/**
 * Check if dialogue history exceeds context budget (Stonic pattern: absolute counts).
 */
export function isCompressionNeeded(
  history: DialogueTurn[],
  options: CompressionOptions = DEFAULT_OPTIONS
): boolean {
  const threshold = options.maxTurnsThreshold || 16;
  const maxChars = options.maxCharLength || 12000;

  if (history.length > threshold) return true;

  const totalChars = history.reduce((sum, h) => sum + (h.text ? h.text.length : 0), 0);
  return totalChars > maxChars;
}

/**
 * Condense older conversation turns into a summary block while preserving
 * recent turns verbatim. Uses Stonic's pre-compress hook to extract memory.
 */
export async function compressDialogueHistory(
  history: DialogueTurn[],
  options: CompressionOptions = DEFAULT_OPTIONS
): Promise<CompressionResult> {
  const keepRecent = options.keepRecentTurns || 6;

  if (!isCompressionNeeded(history, options) || history.length <= keepRecent) {
    const originalTokens = history.reduce((sum, h) => sum + estimateTokens(h.text), 0);
    return {
      compressedHistory: history,
      summaryBlock: "",
      wasCompressed: false,
      originalTokenEstimate: originalTokens,
      compressedTokenEstimate: originalTokens,
      savedTokens: 0,
    };
  }

  const splitIndex = Math.max(0, history.length - keepRecent);
  const olderTurns = history.slice(0, splitIndex);
  const recentTurns = history.slice(splitIndex);

  const originalTokenEstimate = history.reduce((sum, h) => sum + estimateTokens(h.text), 0);

  // ── Pre-compress hook: extract insights before discarding ──────────────
  // This is how Stonic preserves important facts that would otherwise be lost
  // during compression. The hook returns text to include in the summary.
  let preCompressInsights = "";
  if (options.onPreCompress) {
    try {
      preCompressInsights = options.onPreCompress(olderTurns) || "";
    } catch (e) {
      // Non-fatal
    }
  }

  // ── Generate summary ───────────────────────────────────────────────────
  let summaryBlock: string;

  if (options.llmSummarize) {
    // LLM-based summary (Stonic's preferred approach for quality)
    try {
      const llmSummary = await options.llmSummarize(olderTurns);
      summaryBlock = `[PRIOR DIALOGUE SUMMARY (LLM-COMPRESSED)]\n${llmSummary}`;
      if (preCompressInsights.trim()) {
        summaryBlock += `\n\n[EXTRACTED INSIGHTS]\n${preCompressInsights}`;
      }
    } catch (e) {
      // Fall back to heuristic if LLM fails
      summaryBlock = buildHeuristicSummary(olderTurns, preCompressInsights);
    }
  } else {
    // Heuristic summary (no LLM available — use condensation)
    summaryBlock = buildHeuristicSummary(olderTurns, preCompressInsights);
  }

  const compressedHistory: DialogueTurn[] = [
    { role: "system", text: summaryBlock },
    ...recentTurns,
  ];

  const compressedTokenEstimate = compressedHistory.reduce(
    (sum, h) => sum + estimateTokens(h.text),
    0
  );

  return {
    compressedHistory,
    summaryBlock,
    wasCompressed: true,
    originalTokenEstimate,
    compressedTokenEstimate,
    savedTokens: originalTokenEstimate - compressedTokenEstimate,
  };
}

/**
 * Build a heuristic summary by condensing each older turn to a snippet.
 * This is the fallback when no LLM is available (fast but less intelligent).
 */
function buildHeuristicSummary(
  olderTurns: DialogueTurn[],
  preCompressInsights: string
): string {
  const condensedLines: string[] = [];
  for (const turn of olderTurns) {
    const speaker = turn.role === "user" ? "User" : "Safa";
    let snippet = turn.text.replace(/\s+/g, " ").trim();
    if (snippet.length > 200) {
      snippet = snippet.substring(0, 200) + "...";
    }
    condensedLines.push(`${speaker}: ${snippet}`);
  }

  let summary = `[PRIOR DIALOGUE SUMMARY (CONDENSED)]\n${condensedLines.join("\n")}`;
  if (preCompressInsights.trim()) {
    summary += `\n\n[EXTRACTED INSIGHTS]\n${preCompressInsights}`;
  }
  return summary;
}

/**
 * Synchronous compression (for code paths that can't await).
 * Uses heuristic summarization only.
 */
export function compressDialogueHistorySync(
  history: DialogueTurn[],
  options: CompressionOptions = DEFAULT_OPTIONS
): CompressionResult {
  const keepRecent = options.keepRecentTurns || 6;

  if (!isCompressionNeeded(history, options) || history.length <= keepRecent) {
    const originalTokens = history.reduce((sum, h) => sum + estimateTokens(h.text), 0);
    return {
      compressedHistory: history,
      summaryBlock: "",
      wasCompressed: false,
      originalTokenEstimate: originalTokens,
      compressedTokenEstimate: originalTokens,
      savedTokens: 0,
    };
  }

  const splitIndex = Math.max(0, history.length - keepRecent);
  const olderTurns = history.slice(0, splitIndex);
  const recentTurns = history.slice(splitIndex);

  const originalTokenEstimate = history.reduce((sum, h) => sum + estimateTokens(h.text), 0);

  // Pre-compress hook
  let preCompressInsights = "";
  if (options.onPreCompress) {
    try {
      preCompressInsights = options.onPreCompress(olderTurns) || "";
    } catch (e) {}
  }

  const summaryBlock = buildHeuristicSummary(olderTurns, preCompressInsights);
  const compressedHistory: DialogueTurn[] = [
    { role: "system", text: summaryBlock },
    ...recentTurns,
  ];

  const compressedTokenEstimate = compressedHistory.reduce(
    (sum, h) => sum + estimateTokens(h.text),
    0
  );

  return {
    compressedHistory,
    summaryBlock,
    wasCompressed: true,
    originalTokenEstimate,
    compressedTokenEstimate,
    savedTokens: originalTokenEstimate - compressedTokenEstimate,
  };
}
