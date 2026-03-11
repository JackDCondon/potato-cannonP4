import type { ConversationMessage } from "../../types/conversation.types.js";
import type {
  ContinuityPacket,
  ContinuityPacketScope,
  ContinuityPacketTurn,
  ContinuityPacketHighlight,
} from "./continuity.types.js";

export interface ContinuityTranscriptHighlightInput {
  sourceSessionId: string;
  kind: "assistant" | "tool";
  summary: string;
  timestamp?: string;
}

export interface ContinuityPacketFilter {
  phase?: string;
  executionGeneration?: number;
  agentSource?: string;
}

export interface ContinuityPacketLimits {
  maxConversationTurns: number;
  maxSessionEvents: number;
  maxCharsPerItem: number;
  maxPromptChars: number;
}

export interface BuildContinuityPacketInput {
  scope: ContinuityPacketScope;
  reasonForRestart?: string;
  filter: ContinuityPacketFilter;
  limits: ContinuityPacketLimits;
  conversationMessages: ConversationMessage[];
  transcriptHighlights: ContinuityTranscriptHighlightInput[];
}

function toBoundedPositiveInt(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}

function truncateText(value: string, maxCharsPerItem: number): string {
  return value.trim().slice(0, maxCharsPerItem);
}

function toTimestampValue(timestamp?: string): number {
  if (!timestamp) {
    return Number.MIN_SAFE_INTEGER;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.MIN_SAFE_INTEGER;
}

function estimatePacketChars(packet: ContinuityPacket): number {
  return JSON.stringify(packet).length;
}

function messagePassesProvenanceFilter(
  message: ConversationMessage,
  filter: ContinuityPacketFilter,
): boolean {
  const metadata = message.metadata;
  if (!metadata) {
    return false;
  }
  if (filter.phase && metadata.phase !== filter.phase) {
    return false;
  }
  if (
    filter.executionGeneration !== undefined &&
    metadata.executionGeneration !== filter.executionGeneration
  ) {
    return false;
  }
  if (filter.agentSource && metadata.agentSource !== filter.agentSource) {
    return false;
  }
  return true;
}

function toTurnRole(
  message: ConversationMessage,
): "user" | "assistant" | "system" {
  const origin = message.metadata?.messageOrigin;
  if (origin === "user" || message.type === "user") {
    return "user";
  }
  if (origin === "system") {
    return "system";
  }
  return "assistant";
}

function sortByTimestampAscending<T extends { timestamp?: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => toTimestampValue(a.timestamp) - toTimestampValue(b.timestamp),
  );
}

export function buildBoundedContinuityPacket(
  input: BuildContinuityPacketInput,
): ContinuityPacket | null {
  const maxConversationTurns = toBoundedPositiveInt(
    input.limits.maxConversationTurns,
  );
  const maxSessionEvents = toBoundedPositiveInt(input.limits.maxSessionEvents);
  const maxCharsPerItem = toBoundedPositiveInt(input.limits.maxCharsPerItem);
  const maxPromptChars = toBoundedPositiveInt(input.limits.maxPromptChars);

  // 1) Provenance filter
  const provenanceMessages = input.conversationMessages.filter((message) =>
    messagePassesProvenanceFilter(message, input.filter),
  );
  const sortedMessages = sortByTimestampAscending(provenanceMessages);
  const sortedHighlights = sortByTimestampAscending(input.transcriptHighlights).filter(
    (highlight) => highlight.summary.trim().length > 0,
  );

  // 2) Count window
  const windowedMessages = sortedMessages.slice(
    Math.max(0, sortedMessages.length - maxConversationTurns),
  );
  const windowedHighlights = sortedHighlights.slice(
    Math.max(0, sortedHighlights.length - maxSessionEvents),
  );

  // 3) Per-item truncation
  const conversationTurns: ContinuityPacketTurn[] = [];
  for (const message of windowedMessages) {
    const text = truncateText(message.text, maxCharsPerItem);
    if (text.length === 0) {
      continue;
    }
    conversationTurns.push({
      role: toTurnRole(message),
      text,
      timestamp: message.timestamp,
      sourceSessionId: message.metadata?.sourceSessionId,
    });
  }

  const sessionHighlights: ContinuityPacketHighlight[] = [];
  for (const highlight of windowedHighlights) {
    const summary = truncateText(highlight.summary, maxCharsPerItem);
    if (summary.length === 0) {
      continue;
    }
    sessionHighlights.push({
      summary,
      timestamp: highlight.timestamp,
      sourceSessionId: highlight.sourceSessionId,
    });
  }

  const unresolvedQuestions = windowedMessages
    .filter((message) => message.type === "question" && !message.answeredAt)
    .map((message) => truncateText(message.text, maxCharsPerItem))
    .filter((question) => question.length > 0);

  let packet: ContinuityPacket = {
    scope: input.scope,
    reasonForRestart: input.reasonForRestart,
    conversationTurns,
    sessionHighlights,
    unresolvedQuestions,
  };

  // 4) Total-packet trimming with stable priority order (oldest dropped first)
  const removeOldest = <T>(
    items: T[],
    predicate: (item: T) => boolean,
  ): boolean => {
    const index = items.findIndex(predicate);
    if (index < 0) {
      return false;
    }
    items.splice(index, 1);
    return true;
  };

  while (estimatePacketChars(packet) > maxPromptChars) {
    if (
      removeOldest(packet.sessionHighlights, (item) =>
        item.summary.startsWith("tool_use:"),
      ) ||
      removeOldest(packet.sessionHighlights, () => true) ||
      removeOldest(packet.conversationTurns, (item) => item.role !== "user") ||
      removeOldest(packet.conversationTurns, () => true) ||
      removeOldest(packet.unresolvedQuestions, () => true)
    ) {
      continue;
    }
    break;
  }

  // 5) Fail closed when no safe bounded packet can fit
  if (estimatePacketChars(packet) > maxPromptChars) {
    return null;
  }
  if (
    packet.conversationTurns.length === 0 &&
    packet.sessionHighlights.length === 0 &&
    packet.unresolvedQuestions.length === 0
  ) {
    return null;
  }

  return packet;
}
