import { describe, it } from "node:test";
import assert from "node:assert";
import type { ConversationMessage } from "../../../types/conversation.types.js";
import { buildRestartSnapshot } from "../continuity-snapshot.service.js";

function makeMessage(input: {
  id: string;
  type: ConversationMessage["type"];
  text: string;
  messageOrigin: "agent" | "user" | "system" | "provider";
}): ConversationMessage {
  return {
    id: input.id,
    conversationId: "conv_1",
    type: input.type,
    text: input.text,
    timestamp: "2026-03-11T00:00:00.000Z",
    metadata: {
      phase: "Build",
      executionGeneration: 9,
      messageOrigin: input.messageOrigin,
    },
  };
}

describe("buildRestartSnapshot", () => {
  it("builds safe_user_context_only packets from user context and pending interaction state", () => {
    const packet = buildRestartSnapshot({
      projectId: "proj_1",
      ticketId: "POT-1",
      currentPhase: "Build",
      targetPhase: "Refinement",
      executionGeneration: 9,
      conversationMessages: [
        makeMessage({
          id: "u1",
          type: "user",
          text: "user intent",
          messageOrigin: "user",
        }),
        makeMessage({
          id: "a1",
          type: "notification",
          text: "assistant output should be excluded",
          messageOrigin: "agent",
        }),
      ],
      pendingQuestion: {
        conversationId: "conv_1",
        question: "Do we keep this direction?",
        options: null,
        askedAt: "2026-03-11T00:00:01.000Z",
        phase: "Build",
        ticketGeneration: 9,
      },
      pendingResponse: {
        answer: "Yes",
        questionId: "q1",
        ticketGeneration: 9,
      },
      limits: {
        maxConversationTurns: 10,
        maxSessionEvents: 10,
        maxCharsPerItem: 200,
        maxPromptChars: 4000,
      },
    });

    assert.ok(packet);
    assert.strictEqual(packet.scope, "safe_user_context_only");
    assert.strictEqual(packet.sessionHighlights.length, 0);
    assert.ok(
      packet.conversationTurns.some((turn) => turn.text.includes("user intent")),
    );
    assert.ok(
      packet.conversationTurns.some((turn) => turn.text.includes("Yes")),
    );
    assert.ok(
      packet.unresolvedQuestions.some((q) =>
        q.includes("Do we keep this direction?"),
      ),
    );
    assert.ok(
      !packet.conversationTurns.some((turn) =>
        turn.text.includes("assistant output"),
      ),
    );
  });
});

