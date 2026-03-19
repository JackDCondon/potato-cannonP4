import { stripAnsi } from "../../utils/strip-ansi.js";

/**
 * Extracts assistant text content from fragmented PTY stream-json output.
 *
 * Claude Code emits stream-json events, but the PTY wraps long lines with
 * ANSI cursor-positioning escapes, fragmenting JSON across multiple onData
 * chunks. This class buffers raw data, strips ANSI escapes, and attempts
 * to parse complete JSON objects to extract assistant text blocks.
 */
export class PtyTextExtractor {
  private buffer = "";

  /**
   * Feed raw PTY data. Returns any assistant text blocks found.
   * Call this from proc.onData().
   */
  feed(data: string): string[] {
    const stripped = stripAnsi(data);
    this.buffer += stripped;
    return this.tryExtract();
  }

  private tryExtract(): string[] {
    const texts: string[] = [];

    // Try to find complete JSON objects by scanning for newline-delimited boundaries.
    // stream-json format: one JSON object per logical line.
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const candidate = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!candidate) continue;

      // If the candidate doesn't start with '{', it's a continuation fragment.
      // Prepend it to... actually, with ANSI stripped, fragments are concatenated
      // in the buffer, so we need a different approach.
      // Try to parse; if it fails, the JSON may be incomplete (split across lines).
      try {
        const event = JSON.parse(candidate);
        const extracted = this.extractAssistantText(event);
        texts.push(...extracted);
      } catch {
        // Incomplete JSON — could be a fragment. Try accumulating with next line.
        // Put it back with the rest of the buffer for reassembly.
        this.buffer = candidate + this.buffer;
        // But we need to avoid infinite loops. If buffer has no more newlines,
        // break and wait for more data.
        break;
      }
    }

    // Safety: prevent unbounded buffer growth (e.g., binary garbage)
    if (this.buffer.length > 500_000) {
      this.buffer = this.buffer.slice(-10_000);
    }

    return texts;
  }

  private extractAssistantText(event: unknown): string[] {
    if (
      typeof event !== "object" ||
      event === null ||
      !("type" in event) ||
      (event as { type: string }).type !== "assistant"
    ) {
      return [];
    }

    const msg = (event as { message?: { content?: unknown[] } }).message;
    if (!msg?.content || !Array.isArray(msg.content)) return [];

    const texts: string[] = [];
    for (const block of msg.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type: string }).type === "text" &&
        "text" in block &&
        typeof (block as { text: unknown }).text === "string"
      ) {
        const text = (block as { text: string }).text.trim();
        if (text.length > 0) {
          texts.push(text);
        }
      }
    }

    return texts;
  }
}
