// src/providers/telegram/telegram.provider.ts

import type {
  ChatProvider,
  ChatContext,
  OutboundMessage,
  ProviderCapabilities,
  ProviderThreadInfo,
  ResponseCallback,
} from "../chat-provider.types.js";
import { TelegramApi, type TelegramConfig } from "./telegram.api.js";
import { TelegramPoller } from "./telegram.poller.js";
import { scanAllChatThreads } from "../../stores/chat-threads.store.js";
import { createProviderChannelStore, type ProviderChannelStore } from "../../stores/provider-channel.store.js";
import { getDatabase } from "../../stores/db.js";

interface TelegramThreadMetadata {
  chatId: string;
  messageThreadId?: number;
  [key: string]: unknown;
}

export class TelegramProvider implements ChatProvider {
  readonly id = "telegram";
  readonly name = "Telegram";
  readonly capabilities: ProviderCapabilities = {
    threads: true,
    buttons: true,
    formatting: "markdown",
  };

  private config!: TelegramConfig;
  private api!: TelegramApi;
  private poller: TelegramPoller | null = null;
  private responseCallback: ResponseCallback | null = null;
  private threadCache: Map<string, ProviderThreadInfo> = new Map();
  private providerChannelStore: ProviderChannelStore | null = null;

  async initialize(config: TelegramConfig): Promise<void> {
    this.config = config;
    this.api = new TelegramApi(config);

    // Load thread cache from all existing chat-threads.json files
    await this.loadThreadCache();
    await this.validateSetup();
  }

  /**
   * Scan all tickets and brainstorms to rebuild the in-memory thread cache.
   * This ensures incoming messages can be routed to the correct context after daemon restart.
   */
  async loadThreadCache(): Promise<void> {
    const allThreads = await scanAllChatThreads();
    let count = 0;

    for (const [key, { threads }] of allThreads) {
      const telegramThread = threads.find((t) => t.providerId === this.id);
      if (telegramThread) {
        this.threadCache.set(key, telegramThread);
        count++;
      }
    }

    if (count > 0) {
      console.log(
        `[TelegramProvider] Loaded ${count} thread(s) from chat-threads files`,
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.poller) {
      this.poller.stop();
      this.poller = null;
    }
  }

  setResponseCallback(callback: ResponseCallback): void {
    this.responseCallback = callback;
  }

  startPolling(): void {
    if (this.poller) return;

    this.poller = new TelegramPoller(this.config.botToken, async (update) => {
      await this.handleUpdate(update);
    });
    this.poller.start();
  }

  async createThread(
    context: ChatContext,
    title: string,
  ): Promise<ProviderThreadInfo> {
    const cacheKey = this.getContextKey(context);

    if (this.config.forumGroupId) {
      const topicName =
        title.length > 128 ? `${title.substring(0, 125)}...` : title;
      const topic = await this.api.createForumTopic(
        this.config.forumGroupId,
        topicName,
      );

      const thread: ProviderThreadInfo = {
        providerId: this.id,
        threadId: this.config.forumGroupId,
        metadata: {
          chatId: this.config.forumGroupId,
          messageThreadId: topic.message_thread_id,
        } as TelegramThreadMetadata,
      };

      this.threadCache.set(cacheKey, thread);
      this.persistRoute(context, thread);

      // Send welcome message
      await this.api.sendMessage(
        this.config.forumGroupId,
        `*Potato Cannon*\n\nStarting work on: *${title}*\n\nI'll ask questions here as I work.`,
        { messageThreadId: topic.message_thread_id },
      );

      return thread;
    }

    // Direct chat fallback
    const thread: ProviderThreadInfo = {
      providerId: this.id,
      threadId: this.config.userId,
      metadata: {
        chatId: this.config.userId,
      } as TelegramThreadMetadata,
    };

    this.threadCache.set(cacheKey, thread);
    this.persistRoute(context, thread);
    return thread;
  }

  async getThread(context: ChatContext): Promise<ProviderThreadInfo | null> {
    const cacheKey = this.getContextKey(context);
    const cached = this.threadCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const store = this.getProviderChannelStore();
    if (!store) {
      return null;
    }

    const channel = context.ticketId
      ? store.getChannelForTicket(context.ticketId, this.id)
      : context.brainstormId
      ? store.getChannelForBrainstorm(context.brainstormId, this.id)
      : null;

    if (!channel) {
      return null;
    }

    const thread: ProviderThreadInfo = {
      providerId: this.id,
      threadId: channel.channelId,
      metadata: channel.metadata,
    };
    this.threadCache.set(cacheKey, thread);
    return thread;
  }

  async deleteThread(thread: ProviderThreadInfo): Promise<void> {
    const meta = thread.metadata as TelegramThreadMetadata;
    if (!meta.chatId || !meta.messageThreadId) {
      return;
    }
    try {
      await this.api.deleteForumTopic(meta.chatId, meta.messageThreadId);
    } catch (error) {
      console.warn(
        `[TelegramProvider] Failed to delete topic ${meta.messageThreadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async send(
    thread: ProviderThreadInfo,
    message: OutboundMessage,
  ): Promise<void> {
    const meta = thread.metadata as unknown as TelegramThreadMetadata;

    const options: Parameters<TelegramApi["sendMessage"]>[2] = {};

    if (meta.messageThreadId) {
      options.messageThreadId = meta.messageThreadId;
    }

    if (message.options && message.options.length > 0) {
      options.replyMarkup = {
        inline_keyboard: message.options.map((opt, idx) => [
          {
            text: opt,
            callback_data: message.questionId
              ? `answer:${message.questionId}:${idx}`
              : `answer_${idx}`,
          },
        ]),
      };
    }

    await this.api.sendMessage(
      meta.chatId,
      `*Question:*\n\n${message.text}`,
      options,
    );
  }

  async notifyAnswered(
    thread: ProviderThreadInfo,
    answer: string,
  ): Promise<void> {
    const meta = thread.metadata as unknown as TelegramThreadMetadata;

    await this.api.sendMessage(
      meta.chatId,
      `✓ Already answered: "${answer}"`,
      meta.messageThreadId ? { messageThreadId: meta.messageThreadId } : {},
    );
  }

  private async handleUpdate(update: unknown): Promise<void> {
    // Type the update
    const u = update as {
      callback_query?: {
        message?: { chat?: { id: number }; message_thread_id?: number };
        data?: string;
      };
      message?: {
        chat?: { id: number };
        message_thread_id?: number;
        text?: string;
      };
    };

    if (u.callback_query) {
      await this.handleCallbackQuery(u.callback_query);
    } else if (u.message?.text) {
      await this.handleMessage(u.message);
    }
  }

  private async handleCallbackQuery(
    query: NonNullable<{
      message?: { chat?: { id: number }; message_thread_id?: number };
      data?: string;
    }>,
  ): Promise<void> {
    const chatId = query.message?.chat?.id;
    const messageThreadId = query.message?.message_thread_id;
    const data = query.data;

    if (!chatId || !data || !this.responseCallback) return;

    const match = data.match(/^answer_(\d+)$/);
    const structuredMatch = data.match(/^answer:([^:]+):(\d+)$/);
    if (!match && !structuredMatch) return;

    // Find context from thread cache
    const context = this.findContextByThread(
      chatId.toString(),
      messageThreadId,
    );
    if (!context) return;

    // For now, we need to get the options from somewhere
    // This will be handled by the ChatService's pending options
    await this.responseCallback(this.id, context, data);
  }

  private async handleMessage(
    message: NonNullable<{
      chat?: { id: number };
      message_thread_id?: number;
      text?: string;
    }>,
  ): Promise<void> {
    const chatId = message.chat?.id;
    const messageThreadId = message.message_thread_id;
    const text = message.text;

    if (!chatId || !text || !this.responseCallback) return;

    const context = this.findContextByThread(
      chatId.toString(),
      messageThreadId,
    );
    if (!context) return;

    await this.responseCallback(this.id, context, text);
  }

  private findContextByThread(
    chatId: string,
    messageThreadId?: number,
  ): ChatContext | null {
    for (const [key, thread] of this.threadCache.entries()) {
      const meta = thread.metadata as unknown as TelegramThreadMetadata;
      if (meta.chatId === chatId) {
        if (messageThreadId && meta.messageThreadId === messageThreadId) {
          return this.parseContextKey(key);
        }
        if (!messageThreadId && !meta.messageThreadId) {
          return this.parseContextKey(key);
        }
      }
    }

    const store = this.getProviderChannelStore();
    if (store) {
      const channel = store.findChannelByProviderRoute(
        this.id,
        chatId,
        messageThreadId,
      );
      if (channel?.ticketId) {
        const row = getDatabase()
          .prepare("SELECT project_id FROM tickets WHERE id = ?")
          .get(channel.ticketId) as { project_id: string } | undefined;
        if (row?.project_id) {
          return { projectId: row.project_id, ticketId: channel.ticketId };
        }
      }
      if (channel?.brainstormId) {
        const row = getDatabase()
          .prepare("SELECT project_id FROM brainstorms WHERE id = ?")
          .get(channel.brainstormId) as { project_id: string } | undefined;
        if (row?.project_id) {
          return {
            projectId: row.project_id,
            brainstormId: channel.brainstormId,
          };
        }
      }
    }
    return null;
  }

  private getProviderChannelStore(): ProviderChannelStore | null {
    if (this.providerChannelStore) {
      return this.providerChannelStore;
    }
    try {
      this.providerChannelStore = createProviderChannelStore(getDatabase());
      return this.providerChannelStore;
    } catch {
      return null;
    }
  }

  private persistRoute(context: ChatContext, thread: ProviderThreadInfo): void {
    const store = this.getProviderChannelStore();
    if (!store) {
      return;
    }

    const existing = context.ticketId
      ? store.getChannelForTicket(context.ticketId, this.id)
      : context.brainstormId
      ? store.getChannelForBrainstorm(context.brainstormId, this.id)
      : null;

    if (existing?.id) {
      store.deleteChannel(existing.id);
    }

    store.createChannel({
      ticketId: context.ticketId,
      brainstormId: context.brainstormId,
      providerId: this.id,
      channelId: (thread.metadata as TelegramThreadMetadata)?.chatId ?? thread.threadId,
      metadata: thread.metadata,
    });
  }

  private async validateSetup(): Promise<void> {
    if (!this.config.forumGroupId) {
      return;
    }

    try {
      const chat = await this.api.getChat(this.config.forumGroupId);
      if (!chat.is_forum) {
        console.warn(
          `[TelegramProvider] forumGroupId ${this.config.forumGroupId} is not forum-enabled`,
        );
      }

      const bot = await this.api.getMe();
      const membership = await this.api.getChatMember(
        this.config.forumGroupId,
        bot.id,
      );
      if (!["administrator", "creator"].includes(membership.status)) {
        console.warn(
          `[TelegramProvider] Bot lacks admin rights in forum group ${this.config.forumGroupId}`,
        );
      }
    } catch (error) {
      console.warn(
        `[TelegramProvider] Setup validation warning: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getContextKey(context: ChatContext): string {
    return `${context.projectId}:${context.ticketId || context.brainstormId}`;
  }

  private parseContextKey(key: string): ChatContext | null {
    const [projectId, id] = key.split(":");
    if (!projectId || !id) return null;

    if (id.startsWith("brain_")) {
      return { projectId, brainstormId: id };
    }
    return { projectId, ticketId: id };
  }

  // Test helpers
  _setConfigForTest(config: TelegramConfig): void {
    this.config = config;
  }

  _injectApiForTest(api: TelegramApi): void {
    this.api = api;
  }

  async _handleUpdateForTest(update: unknown): Promise<void> {
    await this.handleUpdate(update);
  }
}
