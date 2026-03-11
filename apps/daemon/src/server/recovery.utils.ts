import type { PendingResponse } from "../stores/chat.store.js";

type PendingResponseReader = () => Promise<PendingResponse | null>;

/**
 * Best-effort read for pending responses during startup recovery.
 * Never throws: if the reader fails, return null and continue recovery.
 */
export async function safeReadPendingResponse(
  reader: PendingResponseReader,
  projectId: string,
  ticketId: string,
): Promise<PendingResponse | null> {
  try {
    return await reader();
  } catch (err) {
    console.warn(
      `[recovery] Skipping pending response read for ${ticketId}: ${(err as Error).message}`,
    );
    return null;
  }
}
