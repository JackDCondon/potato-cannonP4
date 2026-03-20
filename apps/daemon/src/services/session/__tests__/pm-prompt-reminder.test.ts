import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPmPrompt } from "../prompts.js";
import { USER_VISIBLE_OUTPUT_REMINDER } from "../resume-prompt.js";

describe("buildPmPrompt", () => {
  it("includes the user-visible output reminder for fresh PM sessions", async () => {
    const result = await buildPmPrompt(
      "proj-1",
      "brain-1",
      { name: "Epic 1", planSummary: null },
      { pmMode: "passive", userMessage: "What is next?" },
    );

    assert.ok(result.includes(USER_VISIBLE_OUTPUT_REMINDER));
    assert.ok(result.includes("What is next?"));
  });

  it("includes PM mode guardrails and the dedicated PM template instructions", async () => {
    const result = await buildPmPrompt(
      "proj-1",
      "brain-1",
      { name: "Epic 1", planSummary: null },
      { pmMode: "watching" },
    );

    assert.ok(result.includes("The current PM mode is `watching`"));
    assert.ok(result.includes("Never call `set_epic_pm_mode` unless the user explicitly asks"));
    assert.ok(result.includes("Never auto-advance a ticket through a human-gated phase regardless of mode."));
    assert.ok(result.includes("Use `chat_ask` to ask the user a question"));
  });
});
