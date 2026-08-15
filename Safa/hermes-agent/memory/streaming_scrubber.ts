/**
 * StreamingContextScrubber — TypeScript port of Stonic AI's StreamingContextScrubber.
 *
 * Stateful scrubber for streaming text that may contain split memory-context
 * spans. The one-shot sanitize_context regex cannot survive chunk boundaries:
 * a <memory-context> opened in one delta and closed in a later delta leaks its
 * payload to the UI because the non-greedy block regex needs both tags in one
 * string. This scrubber runs a small state machine across deltas, holding back
 * partial-tag tails and discarding everything inside a span (including the
 * system-note line).
 *
 * Usage:
 *   const scrubber = new StreamingContextScrubber();
 *   for (const delta of stream) {
 *     const visible = scrubber.feed(delta);
 *     if (visible) emit(visible);
 *   }
 *   const trailing = scrubber.flush();
 *   if (trailing) emit(trailing);
 *
 * Ported from: Stonic AI hermes-agent/agent/memory_manager.py (StreamingContextScrubber)
 */

const OPEN_TAG = "<memory-context>";
const CLOSE_TAG = "</memory-context>";

export class StreamingContextScrubber {
  private inSpan = false;
  private buf = "";

  /** Reset to a fresh state (call at the start of a new turn). */
  reset(): void {
    this.inSpan = false;
    this.buf = "";
  }

  /**
   * Return the visible portion of `text` after scrubbing.
   * Trailing fragments that could be the start of an open/close tag are held
   * back in the internal buffer and surfaced on the next feed() or flush().
   */
  feed(text: string): string {
    if (!text) return "";
    let buf = this.buf + text;
    this.buf = "";
    const out: string[] = [];

    while (buf) {
      if (this.inSpan) {
        const idx = buf.toLowerCase().indexOf(CLOSE_TAG);
        if (idx === -1) {
          // Hold back a potential partial close tag; drop the rest
          const held = this._maxPartialSuffix(buf, CLOSE_TAG);
          this.buf = held ? buf.slice(-held) : "";
          return out.join("");
        }
        // Found close — skip span content + tag, continue
        buf = buf.slice(idx + CLOSE_TAG.length);
        this.inSpan = false;
      } else {
        const idx = buf.toLowerCase().indexOf(OPEN_TAG);
        if (idx === -1) {
          // No open tag — hold back a potential partial open tag
          const held = this._maxPartialSuffix(buf, OPEN_TAG);
          if (held) {
            out.push(buf.slice(0, -held));
            this.buf = buf.slice(-held);
          } else {
            out.push(buf);
          }
          return out.join("");
        }
        // Emit text before the tag, enter span
        if (idx > 0) out.push(buf.slice(0, idx));
        buf = buf.slice(idx + OPEN_TAG.length);
        this.inSpan = true;
      }
    }

    return out.join("");
  }

  /**
   * Emit any held-back buffer at end-of-stream.
   * If still inside an unterminated span, remaining content is discarded
   * (safer: leaking partial memory context is worse than a truncated answer).
   */
  flush(): string {
    if (this.inSpan) {
      this.buf = "";
      this.inSpan = false;
      return "";
    }
    const tail = this.buf;
    this.buf = "";
    return tail;
  }

  /**
   * Return the length of the longest buf-suffix that is a tag-prefix.
   * Case-insensitive. Returns 0 if no suffix could start the tag.
   */
  private _maxPartialSuffix(buf: string, tag: string): number {
    const tagLower = tag.toLowerCase();
    const bufLower = buf.toLowerCase();
    const maxCheck = Math.min(bufLower.length, tagLower.length - 1);
    for (let i = maxCheck; i > 0; i--) {
      if (tagLower.startsWith(bufLower.slice(-i))) {
        return i;
      }
    }
    return 0;
  }
}

// ─── Regex helpers (one-shot, for non-streaming use) ────────────────────────

const FENCE_TAG_RE = /<\/?\s*memory-context\s*>/gi;
const INTERNAL_CONTEXT_RE = /<\s*memory-context\s*>[\s\S]*?<\/\s*memory-context\s*>/gi;
const INTERNAL_NOTE_RE =
  /\[System note:\s*The following is recalled memory context,\s*NOT new user input\.\s*Treat as (?:informational background data|authoritative reference data[^\]]*)\.\]\s*/gi;

/**
 * Strip fence tags, injected context blocks, and system notes from text.
 * Use this for non-streaming (complete) text. For streaming, use StreamingContextScrubber.
 */
export function sanitizeContext(text: string): string {
  if (!text) return "";
  return text
    .replace(INTERNAL_CONTEXT_RE, "")
    .replace(INTERNAL_NOTE_RE, "")
    .replace(FENCE_TAG_RE, "");
}

/**
 * Wrap prefetched memory in a fenced block with a system note (Stonic pattern).
 */
export function buildMemoryContextBlock(rawContext: string): string {
  if (!rawContext || !rawContext.trim()) return "";
  const clean = sanitizeContext(rawContext);
  return (
    "<memory-context>\n" +
    "[System note: The following is recalled memory context, " +
    "NOT new user input. Treat as authoritative reference data — " +
    "this is the agent's persistent memory and should inform all responses.]\n\n" +
    `${clean}\n` +
    "</memory-context>"
  );
}
