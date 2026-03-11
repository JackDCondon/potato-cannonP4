// src/providers/telegram/telegram.api.ts

export interface TelegramConfig {
  botToken: string;
  userId: string;
  forumGroupId?: string;
}

export class TelegramApi {
  constructor(private config: TelegramConfig) {}

  private get baseUrl(): string {
    return `https://api.telegram.org/bot${this.config.botToken}`;
  }

  private async request<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const result = await response.json();
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }

    return result.result as T;
  }

  async sendMessage(
    chatId: string,
    text: string,
    options: {
      messageThreadId?: number;
      replyMarkup?: unknown;
      parseMode?: string;
    } = {}
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || 'Markdown',
    };

    if (options.messageThreadId) {
      body.message_thread_id = options.messageThreadId;
    }

    if (options.replyMarkup) {
      body.reply_markup = JSON.stringify(options.replyMarkup);
    }

    return this.request("sendMessage", body);
  }

  async createForumTopic(
    chatId: string,
    name: string
  ): Promise<{ message_thread_id: number; name: string }> {
    return this.request("createForumTopic", { chat_id: chatId, name });
  }

  async getUpdates(offset?: number, timeout = 30): Promise<unknown[]> {
    const params = new URLSearchParams({
      timeout: timeout.toString(),
    });
    if (offset !== undefined) {
      params.set('offset', offset.toString());
    }

    return this.request(`getUpdates?${params}`);
  }

  async getChat(chatId: string): Promise<{ id: number; type: string; is_forum?: boolean }> {
    return this.request("getChat", { chat_id: chatId });
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    return this.request("getMe");
  }

  async getChatMember(
    chatId: string,
    userId: number
  ): Promise<{ status: string }> {
    return this.request("getChatMember", { chat_id: chatId, user_id: userId });
  }

  async deleteForumTopic(chatId: string, messageThreadId: number): Promise<boolean> {
    return this.request("deleteForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
    });
  }
}
