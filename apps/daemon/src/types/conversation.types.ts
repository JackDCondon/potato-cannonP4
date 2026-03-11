export type ConversationMessageOrigin = "agent" | "user" | "system" | "provider";

export interface ConversationContinuityMetadata {
  phase?: string;
  executionGeneration?: number;
  agentSource?: string;
  sourceSessionId?: string;
  messageOrigin?: ConversationMessageOrigin;
}

export type ConversationMessageMetadata =
  ConversationContinuityMetadata & Record<string, unknown>;

export interface Conversation {
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  type: "question" | "user" | "notification" | "artifact" | "error";
  text: string;
  options?: string[];
  timestamp: string;
  answeredAt?: string;
  metadata?: ConversationMessageMetadata;
}

export interface CreateMessageInput {
  type: ConversationMessage["type"];
  text: string;
  options?: string[];
  metadata?: ConversationMessageMetadata;
}
