// src/services/chat.service.ts

import type {
  ChatProvider,
  ChatContext,
  OutboundMessage,
} from "../providers/chat-provider.types.js";
import {
  writeQuestion,
  readResponse,
  readQuestion,
  clearQuestion,
  clearResponse,
  waitForResponse,
  writeResponse,
  createWaitController,
} from "../stores/chat.store.js";
import { appendTicketLog } from "../stores/ticket-log.store.js";
import { eventBus } from "../utils/event-bus.js";
import {
  addMessage,
  answerQuestion,
  getPendingQuestion,
} from "../stores/conversation.store.js";
import { createChatQueueStore } from "../stores/chat-queue.store.js";
import { createProviderChannelStore } from "../stores/provider-channel.store.js";
import { getDatabase } from "../stores/db.js";
import { ChatOrchestrator } from "./chat/chat-orchestrator.js";
import type {
  ConversationMessageMetadata,
  ConversationMessageOrigin,
} from "../types/conversation.types.js";
import { getActiveSessionForTicket } from "../stores/session.store.js";
import { TERMINAL_PHASES } from "@potato-cannon/shared";

export class ChatService {
  private providers: Map<string, ChatProvider> = new Map();
  private pendingOptions: Map<string, string[]> = new Map();
  private orchestrator: ChatOrchestrator | null;

  // Idempotency cache to prevent duplicate question broadcasts
  private recentQuestions: Map<string, { hash: string; timestamp: number }> = new Map();
  private readonly IDEMPOTENCY_WINDOW_MS = 30000; // 30 seconds
  private readonly terminalPhases = new Set<string>(TERMINAL_PHASES as readonly string[]);

  constructor(orchestrator?: ChatOrchestrator) {
    this.orchestrator = orchestrator ?? null;
  }

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

  async ask(
    context: ChatContext,
    question: string,
    options?: string[],
    phase?: string,
  ): Promise<string> {
    const providers = this.getActiveProviders();
    const contextKey = this.getContextKey(context);
    const contextId = this.getContextId(context);
    const now = new Date().toISOString();
    const ticketGeneration = this.getTicketGeneration(context);

    // Create abort controller for this wait - allows session termination to cancel
    const controller = createWaitController(contextId);

    // Skip if duplicate within idempotency window
    if (this.isDuplicateQuestion(contextKey, question)) {
      // Still need to wait for response (from the original ask)
      try {
        return await waitForResponse(context.projectId, contextId, undefined, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          console.log(`[ChatService] Wait cancelled for duplicate ${contextId} - session replaced`);
          throw error; // Re-throw to signal cancellation to caller
        }
        throw error;
      }
    }

    // Store options for potential number-to-option mapping
    if (options && options.length > 0) {
      this.pendingOptions.set(contextKey, options);
    }

    // Get conversation ID from the entity
    const conversationId = this.getConversationId(context);

    // Add question message to conversation store (if we have a conversation)
    let questionMessageId: string | undefined;
    if (conversationId) {
      const message = addMessage(conversationId, {
        type: "question",
        text: question,
        options,
        metadata: this.createConversationMetadata(
          context,
          "agent",
          phase,
          ticketGeneration,
        ),
      });
      questionMessageId = message.id;
    }

    // Write pending question for MCP sync (allows web UI to poll)
    await writeQuestion(context.projectId, contextId, {
      conversationId: questionMessageId || this.generateConversationId(),
      questionId: questionMessageId,
      question,
      options: options || null,
      askedAt: now,
      phase,
      ticketGeneration,
      phaseAtAsk: phase,
    });

    // Log the question being sent
    const truncatedQuestion =
      question.length > 50 ? question.substring(0, 50) + "..." : question;
    console.log(
      `[ChatService] Sending question for ${contextId}: ${truncatedQuestion}`,
    );

    // Also log to ticket-specific log file
    if (context.ticketId) {
      await appendTicketLog(
        context.projectId,
        context.ticketId,
        `[Question] ${truncatedQuestion}`,
      );
    }

    // Emit events for real-time updates
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message: { type: "question", text: question, options, timestamp: now },
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message: { type: "question", text: question, options, timestamp: now },
      });
    }

    // Broadcast to providers if any are configured
    if (providers.length > 0) {
      const message: OutboundMessage = { text: question, options, phase };
      const results = await Promise.allSettled(
        providers.map((p) => this.sendToProvider(p, context, message)),
      );

      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        console.warn(
          `[ChatService] Some providers failed:`,
          failures.map((f) => (f as PromiseRejectedResult).reason),
        );
      }
    }

    // Wait for response (from web UI or any provider)
    let answer: string;
    try {
      answer = await waitForResponse(context.projectId, contextId, undefined, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`[ChatService] Wait cancelled for ${contextId} - session replaced`);
        // Clean up pending options
        this.pendingOptions.delete(contextKey);
        throw error; // Re-throw to signal cancellation to caller
      }
      throw error;
    }

    // Map numbered response back to option if applicable
    const mappedAnswer = this.mapNumberedResponse(contextKey, answer);
    this.pendingOptions.delete(contextKey);

    // Mark question as answered and add user response
    if (conversationId) {
      if (questionMessageId) {
        answerQuestion(questionMessageId);
      }
      addMessage(conversationId, {
        type: "user",
        text: mappedAnswer,
        metadata: this.createConversationMetadata(
          context,
          "user",
          phase,
          ticketGeneration,
        ),
      });
    }

    // Emit event so frontend can update with the user message
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message: { type: "user", text: mappedAnswer, timestamp: now },
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message: { type: "user", text: mappedAnswer, timestamp: now },
      });
    }

    return mappedAnswer;
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
    const contextKey = this.getContextKey(context);
    const contextId = this.getContextId(context);
    const now = new Date().toISOString();
    const ticketGeneration = this.getTicketGeneration(context);

    // Store options for potential number-to-option mapping on response
    if (options && options.length > 0) {
      this.pendingOptions.set(contextKey, options);
    }

    // Get conversation ID from the entity
    const conversationId = this.getConversationId(context);

    // Add question message to conversation store
    let questionMessageId: string = '';
    if (conversationId) {
      const message = addMessage(conversationId, {
        type: "question",
        text: question,
        options,
        metadata: this.createConversationMetadata(
          context,
          "agent",
          phase,
          ticketGeneration,
        ),
      });
      questionMessageId = message.id;
    }
    const logicalQuestionId = questionMessageId || this.generateQuestionId();

    // Write pending question for IPC (allows session respawn to inject response)
    await writeQuestion(context.projectId, contextId, {
      conversationId: questionMessageId || this.generateConversationId(),
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
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message: { type: "question", text: question, options, timestamp: now },
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message: { type: "question", text: question, options, timestamp: now },
      });
    }

    await this.getOrchestrator().enqueueQuestion(context, logicalQuestionId, {
      text: question,
      options,
      questionId: logicalQuestionId,
      phase,
      kind: "question",
    });

    // Return immediately - don't wait for response
    return { status: 'pending', questionId: logicalQuestionId };
  }

  async notify(context: ChatContext, message: string): Promise<void> {
    const now = new Date().toISOString();

    // Get conversation ID and persist notification
    const conversationId = this.getConversationId(context);
    if (conversationId) {
      addMessage(conversationId, {
        type: "notification",
        text: message,
        metadata: this.createConversationMetadata(
          context,
          "system",
          undefined,
          this.getTicketGeneration(context),
        ),
      });
    }

    // Emit events for real-time updates
    if (context.ticketId) {
      eventBus.emit("ticket:message", {
        projectId: context.projectId,
        ticketId: context.ticketId,
        message: { type: "notification", text: message, timestamp: now },
      });
    }
    if (context.brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId: context.projectId,
        brainstormId: context.brainstormId,
        message: { type: "notification", text: message, timestamp: now },
      });
    }

    await this.getOrchestrator().enqueueNotification(context, {
      text: message,
      kind: "notification",
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
      this.getContextId(context),
    );
    if (response) {
      // Already answered
      return false;
    }

    // Write response
    const pendingQuestion = await readQuestion(
      context.projectId,
      this.getContextId(context),
    );
    const decodedAnswer = this.decodeStructuredAnswer(answer);
    if (
      decodedAnswer.questionId &&
      pendingQuestion?.questionId &&
      decodedAnswer.questionId !== pendingQuestion.questionId
    ) {
      return false;
    }

    const mappedAnswer = this.mapAsyncResponseAnswer(
      this.getContextKey(context),
      decodedAnswer.answer,
      pendingQuestion?.options ?? null,
      decodedAnswer.optionIndex,
    );
    await writeResponse(context.projectId, this.getContextId(context), {
      answer: mappedAnswer,
      questionId: pendingQuestion?.questionId,
      ticketGeneration: pendingQuestion?.ticketGeneration,
    });
    if (pendingQuestion?.questionId) {
      await this.getOrchestrator().resolveQuestion(
        pendingQuestion.questionId,
        mappedAnswer,
        providerId as "telegram" | "slack",
        context,
      );
    }

    // All contexts use async askAsync flow — save user message to conversation store here.
    const conversationId = this.getConversationId(context);
    if (conversationId) {
      const pendingQuestion = getPendingQuestion(conversationId);
      if (pendingQuestion) {
        answerQuestion(pendingQuestion.id);
        addMessage(conversationId, {
          type: "user",
          text: mappedAnswer,
          metadata: this.createConversationMetadata(
            context,
            "user",
            pendingQuestion?.metadata?.phase as string | undefined,
            pendingQuestion?.metadata?.executionGeneration as number | undefined,
          ),
        });

        if (context.brainstormId) {
          eventBus.emit("brainstorm:message", {
            projectId: context.projectId,
            brainstormId: context.brainstormId,
            message: { type: "user", text: mappedAnswer, timestamp: new Date().toISOString() },
          });
        }
        if (context.ticketId) {
          eventBus.emit("ticket:message", {
            projectId: context.projectId,
            ticketId: context.ticketId,
            message: { type: "user", text: mappedAnswer, timestamp: new Date().toISOString() },
          });
        }
      }
    }

    // Notify other providers
    const providers = this.getActiveProviders().filter(
      (p) => p.id !== providerId,
    );
    await Promise.allSettled(
      providers.map(async (p) => {
        const thread = await p.getThread(context);
        if (thread) {
          await p.notifyAnswered(thread, mappedAnswer);
        }
      }),
    );

    return true;
  }

  async reconcileWebAnswer(
    context: ChatContext,
    questionId: string,
    answer: string,
  ): Promise<{ accepted: boolean; stale: boolean; found: boolean }> {
    const result = await this.getOrchestrator().resolveQuestion(
      questionId,
      answer,
      "web",
      context,
    );
    return { accepted: result.accepted, stale: result.stale, found: !!result.item };
  }

  async cleanupTicketLifecycle(
    projectId: string,
    ticketId: string,
  ): Promise<{
    queueCancelled: number;
    routesRemoved: number;
    threadDeletesAttempted: number;
    threadDeleteErrors: string[];
  }> {
    const db = getDatabase();
    const queueStore = createChatQueueStore(db);
    const channelStore = createProviderChannelStore(db);

    const queueCancelled = queueStore.cancelOpenItemsForTicket(
      projectId,
      ticketId,
      "system",
    );

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

    if (queueCancelled > 0) {
      await this.getOrchestrator().tickQueue();
    }

    return {
      queueCancelled,
      routesRemoved,
      threadDeletesAttempted,
      threadDeleteErrors,
    };
  }

  async recoverQueuedChat(): Promise<void> {
    await this.getOrchestrator().tickQueue();
  }

  async pruneTicketQueueAfterSessionEnd(
    projectId: string,
    ticketId: string,
  ): Promise<{ checked: number; cancelled: number }> {
    if (getActiveSessionForTicket(ticketId)) {
      return { checked: 0, cancelled: 0 };
    }

    return this.pruneIrrelevantTicketQueue({
      projectId,
      ticketId,
      preservePendingInteraction: true,
    });
  }

  async pruneIrrelevantTicketQueue(filters?: {
    projectId?: string;
    ticketId?: string;
    preservePendingInteraction?: boolean;
  }): Promise<{ checked: number; cancelled: number }> {
    const db = getDatabase();
    const queueStore = createChatQueueStore(db);
    const candidates = queueStore.listOpenQueueItems({
      projectId: filters?.projectId,
      ticketId: filters?.ticketId,
    });

    let checked = 0;
    let cancelled = 0;
    for (const item of candidates) {
      if (!item.ticketId) {
        continue;
      }
      checked++;
      const ticketRow = db
        .prepare(
          "SELECT id, phase, archived_at FROM tickets WHERE id = ? AND project_id = ?",
        )
        .get(item.ticketId, item.projectId) as
        | { id: string; phase: string; archived_at: string | null }
        | undefined;

      if (!ticketRow) {
        queueStore.markCancelled(item.id, "system");
        cancelled++;
        continue;
      }

      if (ticketRow.archived_at || this.terminalPhases.has(ticketRow.phase)) {
        queueStore.markCancelled(item.id, "system");
        cancelled++;
        continue;
      }

      if (filters?.preservePendingInteraction ?? true) {
        const [pendingQuestion, pendingResponse] = await Promise.all([
          readQuestion(item.projectId, item.ticketId),
          readResponse(item.projectId, item.ticketId),
        ]);
        if (pendingQuestion || pendingResponse) {
          continue;
        }
      }

      queueStore.markCancelled(item.id, "system");
      cancelled++;
    }

    if (cancelled > 0) {
      await this.getOrchestrator().tickQueue();
    }

    return { checked, cancelled };
  }

  private mapAsyncResponseAnswer(
    contextKey: string,
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

    return this.mapNumberedResponse(contextKey, answer);
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

  private mapNumberedResponse(contextKey: string, answer: string): string {
    const options = this.pendingOptions.get(contextKey);
    if (!options) return answer;

    const trimmed = answer.trim();
    const num = parseInt(trimmed, 10);

    if (!isNaN(num) && num >= 1 && num <= options.length) {
      return options[num - 1];
    }

    return answer;
  }

  private getContextKey(context: ChatContext): string {
    return `${context.projectId}:${context.ticketId || context.brainstormId}`;
  }

  private getContextId(context: ChatContext): string {
    return context.ticketId || context.brainstormId || "";
  }

  private generateConversationId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `conv_${timestamp}_${random}`;
  }

  private getConversationId(context: ChatContext): string | null {
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

  private generateQuestionId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `q_${timestamp}_${random}`;
  }

  private decodeStructuredAnswer(answer: string): {
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

  private getTicketGeneration(context: ChatContext): number | undefined {
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

  private getOrchestrator(): ChatOrchestrator {
    if (this.orchestrator) {
      return this.orchestrator;
    }

    this.orchestrator = new ChatOrchestrator(
      createChatQueueStore(getDatabase()),
      () => this.getActiveProviders(),
      (provider, context, message) =>
        this.sendToProvider(provider, context, message),
    );
    return this.orchestrator;
  }

  private createConversationMetadata(
    context: ChatContext,
    origin: ConversationMessageOrigin,
    phase?: string,
    executionGeneration?: number,
  ): ConversationMessageMetadata | undefined {
    if (!context.ticketId) {
      return phase ? { phase } : undefined;
    }

    const metadata: ConversationMessageMetadata = {
      messageOrigin: origin,
    };

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

  /**
   * Check if this question was recently asked for this context.
   * Returns true if duplicate (should skip), false if new.
   */
  private isDuplicateQuestion(contextKey: string, question: string): boolean {
    const hash = this.hashQuestion(question);
    const recent = this.recentQuestions.get(contextKey);

    // Clean old entries periodically
    this.cleanOldEntries();

    if (recent && recent.hash === hash) {
      const age = Date.now() - recent.timestamp;
      if (age < this.IDEMPOTENCY_WINDOW_MS) {
        console.log(`[ChatService] Skipping duplicate question for ${contextKey}`);
        return true;
      }
    }

    this.recentQuestions.set(contextKey, { hash, timestamp: Date.now() });
    return false;
  }

  /**
   * Create a simple hash of the question for comparison.
   */
  private hashQuestion(question: string): string {
    // Simple hash - first 100 chars + length
    return `${question.substring(0, 100)}:${question.length}`;
  }

  /**
   * Clean up old entries from the idempotency cache.
   */
  private cleanOldEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.recentQuestions) {
      if (now - entry.timestamp > this.IDEMPOTENCY_WINDOW_MS * 2) {
        this.recentQuestions.delete(key);
      }
    }
  }
}

// Singleton instance
export const chatService = new ChatService();
