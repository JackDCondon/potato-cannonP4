// src/providers/chat-provider.types.ts

/**
 * Context identifying a ticket or brainstorm for chat operations.
 */
export interface ChatContext {
  projectId: string;
  ticketId?: string;
  brainstormId?: string;
  agentSource?: string;
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
  contextLabel?: string;
}

/**
 * Provider-specific thread information stored in chat-threads.json.
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
 * Structure of chat-threads.json stored per ticket/brainstorm.
 */
export interface ChatThreadsFile {
  threads: ProviderThreadInfo[];
  createdAt: string;
}

/**
 * Callback for providers to report incoming responses.
 */
export type ResponseCallback = (
  providerId: string,
  context: ChatContext,
  answer: string,
) => Promise<boolean>;
