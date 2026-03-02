import type {
  ChatProvider,
  ChatContext,
  OutboundMessage,
  ProviderCapabilities,
  ProviderThreadInfo,
  ResponseCallback,
} from "../chat-provider.types.js";
import type { SlackApi } from "./slack.api.js";
import type { SlackSocket, SlackMessageEvent } from "./slack.socket.js";
import type { SlackConfig } from "../../types/config.types.js";
import { toSlackMrkdwn } from "./mrkdwn.js";
import { scanAllChatThreads } from "../../stores/chat-threads.store.js";

interface SlackThreadMetadata {
  channel: string;
  thread_ts: string;
  userId: string;
  [key: string]: unknown;
}

export class SlackProvider implements ChatProvider {
  readonly id = "slack";
  readonly name = "Slack";
  readonly capabilities: ProviderCapabilities = {
    threads: true,
    buttons: false,
    formatting: "markdown",
  };

  private api!: SlackApi;
  private socket!: SlackSocket;
  private responseCallback: ResponseCallback | null = null;
  private threadCache: Map<string, ProviderThreadInfo> = new Map();
  private knownUserId: string | null = null;

  // Overridable for testing
  private scanThreadsFn: typeof scanAllChatThreads = scanAllChatThreads;

  /**
   * Create API client, create Socket (but don't connect), load thread cache.
   */
  async initialize(config: SlackConfig): Promise<void> {
    const { SlackApi: SlackApiClass } = await import("./slack.api.js");
    const { SlackSocket: SlackSocketClass } = await import("./slack.socket.js");

    this.api = new SlackApiClass(config.botToken);
    this.socket = new SlackSocketClass(config.appToken, (event) =>
      this.handleEvent(event),
    );

    await this.loadThreadCache();
  }

  /**
   * Shut down Socket Mode connection.
   */
  async shutdown(): Promise<void> {
    if (this.socket) {
      await this.socket.disconnect();
    }
  }

  setResponseCallback(callback: ResponseCallback): void {
    this.responseCallback = callback;
  }

  /**
   * Start receiving events via Socket Mode.
   * MUST be called after setResponseCallback() to avoid race conditions.
   */
  async connect(): Promise<void> {
    await this.socket.connect();
  }

  /**
   * Create a DM thread for a ticket/brainstorm.
   * Throws if knownUserId is null (user hasn't DM'd the bot yet).
   */
  async createThread(
    context: ChatContext,
    title: string,
  ): Promise<ProviderThreadInfo> {
    if (!this.knownUserId) {
      throw new Error(
        "Slack user ID unknown; waiting for first DM from user",
      );
    }

    const cacheKey = this.getContextKey(context);
    const channel = await this.api.openConversation(this.knownUserId);

    const welcomeText = `*Potato Cannon*\n\nStarting work on: *${title}*\n\nI'll ask questions here as I work.`;
    const threadTs = await this.api.postMessage(
      channel,
      toSlackMrkdwn(welcomeText),
    );

    const thread: ProviderThreadInfo = {
      providerId: this.id,
      threadId: channel,
      metadata: {
        channel,
        thread_ts: threadTs,
        userId: this.knownUserId,
      } as SlackThreadMetadata,
    };

    this.threadCache.set(cacheKey, thread);
    return thread;
  }

  async getThread(context: ChatContext): Promise<ProviderThreadInfo | null> {
    const cacheKey = this.getContextKey(context);
    return this.threadCache.get(cacheKey) || null;
  }

  async send(
    thread: ProviderThreadInfo,
    message: OutboundMessage,
  ): Promise<void> {
    const meta = thread.metadata as unknown as SlackThreadMetadata;

    const text = toSlackMrkdwn(message.text);

    await this.api.postMessage(meta.channel, text, {
      thread_ts: meta.thread_ts,
    });
  }

  async notifyAnswered(
    thread: ProviderThreadInfo,
    answer: string,
  ): Promise<void> {
    const meta = thread.metadata as unknown as SlackThreadMetadata;

    await this.api.postMessage(
      meta.channel,
      `Already answered: "${answer}"`,
      { thread_ts: meta.thread_ts },
    );
  }

  /**
   * Handle an incoming Socket Mode message event.
   */
  private async handleEvent(event: SlackMessageEvent): Promise<void> {
    // Learn user ID from any incoming DM
    if (!this.knownUserId && event.user) {
      this.knownUserId = event.user;
      console.log(`[SlackProvider] Learned user ID: ${event.user}`);
    }

    // If this is a threaded reply, try to route it
    if (event.thread_ts) {
      const context = this.findContextByThread(event.channel, event.thread_ts);
      if (context && this.responseCallback) {
        await this.responseCallback(this.id, context, event.text);
      }
    }
    // Top-level DMs without thread_ts are just user discovery — no action needed
  }

  /**
   * Scan all chat-threads.json files to rebuild the thread cache on restart.
   * Also restores knownUserId from any existing Slack thread metadata.
   */
  private async loadThreadCache(): Promise<void> {
    const allThreads = await this.scanThreadsFn();
    let count = 0;

    for (const [key, { threads }] of allThreads) {
      const slackThread = threads.find((t) => t.providerId === this.id);
      if (slackThread) {
        this.threadCache.set(key, slackThread);
        count++;

        // Restore knownUserId from thread metadata
        const meta = slackThread.metadata as unknown as SlackThreadMetadata;
        if (meta?.userId && !this.knownUserId) {
          this.knownUserId = meta.userId;
        }
      }
    }

    if (count > 0) {
      console.log(
        `[SlackProvider] Loaded ${count} thread(s) from chat-threads files`,
      );
    }
    if (this.knownUserId) {
      console.log(
        `[SlackProvider] Restored known user ID: ${this.knownUserId}`,
      );
    }
  }

  private findContextByThread(
    channel: string,
    thread_ts: string,
  ): ChatContext | null {
    for (const [key, thread] of this.threadCache.entries()) {
      const meta = thread.metadata as unknown as SlackThreadMetadata;
      if (meta.channel === channel && meta.thread_ts === thread_ts) {
        return this.parseContextKey(key);
      }
    }
    return null;
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

  // ── Test helpers (prefixed with underscore) ──────────────────────────

  /** @internal Inject mock dependencies for testing. */
  _injectForTest(
    api: SlackApi,
    socket: SlackSocket,
    scanFn: typeof scanAllChatThreads,
  ): void {
    this.api = api;
    this.socket = socket;
    this.scanThreadsFn = scanFn;
  }

  /** @internal Set knownUserId for testing. */
  _setKnownUserIdForTest(userId: string): void {
    this.knownUserId = userId;
  }

  /** @internal Get knownUserId for testing. */
  _getKnownUserIdForTest(): string | null {
    return this.knownUserId;
  }

  /** @internal Expose handleEvent for testing. */
  async _handleEventForTest(event: SlackMessageEvent): Promise<void> {
    await this.handleEvent(event);
  }
}
