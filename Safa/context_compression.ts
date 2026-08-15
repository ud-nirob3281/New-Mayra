/**
 * ContextCompressor — Intelligent context window compression.
 *
 * TypeScript adaptation of Stonic AI's ContextCompressor pattern.
 *
 * Upgrades Safa's basic truncation to Stonic-style compression:
 * - Token-aware budget management (absolute token counts, NOT fractions)
 * - Pre-compression memory extraction hook (preserve key facts)
 * - Condenses older turns while preserving recent verbatim
 * - Optionally uses LLM to generate a proper summary (not just truncation)
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
 * Estimate total tokens in dialogue history.
 */
export function estimateHistoryTokens(history: DialogueTurn[]): number {
  return history.reduce((sum, turn) => sum + estimateTokens(turn.text || ""), 0);
}

/**
 * Heuristic summarization (no LLM) — condenses older turns.
 */
function heuristicSummarize(olderTurns: DialogueTurn[]): string {
  const lines: string[] = ["[Earlier conversation summary:]"];

  for (const turn of olderTurns) {
    const speaker = turn.role === "user" ? "User" : "Safa";
    let snippet = turn.text.replace(/\s+/g, " ").trim();

    // Truncate long messages
    if (snippet.length > 200) {
      snippet = snippet.slice(0, 200) + "...";
    }

    lines.push(`${speaker}: ${snippet}`);
  }

  return lines.join("\n");
}

/**
 * Condenses older conversation turns into a succinct reference block
 * while preserving recent turns verbatim.
 *
 * Stonic pattern: absolute token budget, pre-compress hook, optional LLM summary.
 */
export function compressDialogueHistory(
  history: DialogueTurn[],
  options: CompressionOptions = DEFAULT_OPTIONS
): {
  compressedHistory: DialogueTurn[];
  summaryBlock: string;
  wasCompressed: boolean;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  savedTokens: number;
} {
  const originalTokens = estimateHistoryTokens(history);

  // No compression needed
  if (!isCompressionNeeded(history, options) || history.length <= (options.keepRecentTurns || 6)) {
    return {
      compressedHistory: history,
      summaryBlock: "",
      wasCompressed: false,
      originalTokenEstimate: originalTokens,
      compressedTokenEstimate: originalTokens,
      savedTokens: 0,
    };
  }

  const keepRecent = options.keepRecentTurns || 6;
  const splitIndex = Math.max(0, history.length - keepRecent);

  const olderTurns = history.slice(0, splitIndex);
  const recentTurns = history.slice(splitIndex);

  // Call pre-compress hook if provided (Stonic pattern)
  let preCompressInsights = "";
  if (options.onPreCompress) {
    try {
      preCompressInsights = options.onPreCompress(olderTurns) || "";
    } catch (e) {
      console.error("[ContextCompressor] onPreCompress hook failed:", e);
    }
  }

  // Generate summary (LLM or heuristic)
  let summaryBlock: string;

  if (options.llmSummarize) {
    // Async LLM summarization would need to be handled differently
    // For now, fall back to heuristic
    summaryBlock = heuristicSummarize(olderTurns);
  } else {
    summaryBlock = heuristicSummarize(olderTurns);
  }

  // Add pre-compress insights if any
  if (preCompressInsights.trim()) {
    summaryBlock = `[Key insights from earlier conversation:]\n${preCompressInsights}\n\n${summaryBlock}`;
  }

  // Build compressed history with summary as a system turn
  const compressedHistory: DialogueTurn[] = [
    { role: "system", text: summaryBlock },
    ...recentTurns,
  ];

  const compressedTokens = estimateHistoryTokens(compressedHistory);
  const savedTokens = Math.max(0, originalTokens - compressedTokens);

  console.log(
    `[ContextCompressor] Compressed ${history.length} turns → ${compressedHistory.length} ` +
      `(${originalTokens} → ${compressedTokens} tokens, saved ${savedTokens})`
  );

  return {
    compressedHistory,
    summaryBlock,
    wasCompressed: true,
    originalTokenEstimate: originalTokens,
    compressedTokenEstimate: compressedTokens,
    savedTokens,
  };
}

/**
 * Async version that supports LLM summarization.
 */
export async function compressDialogueHistoryAsync(
  history: DialogueTurn[],
  options: CompressionOptions = DEFAULT_OPTIONS
): Promise<{
  compressedHistory: DialogueTurn[];
  summaryBlock: string;
  wasCompressed: boolean;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  savedTokens: number;
}> {
  const originalTokens = estimateHistoryTokens(history);

  // No compression needed
  if (!isCompressionNeeded(history, options) || history.length <= (options.keepRecentTurns || 6)) {
    return {
      compressedHistory: history,
      summaryBlock: "",
      wasCompressed: false,
      originalTokenEstimate: originalTokens,
      compressedTokenEstimate: originalTokens,
      savedTokens: 0,
    };
  }

  const keepRecent = options.keepRecentTurns || 6;
  const splitIndex = Math.max(0, history.length - keepRecent);

  const olderTurns = history.slice(0, splitIndex);
  const recentTurns = history.slice(splitIndex);

  // Call pre-compress hook if provided (Stonic pattern)
  let preCompressInsights = "";
  if (options.onPreCompress) {
    try {
      preCompressInsights = options.onPreCompress(olderTurns) || "";
    } catch (e) {
      console.error("[ContextCompressor] onPreCompress hook failed:", e);
    }
  }

  // Generate summary (LLM or heuristic)
  let summaryBlock: string;

  if (options.llmSummarize) {
    try {
      summaryBlock = await options.llmSummarize(olderTurns);
    } catch (e) {
      console.error("[ContextCompressor] LLM summarization failed, falling back to heuristic:", e);
      summaryBlock = heuristicSummarize(olderTurns);
    }
  } else {
    summaryBlock = heuristicSummarize(olderTurns);
  }

  // Add pre-compress insights if any
  if (preCompressInsights.trim()) {
    summaryBlock = `[Key insights from earlier conversation:]\n${preCompressInsights}\n\n${summaryBlock}`;
  }

  // Build compressed history with summary as a system turn
  const compressedHistory: DialogueTurn[] = [
    { role: "system", text: summaryBlock },
    ...recentTurns,
  ];

  const compressedTokens = estimateHistoryTokens(compressedHistory);
  const savedTokens = Math.max(0, originalTokens - compressedTokens);

  console.log(
    `[ContextCompressor] Compressed ${history.length} turns → ${compressedHistory.length} ` +
      `(${originalTokens} → ${compressedTokens} tokens, saved ${savedTokens})`
  );

  return {
    compressedHistory,
    summaryBlock,
    wasCompressed: true,
    originalTokenEstimate: originalTokens,
    compressedTokenEstimate: compressedTokens,
    savedTokens,
  };
}

// Re-export for backward compatibility
export default {
  isCompressionNeeded,
  compressDialogueHistory,
  compressDialogueHistoryAsync,
  estimateHistoryTokens,
  estimateTokens,
};
