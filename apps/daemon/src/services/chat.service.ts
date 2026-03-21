// src/services/chat.service.ts

import type { ChatNotificationCategory } from "@potato-cannon/shared";
import type {
  ChatContext,
  ChatProvider,
  OutboundMessage,
} from "../providers/chat-provider.types.js";
import {
  writeQuestion,
  readResponse,
  readQuestion,
  writeResponse,
} from "../stores/chat.store.js";
import { eventBus } from "../utils/event-bus.js";
import {
  addMessage,
  answerQuestion,
  getPendingQuestion,
} from "../stores/conversation.store.js";
import { createProviderChannelStore } from "../stores/provider-channel.store.js";
import { getDatabase } from "../stores/db.js";
import {
  createConversationMetadata,
  decodeStructuredAnswer,
  generateConversationId,
  generateQuestionId,
  getContextId,
  getConversationId,
  getTicketGeneration,
} from "./chat.service.utils.js";
import { shouldDeliverMessageToProviders } from "./chat-notification-policy.js";

interface NotifyOptions {
  category?: ChatNotificationCategory;
  persistToConversation?: boolean;
  emitToUi?: boolean;
}

export class ChatService {
  private providers: Map<string, ChatProvider> = new Map();

  registerProvider(provider: ChatProvider): void {
    this.providers.set(provider.id, provider);
    console.log(`[ChatService] Registered provider: ${provider.name}`);
  }

  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
  }

  getProvider(id: string): ChatProvider | null {
    return this.providers.get(id) || null;
  }

  getActiveProviders(): ChatProvider[] {
    return Array.from(this.providers.values());
  }

  async initChat(context: ChatContext, title: string): Promise<void> {
    const providers = this.getActiveProviders();

    if (providers.length === 0) {
      console.log("[ChatService] No providers configured, skipping chat init");
      return;
    }

    const results = await Promise.allSettled(
      providers.map(async (provider) => {
        const existing = await provider.getThread(context);
        if (existing) return existing;

        const thread = await provider.createThread(context, title);
        return thread;
      }),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.warn(
        `[ChatService] Some providers failed to init chat:`,
        failures.map((f) => (f as PromiseRejectedResult).reason),
      );
    }
  }

  /**
   * Async version of ask() for brainstorms.
   * Saves question and returns immediately without waiting for response.
   * The session is expected to exit, and a new session will be spawned when user responds.
   */
  async askAsync(
    context: ChatContext,
    question: string,
    options?: string[],
    phase?: string,
  ): Promise<{ status: 'pending'; questionId: string }> {
    const contextId = getContextId(context);
    const now = new Date().toISOString();
    const ticketGeneration = getTicketGeneration(context);

    // Get conversation ID from the entity
    const conversationId = getConversationId(context);

    // Add question message to conversation store
    let questionMessageId: string = '';
    if (conversationId) {
      const message = addMessage(conversationId, {
        type: "question",
        text: question,
        options,
        metadata: createConversationMetadata(
          context,
          "agent",
          phase,
          ticketGeneration,
        ),
      });
      questionMessageId = message.id;
    }
    const logicalQuestionId = questionMessageId || generateQuestionId();

    // Write pending question for IPC (allows session respawn to inject response)
    await writeQuestion(context.projectId, contextId, {
      conversationId: questionMessageId || generateConversationId(),
      questionId: logicalQuestionId,
      question,
      options: options || null,
      askedAt: now,
      phase,
      ticketGeneration,
      phaseAtAsk: phase,
    });

    // Log the question
    const truncatedQuestion =
      question.length > 50 ? question.substring(0, 50) + "..." : question;
    console.log(
      `[ChatService] askAsync - question saved for ${contextId}: ${truncatedQuestion}`,
    );

    // Emit SSE events for frontend
    this.emitChatEvent(context, {
      type: "question",
      text: question,
      options,
      timestamp: now,
    });

    await this.sendToProviders(context, {
      text: question,
      options,
      questionId: logicalQuestionId,
      phase,
      kind: "question",
      category: "questions",
    });

    // Return immediately - don't wait for response
    return { status: 'pending', questionId: logicalQuestionId };
  }

  async notify(
    context: ChatContext,
    message: string,
    options: NotifyOptions = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    const {
      category = "builder_updates",
      persistToConversation = true,
      emitToUi = true,
    } = options;

    if (persistToConversation) {
      // Get conversation ID and persist notification
      const conversationId = getConversationId(context);
      if (conversationId) {
        addMessage(conversationId, {
          type: "notification",
          text: message,
          metadata: createConversationMetadata(
            context,
            "system",
            undefined,
            getTicketGeneration(context),
          ),
        });
      }
    }

    if (emitToUi) {
      // Emit events for real-time updates
      this.emitChatEvent(context, {
        type: "notification",
        text: message,
        timestamp: now,
      });
    }

    await this.sendToProviders(context, {
      text: message,
      kind: "notification",
      category,
    });
  }

  async handleResponse(
    providerId: string,
    context: ChatContext,
    answer: string,
  ): Promise<boolean> {
    // Check if question is still pending
    const response = await readResponse(
      context.projectId,
      getContextId(context),
    );
    if (response) {
      // Already answered
      return false;
    }

    // Write response
    const pendingQuestion = await readQuestion(
      context.projectId,
      getContextId(context),
    );
    if (!pendingQuestion) {
      // No pending question — this is a free-text message sent while the agent/PM is
      // thinking. Persist it to the conversation so it is visible in chat history, then
      // return false so the caller knows no question was answered (no session respawn needed).
      await this.persistFreeTextMessage(context, answer);
      return false;
    }
    const decodedAnswer = decodeStructuredAnswer(answer);
    if (
      decodedAnswer.questionId &&
      pendingQuestion.questionId &&
      decodedAnswer.questionId !== pendingQuestion.questionId
    ) {
      return false;
    }

    const mappedAnswer = this.mapAsyncResponseAnswer(
      decodedAnswer.answer,
      pendingQuestion?.options ?? null,
      decodedAnswer.optionIndex,
    );
    await writeResponse(context.projectId, getContextId(context), {
      answer: mappedAnswer,
      questionId: pendingQuestion?.questionId,
      ticketGeneration: pendingQuestion?.ticketGeneration,
    });

    // All contexts use async askAsync flow — save user message to conversation store here.
    const conversationId = getConversationId(context);
    if (conversationId) {
      const pendingConversationMessage = getPendingQuestion(conversationId);
      if (pendingConversationMessage) {
        answerQuestion(pendingConversationMessage.id);
        addMessage(conversationId, {
          type: "user",
          text: mappedAnswer,
          metadata: createConversationMetadata(
            context,
            "user",
            pendingConversationMessage?.metadata?.phase as string | undefined,
            pendingConversationMessage?.metadata?.executionGeneration as number | undefined,
          ),
        });

        this.emitChatEvent(context, {
          type: "user",
          text: mappedAnswer,
          timestamp: new Date().toISOString(),
        });
      }
    }

    await this.notifyProvidersAnswered(context, mappedAnswer, providerId);

    return true;
  }

  /**
   * Persist a free-text user message to the conversation when no pending question exists.
   * This handles messages sent while the PM is thinking / no active question is open.
   * The message is saved to the conversation store and broadcast via SSE so the UI reflects it.
   */
  async persistFreeTextMessage(
    context: ChatContext,
    message: string,
  ): Promise<void> {
    const conversationId = getConversationId(context);
    if (!conversationId) {
      console.warn(
        `[ChatService] persistFreeTextMessage: no conversationId for ${getContextId(context)}, message dropped`,
      );
      return;
    }

    addMessage(conversationId, {
      type: "user",
      text: message,
      metadata: createConversationMetadata(context, "user"),
    });

    this.emitChatEvent(context, {
      type: "user",
      text: message,
      timestamp: new Date().toISOString(),
    });
  }

  async reconcileWebAnswer(
    context: ChatContext,
    questionId: string,
    answer: string,
  ): Promise<{ accepted: boolean; stale: boolean; found: boolean }> {
    const contextId = getContextId(context);
    const pendingQuestion = await readQuestion(context.projectId, contextId);

    if (!pendingQuestion) {
      return { accepted: false, stale: true, found: false };
    }

    if (pendingQuestion.questionId && pendingQuestion.questionId !== questionId) {
      return { accepted: false, stale: true, found: true };
    }

    const mappedAnswer = this.mapAsyncResponseAnswer(
      answer,
      pendingQuestion.options,
    );

    await writeResponse(context.projectId, contextId, {
      answer: mappedAnswer,
      questionId: pendingQuestion.questionId,
      ticketGeneration: pendingQuestion.ticketGeneration,
    });

    const conversationId = getConversationId(context);
    if (conversationId) {
      const pendingConversationMessage = getPendingQuestion(conversationId);
      if (pendingConversationMessage) {
        answerQuestion(pendingConversationMessage.id);
        addMessage(conversationId, {
          type: "user",
          text: mappedAnswer,
          metadata: createConversationMetadata(context, "user"),
        });
      }
    }

    await this.notifyProvidersAnswered(context, mappedAnswer);

    return { accepted: true, stale: false, found: true };
  }

  async cleanupTicketLifecycle(
    projectId: string,
    ticketId: string,
  ): Promise<{
    routesRemoved: number;
    threadDeletesAttempted: number;
    threadDeleteErrors: string[];
  }> {
    const db = getDatabase();
    const channelStore = createProviderChannelStore(db);

    const channels = channelStore.listChannels({ ticketId });
    const threadDeleteErrors: string[] = [];
    let threadDeletesAttempted = 0;
    for (const channel of channels) {
      const provider = this.getProvider(channel.providerId);
      if (provider?.deleteThread) {
        threadDeletesAttempted++;
        try {
          await provider.deleteThread({
            providerId: channel.providerId,
            threadId: channel.channelId,
            metadata: channel.metadata,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          threadDeleteErrors.push(
            `${channel.providerId}/${channel.channelId}: ${message}`
          );
          console.warn(
            `[ChatService] Failed provider thread cleanup for ${channel.providerId}/${channel.channelId}: ${message}`,
          );
        }
      }
    }

    const routesRemoved = channelStore.deleteChannelsForTicket(ticketId);

    return {
      routesRemoved,
      threadDeletesAttempted,
      threadDeleteErrors,
    };
  }

  private mapAsyncResponseAnswer(
    answer: string,
    pendingOptions: string[] | null,
    optionIndex?: number,
  ): string {
    if (
      typeof optionIndex === "number" &&
      pendingOptions &&
      optionIndex >= 0 &&
      optionIndex < pendingOptions.length
    ) {
      return pendingOptions[optionIndex];
    }

    const callbackMatch = answer.match(/^answer_(\d+)$/);
    if (callbackMatch && pendingOptions && pendingOptions.length > 0) {
      const index = parseInt(callbackMatch[1], 10);
      if (!Number.isNaN(index) && index >= 0 && index < pendingOptions.length) {
        return pendingOptions[index];
      }
    }

    if (pendingOptions && pendingOptions.length > 0) {
      const numeric = parseInt(answer.trim(), 10);
      if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= pendingOptions.length) {
        return pendingOptions[numeric - 1];
      }
    }

    return answer;
  }

  private async sendToProviders(
    context: ChatContext,
    message: OutboundMessage,
  ): Promise<void> {
    if (!shouldDeliverMessageToProviders(context, message)) {
      console.log(
        `[ChatService] Suppressed ${message.category ?? message.kind ?? "notification"} for ${getContextId(context)} due to board chat notification policy`,
      );
      return;
    }

    for (const provider of this.getActiveProviders()) {
      try {
        await this.sendToProvider(provider, context, message);
      } catch (error) {
        console.warn(
          `[ChatService] Provider ${provider.id} send failed for ${getContextId(context)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private emitChatEvent(
    context: ChatContext,
    message: { type: string; text: string; options?: string[]; timestamp: string },
  ): void {
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message,
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message,
      });
    }
  }

  private async sendToProvider(
    provider: ChatProvider,
    context: ChatContext,
    message: OutboundMessage,
  ): Promise<void> {
    const contextId = context.ticketId || context.brainstormId || "unknown";
    let thread = await provider.getThread(context);

    if (!thread) {
      const title = context.ticketId || context.brainstormId || "Chat";
      console.log(`[ChatService] Creating ${provider.id} thread for ${contextId}`);
      thread = await provider.createThread(context, title);
      console.log(`[ChatService] Created ${provider.id} thread for ${contextId}`);
    }

    // Degrade buttons to numbered text if provider doesn't support them
    let finalMessage = message;
    if (message.options && !provider.capabilities.buttons) {
      const numberedOptions = message.options
        .map((opt, i) => `${i + 1}. ${opt}`)
        .join("\n");
      finalMessage = {
        ...message,
        text: `${message.text}\n\n${numberedOptions}\n\nReply with a number.`,
        options: undefined,
      };
    }

    await provider.send(thread, finalMessage);
    console.log(`[ChatService] Sent message via ${provider.id} for ${contextId}`);
  }

  private async notifyProvidersAnswered(
    context: ChatContext,
    answer: string,
    excludedProviderId?: string,
  ): Promise<void> {
    const providers = this.getActiveProviders().filter(
      (provider) => provider.id !== excludedProviderId,
    );

    await Promise.allSettled(
      providers.map(async (provider) => {
        const thread = await provider.getThread(context);
        if (thread) {
          await provider.notifyAnswered(thread, answer);
        }
      }),
    );
  }

}

// Singleton instance
export const chatService = new ChatService();
