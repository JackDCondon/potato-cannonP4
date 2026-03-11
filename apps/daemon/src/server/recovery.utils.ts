import type { PendingResponse } from "../stores/chat.store.js";

type PendingResponseReader = () => Promise<PendingResponse | null>;

interface StalePendingTicketInputArgs {
  providedGeneration: number | undefined;
  providedQuestionId: string | undefined;
  expectedGeneration: number | undefined;
  expectedQuestionId: string | undefined;
  currentGeneration: number;
  hasPendingQuestion: boolean;
}

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

export function isStalePendingTicketInput(
  args: StalePendingTicketInputArgs,
): boolean {
  return (
    typeof args.providedGeneration !== "number" ||
    typeof args.providedQuestionId !== "string" ||
    !args.hasPendingQuestion ||
    typeof args.expectedQuestionId !== "string" ||
    typeof args.expectedGeneration !== "number" ||
    args.providedGeneration !== args.expectedGeneration ||
    args.providedQuestionId !== args.expectedQuestionId ||
    args.providedGeneration !== args.currentGeneration
  );
}

export function buildContinuityDecisionLogFields(args: {
  mode: "resume" | "handoff" | "fresh";
  reason: string;
  scope?: string;
  sourceSessionId?: string;
}): Record<string, string> {
  return {
    continuity_mode: args.mode,
    continuity_reason: args.reason,
    continuity_scope: args.scope ?? "none",
    continuity_source_session_id: args.sourceSessionId ?? "none",
    continuity_resume_rejected:
      args.mode === "fresh" && args.reason === "resume_not_allowed"
        ? "true"
        : "false",
  };
}
