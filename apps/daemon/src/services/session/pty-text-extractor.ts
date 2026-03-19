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

      // Non-JSON lines (e.g. Claude Code startup banners, status lines) never
      // start with '{'. Discard them immediately so they cannot poison the buffer.
      if (!candidate.startsWith("{")) continue;

      // Try to parse the candidate as a stream-json event.
      // If parsing fails the candidate is an incomplete JSON fragment split
      // across PTY wrap boundaries — prepend it back and wait for more data.
      try {
        const event = JSON.parse(candidate);
        const extracted = this.extractAssistantText(event);
        texts.push(...extracted);
      } catch {
        // Incomplete JSON fragment — put it back and keep looping only if
        // there is another newline already in the buffer; otherwise wait.
        this.buffer = candidate + this.buffer;
        if (this.buffer.indexOf("\n") === -1) break;
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
