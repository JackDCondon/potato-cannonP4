import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

type NotifyCall = {
  context: unknown;
  message: string;
};

const notifyCalls: NotifyCall[] = [];

mock.module("../../../services/chat.service.js", {
  namedExports: {
    chatService: {
      askAsync: async () => ({ status: "pending", questionId: "q_test" }),
      notify: async (context: unknown, message: string) => {
        notifyCalls.push({ context, message });
      },
      initChat: async () => {},
    },
  },
});

const { chatHandlers, formatAgentNotificationHeader, toModelDisplayLabel } =
  await import("../chat.tools.js");

describe("chat tools notify formatting", () => {
  beforeEach(() => {
    notifyCalls.length = 0;
  });

  it("adds model label to an agent-prefixed notification", async () => {
    await chatHandlers.chat_notify(
      {
        projectId: "proj-1",
        ticketId: "POT-1",
        brainstormId: "",
        workflowId: "wf-1",
        daemonUrl: "http://localhost:8443",
        agentModel: "opus",
      },
      { message: "[Adversarial Architect Agent]: Reviewing architecture." },
    );

    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(
      notifyCalls[0].message,
      "[Adversarial Architect Agent (Opus)]: Reviewing architecture.",
    );
    assert.strictEqual(
      (notifyCalls[0].context as { agentModel?: string }).agentModel,
      "opus",
    );
  });

  it("does not duplicate a model label when one already exists", () => {
    const result = formatAgentNotificationHeader(
      "[Architect Agent (Opus)]: Already labeled.",
      "opus",
    );
    assert.strictEqual(result, "[Architect Agent (Opus)]: Already labeled.");
  });

  it("keeps non-agent messages unchanged", () => {
    const result = formatAgentNotificationHeader("Build complete.", "opus");
    assert.strictEqual(result, "Build complete.");
  });

  it("keeps messages unchanged when model is unavailable", () => {
    const result = formatAgentNotificationHeader(
      "[Specification Agent]: Drafted ticket plan.",
      undefined,
    );
    assert.strictEqual(result, "[Specification Agent]: Drafted ticket plan.");
  });

  it("normalizes common model identifiers into user-friendly labels", () => {
    assert.strictEqual(toModelDisplayLabel("opus"), "Opus");
    assert.strictEqual(toModelDisplayLabel("claude-sonnet-4-20250514"), "Sonnet");
    assert.strictEqual(toModelDisplayLabel("o3"), "O3");
  });
});
