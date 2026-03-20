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
import { createProviderChannelStore, type ProviderChannelStore } from "../../stores/provider-channel.store.js";
import { getDatabase } from "../../stores/db.js";

interface SlackThreadMetadata {
  channel: string;
  threadTs: string;
  userId?: string;
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
  private channelId: string | null = null;
  private providerChannelStore: ProviderChannelStore | null = null;

  /**
   * Create API client, create Socket (but don't connect), resolve channel, load thread cache.
   */
  async initialize(config: SlackConfig): Promise<void> {
    const { SlackApi: SlackApiClass } = await import("./slack.api.js");
    const { SlackSocket: SlackSocketClass } = await import("./slack.socket.js");

    this.api = new SlackApiClass(config.botToken);
    this.socket = new SlackSocketClass(config.appToken, (event) =>
      this.handleEvent(event),
    );

    // Resolve channel: explicit config > auto-discovery
    if (config.channelId) {
      this.channelId = config.channelId;
      console.log(`[SlackProvider] Using configured channel: ${config.channelId}`);
    } else {
      try {
        const discovered = await this.api.discoverChannel();
        if (discovered) {
          this.channelId = discovered.id;
          console.log(`[SlackProvider] Auto-discovered channel: #${discovered.name} (${discovered.id})`);
        } else {
          console.warn("[SlackProvider] No channel found — bot will be mute until added to a channel");
        }
      } catch (err) {
        console.warn(
          `[SlackProvider] Channel auto-discovery failed: ${(err as Error).message}. ` +
          `Set channelId in config or add the channels:read scope and reinstall the Slack app.`
        );
      }
    }

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
   * Create a thread in the bot's channel for a ticket/brainstorm.
   * Throws if no channel has been resolved.
   */
  async createThread(
    context: ChatContext,
    title: string,
  ): Promise<ProviderThreadInfo> {
    if (!this.channelId) {
      throw new Error(
        "Slack channel not resolved; add the bot to a channel or set channelId in config",
      );
    }

    const cacheKey = this.getContextKey(context);

    const ticketLabel = context.ticketId ? `${title} ${context.ticketId}` : title;
    const welcomeText =
      `*Potato Cannon*\n\nStarting work on: *${ticketLabel}*` +
      `\n\nI'll ask questions here as I work- once we are done i will clean up this thread.`;
    const threadTs = await this.api.postMessage(
      this.channelId,
      toSlackMrkdwn(welcomeText),
    );

    const thread: ProviderThreadInfo = {
      providerId: this.id,
      threadId: this.channelId,
      metadata: {
        channel: this.channelId,
        threadTs,
      } as SlackThreadMetadata,
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
    // Slack thread deletion is not available for this bot flow.
    // We still clear cache to avoid stale reverse lookups.
    for (const [key, value] of this.threadCache.entries()) {
      if (
        value.providerId === thread.providerId &&
        value.threadId === thread.threadId
      ) {
        this.threadCache.delete(key);
      }
    }
  }

  async send(
    thread: ProviderThreadInfo,
    message: OutboundMessage,
  ): Promise<void> {
    const meta = thread.metadata as unknown as SlackThreadMetadata;

    const text = toSlackMrkdwn(message.text);

    await this.api.postMessage(meta.channel, text, {
      thread_ts: (meta as { threadTs?: string; thread_ts?: string }).threadTs
        ?? (meta as { threadTs?: string; thread_ts?: string }).thread_ts,
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
      {
        thread_ts: (meta as { threadTs?: string; thread_ts?: string }).threadTs
          ?? (meta as { threadTs?: string; thread_ts?: string }).thread_ts,
      },
    );
  }

  /**
   * Handle an incoming Socket Mode message event.
   */
  private async handleEvent(event: SlackMessageEvent): Promise<void> {
    // If this is a threaded reply, try to route it
    if (event.thread_ts) {
      const context = this.findContextByThread(event.channel, event.thread_ts);
      if (context && this.responseCallback) {
        await this.responseCallback(this.id, context, event.text);
      }
    }
    // Top-level channel messages without thread_ts are ignored
  }

  /**
   * Rebuild the thread cache from provider_channels rows on restart.
   */
  private async loadThreadCache(): Promise<void> {
    const store = this.getProviderChannelStore();
    if (!store) {
      return;
    }

    const db = getDatabase();
    const channels = store
      .listChannels()
      .filter((channel) => channel.providerId === this.id);
    let count = 0;

    for (const channel of channels) {
      const context = channel.ticketId
        ? this.getTicketContext(db, channel.ticketId)
        : channel.brainstormId
        ? this.getBrainstormContext(db, channel.brainstormId)
        : null;
      if (!context) {
        continue;
      }

      this.threadCache.set(this.getContextKey(context), {
        providerId: this.id,
        threadId: channel.channelId,
        metadata: channel.metadata,
      });
      count++;
    }

    if (count > 0) {
      console.log(
        `[SlackProvider] Loaded ${count} thread(s) from provider_channels`,
      );
    }
  }

  private getTicketContext(
    db: ReturnType<typeof getDatabase>,
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
    db: ReturnType<typeof getDatabase>,
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

  private findContextByThread(
    channel: string,
    thread_ts: string,
  ): ChatContext | null {
    for (const [key, thread] of this.threadCache.entries()) {
      const meta = thread.metadata as unknown as SlackThreadMetadata;
      const cachedThreadTs = (meta as { threadTs?: string; thread_ts?: string }).threadTs
        ?? (meta as { threadTs?: string; thread_ts?: string }).thread_ts;
      if (meta.channel === channel && cachedThreadTs === thread_ts) {
        return this.parseContextKey(key);
      }
    }

    const store = this.getProviderChannelStore();
    if (store) {
      const route = store.findChannelByProviderRoute(this.id, channel, thread_ts);
      if (route?.ticketId) {
        const row = getDatabase()
          .prepare("SELECT project_id FROM tickets WHERE id = ?")
          .get(route.ticketId) as { project_id: string } | undefined;
        if (row?.project_id) {
          return { projectId: row.project_id, ticketId: route.ticketId };
        }
      }
      if (route?.brainstormId) {
        const row = getDatabase()
          .prepare("SELECT project_id FROM brainstorms WHERE id = ?")
          .get(route.brainstormId) as { project_id: string } | undefined;
        if (row?.project_id) {
          return { projectId: row.project_id, brainstormId: route.brainstormId };
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
      channelId: (thread.metadata as SlackThreadMetadata).channel,
      metadata: thread.metadata,
    });
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
  ): void {
    this.api = api;
    this.socket = socket;
  }

  /** @internal Set channelId for testing. */
  _setChannelIdForTest(channelId: string): void {
    this.channelId = channelId;
  }

  /** @internal Get channelId for testing. */
  _getChannelIdForTest(): string | null {
    return this.channelId;
  }

  /** @internal Expose handleEvent for testing. */
  async _handleEventForTest(event: SlackMessageEvent): Promise<void> {
    await this.handleEvent(event);
  }
}
