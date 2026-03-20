import { getDatabase } from "../stores/db.js";
import type { ChatContext } from "../providers/chat-provider.types.js";
import type {
  ConversationMessageMetadata,
  ConversationMessageOrigin,
} from "../types/conversation.types.js";

export function getContextId(context: ChatContext): string {
  return context.ticketId || context.brainstormId || "";
}

export function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function generateQuestionId(): string {
  return `q_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function getConversationId(context: ChatContext): string | null {
  const db = getDatabase();
  if (context.ticketId) {
    const row = db
      .prepare("SELECT conversation_id FROM tickets WHERE id = ?")
      .get(context.ticketId) as { conversation_id: string | null } | undefined;
    return row?.conversation_id || null;
  }
  if (context.brainstormId) {
    const row = db
      .prepare("SELECT conversation_id FROM brainstorms WHERE id = ?")
      .get(context.brainstormId) as { conversation_id: string | null } | undefined;
    return row?.conversation_id || null;
  }
  return null;
}

export function getWorkflowId(context: ChatContext): string | null {
  if (context.workflowId) {
    return context.workflowId;
  }

  const db = getDatabase();
  if (context.ticketId) {
    const row = db
      .prepare("SELECT workflow_id FROM tickets WHERE project_id = ? AND id = ?")
      .get(context.projectId, context.ticketId) as
      | { workflow_id: string | null }
      | undefined;
    return row?.workflow_id || null;
  }
  if (context.brainstormId) {
    const row = db
      .prepare(
        "SELECT workflow_id FROM brainstorms WHERE project_id = ? AND id = ?",
      )
      .get(context.projectId, context.brainstormId) as
      | { workflow_id: string | null }
      | undefined;
    return row?.workflow_id || null;
  }
  return null;
}

export function decodeStructuredAnswer(answer: string): {
  answer: string;
  questionId?: string;
  optionIndex?: number;
} {
  const structuredMatch = answer.match(/^answer:([^:]+):(\d+)$/);
  if (!structuredMatch) {
    return { answer };
  }
  const optionIndex = Number.parseInt(structuredMatch[2], 10);
  return {
    answer,
    questionId: structuredMatch[1],
    optionIndex: Number.isNaN(optionIndex) ? undefined : optionIndex,
  };
}

export function getTicketGeneration(
  context: ChatContext,
): number | undefined {
  if (!context.ticketId) return undefined;
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT execution_generation FROM tickets WHERE project_id = ? AND id = ?",
    )
    .get(context.projectId, context.ticketId) as
    | { execution_generation: number | null }
    | undefined;
  if (!row || row.execution_generation === null) {
    return undefined;
  }
  return row.execution_generation;
}

export function createConversationMetadata(
  context: ChatContext,
  origin: ConversationMessageOrigin,
  phase?: string,
  executionGeneration?: number,
): ConversationMessageMetadata | undefined {
  if (!context.ticketId) {
    return phase ? { phase } : undefined;
  }
  const metadata: ConversationMessageMetadata = { messageOrigin: origin };
  if (phase) {
    metadata.phase = phase;
  }
  if (typeof executionGeneration === "number") {
    metadata.executionGeneration = executionGeneration;
  }
  if (context.agentSource) {
    metadata.agentSource = context.agentSource;
  }
  if (context.sourceSessionId) {
    metadata.sourceSessionId = context.sourceSessionId;
  }
  return metadata;
}
