import type { ChatContext, ProviderThreadInfo } from "../../providers/chat-provider.types.js";
import {
  createProviderChannelStore,
  type ProviderChannelStore,
} from "../../stores/provider-channel.store.js";
import { getDatabase } from "../../stores/db.js";

export class ChatRoutingService {
  constructor(private providerChannelStore: ProviderChannelStore = createProviderChannelStore(getDatabase())) {}

  getRoute(context: ChatContext, providerId: string): ProviderThreadInfo | null {
    const channel = context.ticketId
      ? this.providerChannelStore.getChannelForTicket(context.ticketId, providerId)
      : context.brainstormId
      ? this.providerChannelStore.getChannelForBrainstorm(context.brainstormId, providerId)
      : null;

    if (!channel) {
      return null;
    }

    return {
      providerId: channel.providerId,
      threadId: channel.channelId,
      metadata: channel.metadata,
    };
  }

  saveRoute(context: ChatContext, thread: ProviderThreadInfo): ProviderThreadInfo {
    const existing = context.ticketId
      ? this.providerChannelStore.getChannelForTicket(context.ticketId, thread.providerId)
      : context.brainstormId
      ? this.providerChannelStore.getChannelForBrainstorm(context.brainstormId, thread.providerId)
      : null;

    if (!existing) {
      this.providerChannelStore.createChannel({
        ticketId: context.ticketId,
        brainstormId: context.brainstormId,
        providerId: thread.providerId,
        channelId: thread.threadId,
        metadata: thread.metadata,
      });
      return thread;
    }

    if (
      existing.channelId === thread.threadId &&
      JSON.stringify(existing.metadata ?? {}) === JSON.stringify(thread.metadata ?? {})
    ) {
      return thread;
    }

    this.providerChannelStore.deleteChannel(existing.id);
    this.providerChannelStore.createChannel({
      ticketId: context.ticketId,
      brainstormId: context.brainstormId,
      providerId: thread.providerId,
      channelId: thread.threadId,
      metadata: thread.metadata,
    });
    return thread;
  }
}
