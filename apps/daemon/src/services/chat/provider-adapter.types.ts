import type {
  ChatContext,
  OutboundMessage,
  ProviderThreadInfo,
} from "../../providers/chat-provider.types.js";

export interface ProviderRoute {
  providerId: string;
  context: ChatContext;
  thread: ProviderThreadInfo;
}

export interface ProviderAdapter {
  providerId: string;
  ensureRoute(context: ChatContext, title: string): Promise<ProviderRoute>;
  sendQuestion(route: ProviderRoute, message: OutboundMessage): Promise<void>;
  sendNotification(route: ProviderRoute, message: OutboundMessage): Promise<void>;
  notifyAnswered(route: ProviderRoute, answer: string): Promise<void>;
}

export interface ProviderInboundAnswer {
  providerId: string;
  context: ChatContext;
  answer: string;
}
