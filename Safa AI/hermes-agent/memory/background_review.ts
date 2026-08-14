/**
 * BackgroundMemoryReview — TypeScript port of Stonic AI's background memory review.
 *
 * After each conversation turn, spawns a background task to review the
 * transcript and decide if any durable facts should be saved to persistent
 * memory. This is how Stonic learns proactively without being asked.
 *
 * Ported from: Stonic AI hermes-agent/agent/background_review.py pattern.
 *
 * Key difference from Stonic: uses Node.js setImmediate/setTimeout instead of
 * Python threading.Thread. Non-blocking — never slows down the response.
 */

/**
 * Combined review prompt — Stonic-style memory vs skill distinction.
 *
 * Memory captures "who the user is and what the current situation is".
 * Skills capture "how to do this class of task for this user".
 * Safa has no skill library yet, so skill-shaped lessons are saved as
 * [behavior] / [workflow] memory facts until a skill store exists.
 */
export const MEMORY_REVIEW_PROMPT = `You are a memory curator for an AI companion named Safa.
Review the conversation turn and decide if any DURABLE facts should be saved.
Memory survives across sessions. Be ACTIVE — a pass that saves nothing is a missed learning opportunity when a real signal fired.

MEMORY (who the user is / current situation):
- Name, role, timezone, language, how they want to be addressed
- Personal details, habits, communication style
- Environment facts (OS, installed tools, project structure)
- Stable API quirks or project conventions that will matter later

SKILL-SHAPED LESSONS (how to do this class of task for this user):
- User corrected style, tone, format, verbosity ("stop doing X", "too verbose", "just give the answer")
- User corrected workflow, approach, or sequence of steps
- A non-trivial technique, fix, or tool-usage pattern a future session would benefit from
Save these as category "behavior" or "workflow" so the next session already knows.

PRIORITY: user corrections and preferences > identity > environment > procedural knowledge.
The most valuable memory prevents the user from having to repeat themselves.

DO NOT SAVE:
- Temporary task state, progress logs, completed-work recaps
- Trivial/obvious info, raw transcripts, things easily re-discovered
- Environment-dependent failures (missing binaries, unconfigured credentials)
- Negative claims about tools ("X is broken") that harden into self-refusals

Return JSON only:
{"save": [{"fact": "...", "category": "preference|identity|behavior|workflow|project|environment"}, ...], "skip_reason": "..."}
If nothing is worth saving, return {"save": [], "skip_reason": "..."}.`;

export interface MemoryReviewResult {
  save?: Array<{ fact: string; category: string }>;
  skip_reason?: string;
}

export interface BackgroundReviewOptions {
  /** Function to call the LLM for review (non-blocking). */
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** Function to save a fact to persistent memory. */
  saveFact: (category: string, fact: string) => Promise<boolean> | boolean;
  /** Maximum turns to keep in memory for review context. */
  maxContextTurns?: number;
}

/**
 * Background memory reviewer. After each turn, asynchronously reviews the
 * conversation and saves any durable facts. Never blocks the main response.
 */
export class BackgroundMemoryReviewer {
  private llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>;
  private saveFact: (category: string, fact: string) => Promise<boolean> | boolean;
  private maxContextTurns: number;
  private pendingReviews = new Set<Promise<void>>();
  private isReviewing = false;

  constructor(options: BackgroundReviewOptions) {
    this.llmCall = options.llmCall;
    this.saveFact = options.saveFact;
    this.maxContextTurns = options.maxContextTurns || 10;
  }

  /**
   * Spawn a background review of the latest conversation turn.
   * Non-blocking — returns immediately, work happens in the background.
   *
   * @param userMessage The user's latest message
   * @param assistantResponse The assistant's latest response
   * @param sessionId Current session ID for logging
   */
  reviewTurn(
    userMessage: string,
    assistantResponse: string,
    sessionId?: string
  ): void {
    if (this.isReviewing) return; // Skip if a review is already in progress
    if (!userMessage?.trim() || !assistantResponse?.trim()) return;

    // Skip trivial exchanges
    const totalLength = userMessage.length + assistantResponse.length;
    if (totalLength < 50) return;

    const reviewPromise = this._doReview(userMessage, assistantResponse, sessionId);
    this.pendingReviews.add(reviewPromise);
    reviewPromise.finally(() => this.pendingReviews.delete(reviewPromise));
  }

  private async _doReview(
    userMessage: string,
    assistantResponse: string,
    sessionId?: string
  ): Promise<void> {
    this.isReviewing = true;
    try {
      // Truncate to keep the review prompt small and fast
      const userSnippet = userMessage.slice(0, 500);
      const asstSnippet = assistantResponse.slice(0, 500);

      const userPrompt = `Conversation turn to review:

User: ${userSnippet}

Safa: ${asstSnippet}`;

      // Call LLM in the background (setImmediate ensures we don't block)
      const result = await new Promise<string>((resolve) => {
        setImmediate(async () => {
          try {
            const r = await this.llmCall(MEMORY_REVIEW_PROMPT, userPrompt);
            resolve(r);
          } catch (e) {
            resolve(""); // Fail silently — background review is best-effort
          }
        });
      });

      if (!result?.trim()) return;

      // Parse the JSON response
      let parsed: MemoryReviewResult;
      try {
        // Extract JSON from the response (may be wrapped in markdown code block)
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result);
      } catch {
        return; // Malformed JSON — skip silently
      }

      // Save each fact
      if (parsed.save && Array.isArray(parsed.save)) {
        for (const item of parsed.save) {
          if (item.fact && item.fact.trim()) {
            try {
              await this.saveFact(item.category || "memory", item.fact.trim());
              console.log(`[BackgroundReview] Saved fact: [${item.category}] ${item.fact.slice(0, 60)}…`);
            } catch (e) {
              // Fail silently — one bad save shouldn't stop the rest
            }
          }
        }
      }
    } catch (e) {
      // Background review is best-effort — never throw
      console.debug("[BackgroundReview] Review failed (non-fatal):", e);
    } finally {
      this.isReviewing = false;
    }
  }

  /** Wait for all pending reviews to complete (for graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingReviews]);
  }
}
