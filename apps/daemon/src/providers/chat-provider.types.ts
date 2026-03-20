// src/providers/chat-provider.types.ts

import type { ChatNotificationCategory } from "@potato-cannon/shared";

/**
 * Context identifying a ticket or brainstorm for chat operations.
 */
export interface ChatContext {
  projectId: string;
  workflowId?: string;
  ticketId?: string;
  brainstormId?: string;
  agentSource?: string;
  agentModel?: string;
  sourceSessionId?: string;
}

/**
 * Message to send to chat providers.
 */
export interface OutboundMessage {
  text: string;
  options?: string[];
  questionId?: string;
  phase?: string;
  kind?: "question" | "notification";
  category?: ChatNotificationCategory;
  contextLabel?: string;
}

/**
 * Provider-specific thread/channel information cached by providers.
 */
export interface ProviderThreadInfo {
  providerId: string;
  threadId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Capabilities a provider may or may not support.
 */
export interface ProviderCapabilities {
  threads: boolean;
  buttons: boolean;
  formatting: "markdown" | "html" | "plain";
}

/**
 * Interface all chat providers must implement.
 */
export interface ChatProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  initialize(config: unknown): Promise<void>;
  shutdown(): Promise<void>;

  createThread(
    context: ChatContext,
    title: string,
  ): Promise<ProviderThreadInfo>;
  getThread(context: ChatContext): Promise<ProviderThreadInfo | null>;
  deleteThread?(thread: ProviderThreadInfo): Promise<void>;

  send(thread: ProviderThreadInfo, message: OutboundMessage): Promise<void>;
  notifyAnswered(thread: ProviderThreadInfo, answer: string): Promise<void>;
}

/**
 * Shared helpers for turning a chat context into a stable lookup key.
 */
export function getContextKey(context: ChatContext): string {
  const contextId = context.ticketId ?? context.brainstormId ?? "";
  return `${encodeURIComponent(context.projectId)}:${encodeURIComponent(contextId)}`;
}

export function parseContextKey(key: string): ChatContext | null {
  const separatorIndex = key.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  let projectId: string;
  let contextId: string;

  try {
    projectId = decodeURIComponent(key.slice(0, separatorIndex));
    contextId = decodeURIComponent(key.slice(separatorIndex + 1));
  } catch {
    return null;
  }

  if (!projectId || !contextId) {
    return null;
  }

  if (contextId.startsWith("brain_")) {
    return { projectId, brainstormId: contextId };
  }

  return { projectId, ticketId: contextId };
}

/**
 * Callback for providers to report incoming responses.
 */
export type ResponseCallback = (
  providerId: string,
  context: ChatContext,
  answer: string,
) => Promise<boolean>;
