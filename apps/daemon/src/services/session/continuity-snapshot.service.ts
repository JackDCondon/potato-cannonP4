import type { ConversationMessage } from "../../types/conversation.types.js";
import type {
  PendingQuestion,
  PendingResponse,
} from "../../stores/chat.store.js";
import type { ContinuityPacket } from "./continuity.types.js";
import {
  buildBoundedContinuityPacket,
  type ContinuityPacketLimits,
} from "./continuity-context.service.js";

export interface BuildRestartSnapshotInput {
  projectId: string;
  ticketId: string;
  currentPhase: string;
  targetPhase: string;
  executionGeneration: number;
  conversationMessages: ConversationMessage[];
  pendingQuestion: PendingQuestion | null;
  pendingResponse: PendingResponse | null;
  limits: ContinuityPacketLimits;
}

function buildRestartReason(input: BuildRestartSnapshotInput): string {
  return `Restart requested for ticket ${input.ticketId}: ${input.currentPhase} -> ${input.targetPhase}`;
}

export function buildRestartSnapshot(
  input: BuildRestartSnapshotInput,
): ContinuityPacket | null {
  const safeConversationMessages = input.conversationMessages.filter(
    (message) =>
      message.type === "user" || message.metadata?.messageOrigin === "user",
  );

  const syntheticMessages: ConversationMessage[] = [];
  if (input.pendingQuestion) {
    syntheticMessages.push({
      id: `restart_question_${input.ticketId}`,
      conversationId: input.pendingQuestion.conversationId,
      type: "question",
      text: input.pendingQuestion.question,
      timestamp: input.pendingQuestion.askedAt,
      metadata: {
        phase: input.pendingQuestion.phase ?? input.currentPhase,
        executionGeneration:
          input.pendingQuestion.ticketGeneration ?? input.executionGeneration,
        sourceSessionId: undefined,
        messageOrigin: "system",
      },
    });
  }
  if (input.pendingResponse) {
    syntheticMessages.push({
      id: `restart_response_${input.ticketId}`,
      conversationId: input.pendingQuestion?.conversationId ?? "restart_snapshot",
      type: "user",
      text: input.pendingResponse.answer,
      timestamp: new Date().toISOString(),
      metadata: {
        phase: input.currentPhase,
        executionGeneration: input.executionGeneration,
        sourceSessionId: undefined,
        messageOrigin: "user",
      },
    });
  }

  return buildBoundedContinuityPacket({
    scope: "safe_user_context_only",
    reasonForRestart: buildRestartReason(input),
    filter: {},
    limits: input.limits,
    conversationMessages: [...safeConversationMessages, ...syntheticMessages],
    transcriptHighlights: [],
  });
}

