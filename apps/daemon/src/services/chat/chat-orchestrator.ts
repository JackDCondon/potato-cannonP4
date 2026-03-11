import type {
  ChatContext,
  ChatProvider,
  OutboundMessage,
} from "../../providers/chat-provider.types.js";
import {
  createChatQueueStore,
  type ChatQueueItem,
  type ChatQueueStore,
  type ChatResolvedBy,
} from "../../stores/chat-queue.store.js";
import { getDatabase } from "../../stores/db.js";

interface EnqueuePayload {
  context: ChatContext;
  message: OutboundMessage;
}

interface ResolveResult {
  accepted: boolean;
  stale: boolean;
  item?: ChatQueueItem;
}

export class ChatOrchestrator {
  private dispatchLoopRunning = false;

  constructor(
    private queueStore: ChatQueueStore = createChatQueueStore(getDatabase()),
    private getProviders: () => ChatProvider[],
    private sendToProvider: (
      provider: ChatProvider,
      context: ChatContext,
      message: OutboundMessage
    ) => Promise<void>
  ) {}

  async enqueueQuestion(
    context: ChatContext,
    questionId: string,
    message: OutboundMessage
  ): Promise<ChatQueueItem> {
    const item = this.queueStore.enqueueQuestion({
      projectId: context.projectId,
      ticketId: context.ticketId,
      brainstormId: context.brainstormId,
      questionId,
      payload: { context, message },
    });
    await this.tickQueue();
    return item;
  }

  async enqueueNotification(
    context: ChatContext,
    message: OutboundMessage
  ): Promise<ChatQueueItem> {
    const item = this.queueStore.enqueueNotification({
      projectId: context.projectId,
      ticketId: context.ticketId,
      brainstormId: context.brainstormId,
      payload: { context, message },
    });
    await this.tickQueue();
    return item;
  }

  async tickQueue(): Promise<void> {
    if (this.dispatchLoopRunning) {
      return;
    }

    this.dispatchLoopRunning = true;
    try {
      let shouldContinue = true;
      while (shouldContinue) {
        const activeQuestion = this.queueStore.getActiveQuestion();
        const ready = this.queueStore.listReadyQueueItems(25);
        if (ready.length === 0) {
          shouldContinue = false;
          continue;
        }

        const nextItem = ready[0];

        // Keep question lock globally serialized.
        if (activeQuestion && nextItem.kind === "question") {
          shouldContinue = false;
          continue;
        }

        await this.dispatchQueueItem(nextItem);
      }
    } finally {
      this.dispatchLoopRunning = false;
    }
  }

  async resolveQuestion(
    questionId: string,
    _answer: string,
    source: ChatResolvedBy,
    expectedContext?: ChatContext,
  ): Promise<ResolveResult> {
    const item = this.queueStore.getQueueItemByQuestionId(questionId);
    if (!item) {
      return { accepted: false, stale: true };
    }

    if (expectedContext && !this.matchesContext(item, expectedContext)) {
      return { accepted: false, stale: true };
    }

    if (
      item.status === "answered" ||
      item.status === "cancelled" ||
      item.status === "stale" ||
      item.status === "timed_out" ||
      item.status === "dead_letter"
    ) {
      return { accepted: false, stale: true, item };
    }

    this.queueStore.markAnswered(item.id, source);
    await this.tickQueue();
    return {
      accepted: true,
      stale: false,
      item: this.queueStore.getQueueItem(item.id) ?? item,
    };
  }

  private matchesContext(item: ChatQueueItem, context: ChatContext): boolean {
    if (item.projectId !== context.projectId) {
      return false;
    }

    if (context.ticketId) {
      return item.ticketId === context.ticketId;
    }

    if (context.brainstormId) {
      return item.brainstormId === context.brainstormId;
    }

    return false;
  }

  private async dispatchQueueItem(item: ChatQueueItem): Promise<void> {
    this.queueStore.markDispatching(item.id);
    const rawPayload = item.payload as unknown as Partial<EnqueuePayload>;
    if (!rawPayload.context || !rawPayload.message) {
      this.queueStore.markDeadLetter(item.id, "system");
      return;
    }
    const context = rawPayload.context;
    const message = rawPayload.message;
    const providers = this.getProviders();

    if (providers.length === 0) {
      if (item.kind === "question") {
        this.queueStore.markAwaitingReply(item.id);
      } else {
        this.queueStore.markAnswered(item.id, "system");
      }
      return;
    }

    let successCount = 0;
    const results = await Promise.allSettled(
      providers.map(async (provider) => {
        try {
          await this.sendToProvider(provider, context, message);
          this.queueStore.recordDeliveryEvent({
            queueItemId: item.id,
            projectId: item.projectId,
            ticketId: item.ticketId,
            providerId: provider.id,
            eventType: "sent",
          });
          successCount++;
        } catch (error) {
          this.queueStore.recordDeliveryEvent({
            queueItemId: item.id,
            projectId: item.projectId,
            ticketId: item.ticketId,
            providerId: provider.id,
            eventType: "failed",
            errorText: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      })
    );

    const failed = results.some((result) => result.status === "rejected");
    if (failed && successCount === 0) {
      this.queueStore.markDeadLetter(item.id, "system");
      return;
    }

    if (item.kind === "question") {
      this.queueStore.markAwaitingReply(item.id);
    } else {
      this.queueStore.markAnswered(item.id, "system");
    }
  }
}
