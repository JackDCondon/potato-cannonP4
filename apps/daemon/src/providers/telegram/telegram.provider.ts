// src/providers/telegram/telegram.provider.ts

import type Database from "better-sqlite3";
import type {
  ChatProvider,
  ChatContext,
  OutboundMessage,
  ProviderCapabilities,
  ProviderThreadInfo,
  ResponseCallback,
} from "../chat-provider.types.js";
import {
  getContextKey as sharedGetContextKey,
  parseContextKey as sharedParseContextKey,
} from "../chat-provider.types.js";
import { TelegramApi, type TelegramConfig } from "./telegram.api.js";
import { TelegramPoller } from "./telegram.poller.js";
import { createProviderChannelStore, type ProviderChannelStore } from "../../stores/provider-channel.store.js";
import { getDatabase } from "../../stores/db.js";

interface TelegramThreadMetadata {
  chatId: string;
  messageThreadId?: number;
  lastQuestionMessageId?: number;
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
  private reverseThreadCache: Map<string, string> = new Map();
  private providerChannelStore: ProviderChannelStore | null = null;
  private readonly database?: Database.Database;

  constructor(database?: Database.Database) {
    this.database = database;
  }

  async initialize(config: TelegramConfig): Promise<void> {
    this.config = config;
    this.api = new TelegramApi(config);

    // Load thread cache from persisted provider channel rows
    await this.loadThreadCache();
    await this.validateSetup();
  }

  /**
   * Rebuild the in-memory thread cache from provider_channels rows.
   * This ensures incoming messages can be routed to the correct context after daemon restart.
   */
  async loadThreadCache(): Promise<void> {
    const store = this.getProviderChannelStore();
    const db = this.getDatabaseOrNull();
    if (!store || !db) {
      return;
    }

    const channels = store.listChannels().filter((channel) => channel.providerId === this.id);
    let count = 0;
    let skipped = 0;

    for (const channel of channels) {
      const context = channel.ticketId
        ? this.getTicketContext(db, channel.ticketId)
        : channel.brainstormId
        ? this.getBrainstormContext(db, channel.brainstormId)
        : null;

      if (!context) {
        skipped++;
        continue;
      }

      const thread: ProviderThreadInfo = {
        providerId: this.id,
        threadId: channel.channelId,
        metadata: channel.metadata,
      };

      if (this.isThreadCompatibleWithConfig(thread)) {
        const cacheKey = sharedGetContextKey(context);
        this.threadCache.set(cacheKey, thread);
        const reverseKey = this.getReverseThreadKey(thread.metadata as TelegramThreadMetadata);
        if (reverseKey) {
          this.reverseThreadCache.set(reverseKey, cacheKey);
        }
        count++;
      } else {
        skipped++;
      }
    }

    if (count > 0) {
      console.log(
        `[TelegramProvider] Loaded ${count} thread(s) from provider_channels`,
      );
    }
    if (skipped > 0) {
      console.log(
        `[TelegramProvider] Skipped ${skipped} incompatible provider channel route(s)`,
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
    const cacheKey = sharedGetContextKey(context);

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
      const reverseKey = this.getReverseThreadKey(thread.metadata as TelegramThreadMetadata);
      if (reverseKey) {
        this.reverseThreadCache.set(reverseKey, cacheKey);
      }
      this.persistRoute(context, thread);

      // Send welcome message
      const ticketLabel = context.ticketId ? `${title} ${context.ticketId}` : title;

      await this.api.sendMessage(
        this.config.forumGroupId,
        `*Potato Cannon*\n\nStarting work on: *${ticketLabel}*\n\nI'll ask questions here as I work- once we are done i will clean up this thread.`,
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
    const reverseKey = this.getReverseThreadKey(thread.metadata as TelegramThreadMetadata);
    if (reverseKey) {
      this.reverseThreadCache.set(reverseKey, cacheKey);
    }
    this.persistRoute(context, thread);
    return thread;
  }

  async getThread(context: ChatContext): Promise<ProviderThreadInfo | null> {
    const cacheKey = sharedGetContextKey(context);
    const cached = this.threadCache.get(cacheKey);
    if (cached) {
      if (!this.isThreadCompatibleWithConfig(cached)) {
        const reverseKey = this.getReverseThreadKey(
          cached.metadata as TelegramThreadMetadata,
        );
        this.threadCache.delete(cacheKey);
        if (reverseKey) {
          this.reverseThreadCache.delete(reverseKey);
        }
      } else {
      return cached;
      }
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
    if (!this.isThreadCompatibleWithConfig(thread)) {
      return null;
    }
    this.threadCache.set(cacheKey, thread);
    const reverseKey = this.getReverseThreadKey(thread.metadata as TelegramThreadMetadata);
    if (reverseKey) {
      this.reverseThreadCache.set(reverseKey, cacheKey);
    }
    return thread;
  }

  async deleteThread(thread: ProviderThreadInfo): Promise<void> {
    const meta = thread.metadata as TelegramThreadMetadata;
    if (!meta.chatId) {
      return;
    }

    const reverseKey = this.getReverseThreadKey(meta);
    const cacheKey = reverseKey ? this.reverseThreadCache.get(reverseKey) : null;
    if (cacheKey) {
      const cachedThread = this.threadCache.get(cacheKey);
      if (cachedThread === thread) {
        this.threadCache.delete(cacheKey);
      }
      if (reverseKey) {
        this.reverseThreadCache.delete(reverseKey);
      }
    } else {
      for (const [key, cachedThread] of this.threadCache.entries()) {
        if (cachedThread === thread) {
          this.threadCache.delete(key);
          break;
        }
      }
      if (reverseKey) {
        this.reverseThreadCache.delete(reverseKey);
      }
    }

    const store = this.getProviderChannelStore();
    const channel = store
      ? store.findChannelByProviderRoute(this.id, meta.chatId, meta.messageThreadId)
      : null;
    if (store && channel) {
      store.deleteChannel(channel.id);
    }

    try {
      if (meta.messageThreadId) {
        await this.api.deleteForumTopic(meta.chatId, meta.messageThreadId);
      }
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

    const sentMessage = await this.api.sendMessage(
      meta.chatId,
      `*Question:*\n\n${message.text}`,
      options,
    );

    if (message.questionId && typeof sentMessage.message_id === "number") {
      meta.lastQuestionMessageId = sentMessage.message_id;
      this.persistThreadMetadata(thread);
    }
  }

  async notifyAnswered(
    thread: ProviderThreadInfo,
    answer: string,
  ): Promise<void> {
    const meta = thread.metadata as unknown as TelegramThreadMetadata;

    if (typeof meta.lastQuestionMessageId === "number") {
      await this.api.editMessageReplyMarkup(
        meta.chatId,
        meta.lastQuestionMessageId,
        meta.messageThreadId
          ? { messageThreadId: meta.messageThreadId, replyMarkup: null }
          : { replyMarkup: null },
      );
    }

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
    const reverseKey = messageThreadId ? `${chatId}:${messageThreadId}` : chatId;
    const contextKey = this.reverseThreadCache.get(reverseKey);
    if (contextKey) {
      return sharedParseContextKey(contextKey);
    }

    const store = this.getProviderChannelStore();
    if (store) {
      const channel = store.findChannelByProviderRoute(
        this.id,
        chatId,
        messageThreadId,
      );
      if (channel?.ticketId) {
        const db = this.getDatabaseOrNull();
        if (!db) {
          return null;
        }
        const row = db
          .prepare("SELECT project_id FROM tickets WHERE id = ?")
          .get(channel.ticketId) as { project_id: string } | undefined;
        if (row?.project_id) {
          const context = { projectId: row.project_id, ticketId: channel.ticketId };
          this.reverseThreadCache.set(reverseKey, sharedGetContextKey(context));
          return context;
        }
      }
      if (channel?.brainstormId) {
        const db = this.getDatabaseOrNull();
        if (!db) {
          return null;
        }
        const row = db
          .prepare("SELECT project_id FROM brainstorms WHERE id = ?")
          .get(channel.brainstormId) as { project_id: string } | undefined;
        if (row?.project_id) {
          const context = {
            projectId: row.project_id,
            brainstormId: channel.brainstormId,
          };
          this.reverseThreadCache.set(reverseKey, sharedGetContextKey(context));
          return context;
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
      const db = this.getDatabaseOrNull();
      if (!db) {
        return null;
      }
      this.providerChannelStore = createProviderChannelStore(db);
      return this.providerChannelStore;
    } catch {
      return null;
    }
  }

  private getDatabaseOrNull(): Database.Database | null {
    if (this.database) {
      return this.database;
    }

    try {
      return getDatabase();
    } catch {
      return null;
    }
  }

  private getTicketContext(
    db: Database.Database,
    ticketId: string,
  ): ChatContext | null {
    const row = db
      .prepare("SELECT project_id FROM tickets WHERE id = ?")
      .get(ticketId) as { project_id: string } | undefined;
    if (!row?.project_id) {
      return null;
    }

    return { projectId: row.project_id, ticketId };
  }

  private getBrainstormContext(
    db: Database.Database,
    brainstormId: string,
  ): ChatContext | null {
    const row = db
      .prepare("SELECT project_id FROM brainstorms WHERE id = ?")
      .get(brainstormId) as { project_id: string } | undefined;
    if (!row?.project_id) {
      return null;
    }

    return { projectId: row.project_id, brainstormId };
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

  private persistThreadMetadata(thread: ProviderThreadInfo): void {
    const meta = thread.metadata as TelegramThreadMetadata | undefined;
    if (!meta?.chatId) {
      return;
    }

    const store = this.getProviderChannelStore();
    const channel = store?.findChannelByProviderRoute(
      this.id,
      meta.chatId,
      meta.messageThreadId,
    );
    if (!store || !channel?.id) {
      return;
    }

    store.updateChannelMetadata(channel.id, thread.metadata ?? {});
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

  private isThreadCompatibleWithConfig(thread: ProviderThreadInfo): boolean {
    const meta = thread.metadata as TelegramThreadMetadata | undefined;
    if (!meta?.chatId) {
      return false;
    }

    if (this.config.forumGroupId) {
      return (
        meta.chatId === this.config.forumGroupId &&
        typeof meta.messageThreadId === "number"
      );
    }

    return meta.chatId === this.config.userId && !meta.messageThreadId;
  }

  private getReverseThreadKey(meta: TelegramThreadMetadata): string | null {
    if (!meta.chatId) {
      return null;
    }
    return meta.messageThreadId
      ? `${meta.chatId}:${meta.messageThreadId}`
      : meta.chatId;
  }

  _findContextByThreadForTest(
    chatId: string,
    messageThreadId?: number,
  ): ChatContext | null {
    return this.findContextByThread(chatId, messageThreadId);
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
