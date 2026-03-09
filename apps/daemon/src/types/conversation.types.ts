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
  metadata?: Record<string, unknown>;
}

export interface CreateMessageInput {
  type: ConversationMessage["type"];
  text: string;
  options?: string[];
  metadata?: Record<string, unknown>;
}
