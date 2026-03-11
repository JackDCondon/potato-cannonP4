import { describe, it } from "node:test";
import assert from "node:assert";
import type { ConversationMessage } from "../../../types/conversation.types.js";
import { buildBoundedContinuityPacket } from "../continuity-context.service.js";

function makeMessage(input: {
  id: string;
  timestamp: string;
  text: string;
  type?: ConversationMessage["type"];
  answeredAt?: string;
  phase?: string;
  executionGeneration?: number;
  agentSource?: string;
  messageOrigin?: "agent" | "user" | "system" | "provider";
}): ConversationMessage {
  return {
    id: input.id,
    conversationId: "conv_1",
    type: input.type ?? "user",
    text: input.text,
    timestamp: input.timestamp,
    answeredAt: input.answeredAt,
    metadata: {
      phase: input.phase ?? "Build",
      executionGeneration: input.executionGeneration ?? 5,
      agentSource: input.agentSource ?? "agents/build.md",
      messageOrigin: input.messageOrigin ?? "user",
    },
  };
}

const baseInput = {
  scope: "same_lifecycle" as const,
  filter: {
    phase: "Build",
    executionGeneration: 5,
    agentSource: "agents/build.md",
  },
  limits: {
    maxConversationTurns: 3,
    maxSessionEvents: 2,
    maxCharsPerItem: 20,
    maxPromptChars: 4000,
  },
};

describe("buildBoundedContinuityPacket", () => {
  it("selects most-recent windows and emits oldest-to-newest", () => {
    const packet = buildBoundedContinuityPacket({
      ...baseInput,
      conversationMessages: [
        makeMessage({
          id: "m1",
          timestamp: "2026-03-11T00:00:01.000Z",
          text: "one",
        }),
        makeMessage({
          id: "m2",
          timestamp: "2026-03-11T00:00:02.000Z",
          text: "two",
        }),
        makeMessage({
          id: "m3",
          timestamp: "2026-03-11T00:00:03.000Z",
          text: "three",
        }),
        makeMessage({
          id: "m4",
          timestamp: "2026-03-11T00:00:04.000Z",
          text: "four",
        }),
      ],
      transcriptHighlights: [
        {
          sourceSessionId: "sess1",
          kind: "assistant",
          summary: "h1",
          timestamp: "2026-03-11T00:00:01.000Z",
        },
        {
          sourceSessionId: "sess1",
          kind: "assistant",
          summary: "h2",
          timestamp: "2026-03-11T00:00:02.000Z",
        },
        {
          sourceSessionId: "sess2",
          kind: "tool",
          summary: "h3",
          timestamp: "2026-03-11T00:00:03.000Z",
        },
      ],
    });

    assert.ok(packet);
    assert.deepStrictEqual(packet.conversationTurns.map((turn) => turn.text), [
      "two",
      "three",
      "four",
    ]);
    assert.deepStrictEqual(
      packet.sessionHighlights.map((highlight) => highlight.summary),
      ["h2", "h3"],
    );
  });

  it("applies per-item truncation", () => {
    const packet = buildBoundedContinuityPacket({
      ...baseInput,
      limits: {
        ...baseInput.limits,
        maxCharsPerItem: 5,
      },
      conversationMessages: [
        makeMessage({
          id: "m1",
          timestamp: "2026-03-11T00:00:01.000Z",
          text: "123456789",
        }),
      ],
      transcriptHighlights: [
        {
          sourceSessionId: "sess1",
          kind: "assistant",
          summary: "ABCDEFGHI",
          timestamp: "2026-03-11T00:00:01.000Z",
        },
      ],
    });

    assert.ok(packet);
    assert.strictEqual(packet.conversationTurns[0]?.text, "12345");
    assert.strictEqual(packet.sessionHighlights[0]?.summary, "ABCDE");
  });

  it("reduces packet content to respect maxPromptChars", () => {
    const packet = buildBoundedContinuityPacket({
      ...baseInput,
      limits: {
        ...baseInput.limits,
        maxCharsPerItem: 200,
        maxPromptChars: 300,
      },
      conversationMessages: [
        makeMessage({
          id: "q1",
          type: "question",
          timestamp: "2026-03-11T00:00:01.000Z",
          text: "unresolved question",
        }),
        makeMessage({
          id: "u1",
          timestamp: "2026-03-11T00:00:02.000Z",
          text: "user context that should survive trimming",
        }),
      ],
      transcriptHighlights: [
        {
          sourceSessionId: "sess1",
          kind: "assistant",
          summary: "assistant detail that can be trimmed first",
          timestamp: "2026-03-11T00:00:01.000Z",
        },
        {
          sourceSessionId: "sess1",
          kind: "tool",
          summary: "tool detail that can be trimmed",
          timestamp: "2026-03-11T00:00:02.000Z",
        },
      ],
    });

    assert.ok(packet);
    assert.ok(JSON.stringify(packet).length <= 300);
    assert.ok(packet.unresolvedQuestions.includes("unresolved question"));
    assert.ok(
      packet.conversationTurns.some((turn) =>
        turn.text.includes("user context"),
      ),
    );
  });

  it("returns null when minimum safe packet does not fit", () => {
    const packet = buildBoundedContinuityPacket({
      ...baseInput,
      limits: {
        ...baseInput.limits,
        maxPromptChars: 10,
      },
      conversationMessages: [
        makeMessage({
          id: "m1",
          timestamp: "2026-03-11T00:00:01.000Z",
          type: "question",
          text: "q",
        }),
      ],
      transcriptHighlights: [],
    });

    assert.strictEqual(packet, null);
  });

  it("filters out messages that do not match provenance metadata", () => {
    const packet = buildBoundedContinuityPacket({
      ...baseInput,
      conversationMessages: [
        makeMessage({
          id: "m1",
          timestamp: "2026-03-11T00:00:01.000Z",
          text: "wrong phase",
          phase: "Refinement",
        }),
        makeMessage({
          id: "m2",
          timestamp: "2026-03-11T00:00:02.000Z",
          text: "right phase",
          phase: "Build",
        }),
      ],
      transcriptHighlights: [],
    });

    assert.ok(packet);
    assert.deepStrictEqual(packet.conversationTurns.map((turn) => turn.text), [
      "right phase",
    ]);
  });
});
