import {
  DEFAULT_CHAT_NOTIFICATION_POLICY,
  type ChatNotificationCategory,
} from "@potato-cannon/shared";
import type {
  ChatContext,
  OutboundMessage,
} from "../providers/chat-provider.types.js";
import { getBoardChatNotificationPolicy } from "../stores/board-settings.store.js";
import { getWorkflowId } from "./chat.service.utils.js";

function resolveMessageCategory(
  message: OutboundMessage,
): ChatNotificationCategory {
  if (message.category) {
    return message.category;
  }

  if (message.kind === "question") {
    return "questions";
  }

  return "builder_updates";
}

export function shouldDeliverMessageToProviders(
  context: ChatContext,
  message: OutboundMessage,
): boolean {
  const workflowId = getWorkflowId(context);
  if (!workflowId) {
    return true;
  }

  const category = resolveMessageCategory(message);
  const policy = getBoardChatNotificationPolicy(workflowId);
  return (
    policy.categories[category] ??
    DEFAULT_CHAT_NOTIFICATION_POLICY.categories[category]
  );
}
