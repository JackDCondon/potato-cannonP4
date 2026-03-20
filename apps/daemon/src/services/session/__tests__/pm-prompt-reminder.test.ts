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
});
