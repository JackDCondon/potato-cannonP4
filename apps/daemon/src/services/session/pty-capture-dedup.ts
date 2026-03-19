// apps/daemon/src/services/session/pty-capture-dedup.ts

interface CaptureRecord {
  id: string;
  prefix: string;
  timestamp: number;
  messageId: string;
}

const PREFIX_LENGTH = 200;
const TTL_MS = 60_000; // 60 seconds

/**
 * Tracks recently PTY-captured text to enable deduplication when
 * the agent also sends the same content via chat_notify.
 *
 * Usage:
 * 1. When PTY text is captured and stored, call recordCapture(text, messageId).
 * 2. When chat_notify fires, call findMatchingCapture(notifyText).
 *    If a match is found, the returned messageId is the PTY-capture message
 *    to mark as superseded (soft-delete via updateMessageMetadata).
 */
export class PtyCaptureDedup {
  private captures: CaptureRecord[] = [];
  private nextId = 0;

  /**
   * Record that PTY text was captured and stored as a conversation message.
   * @param text The captured text (full content)
   * @param messageId The conversation message ID returned by addMessage()
   * @param timestamp Optional override for the capture timestamp (for testing)
   * @returns Internal capture ID (used by removeCapture)
   */
  recordCapture(text: string, messageId: string, timestamp = Date.now()): string {
    const id = `pty-cap-${this.nextId++}`;
    this.captures.push({
      id,
      prefix: text.trim().slice(0, PREFIX_LENGTH),
      timestamp,
      messageId,
    });
    // Prune expired records on every write
    this.captures = this.captures.filter((c) => timestamp - c.timestamp < TTL_MS);
    return id;
  }

  /**
   * Find a PTY-capture record matching the given text (same prefix, within TTL).
   * @returns The conversation messageId of the matching capture, or null if not found.
   */
  findMatchingCapture(text: string): string | null {
    const now = Date.now();
    const prefix = text.trim().slice(0, PREFIX_LENGTH);
    for (const capture of this.captures) {
      if (now - capture.timestamp < TTL_MS && capture.prefix === prefix) {
        return capture.messageId;
      }
    }
    return null;
  }

  /**
   * Remove a capture record by its internal ID (after superseding its message).
   */
  removeCapture(id: string): void {
    this.captures = this.captures.filter((c) => c.id !== id);
  }

  /**
   * Remove a capture record by messageId (after superseding its message).
   */
  removeCaptureByMessageId(messageId: string): void {
    this.captures = this.captures.filter((c) => c.messageId !== messageId);
  }
}

/**
 * Module-level registry of per-context PtyCaptureDedup instances.
 *
 * Keyed by the context key: ticketId or brainstormId.
 * This allows the chat_notify handler (in chat.tools.ts) to look up
 * the dedup instance for the current context and mark PTY captures
 * as superseded.
 */
const dedupRegistry = new Map<string, PtyCaptureDedup>();

export function getPtyCaptureDedup(contextKey: string): PtyCaptureDedup {
  let dedup = dedupRegistry.get(contextKey);
  if (!dedup) {
    dedup = new PtyCaptureDedup();
    dedupRegistry.set(contextKey, dedup);
  }
  return dedup;
}

export function clearPtyCaptureDedup(contextKey: string): void {
  dedupRegistry.delete(contextKey);
}
