import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildResumePrompt } from "../resume-prompt.js";

describe("buildResumePrompt", () => {
  it("prepends communication reminder to user response", () => {
    const result = buildResumePrompt("Option B please");
    assert.ok(result.includes("Option B please"));
    assert.ok(result.includes("chat_notify"));
    assert.ok(result.indexOf("chat_notify") < result.indexOf("Option B please"));
  });

  it("preserves the full user response", () => {
    const response = "I want option C — keep as informational, drop gracePeriodMs.";
    const result = buildResumePrompt(response);
    assert.ok(result.includes(response));
  });
});
