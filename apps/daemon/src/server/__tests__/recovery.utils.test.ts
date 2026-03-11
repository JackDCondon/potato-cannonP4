import { describe, it } from "node:test";
import assert from "node:assert";

import {
  buildContinuityDecisionLogFields,
  isStalePendingTicketInput,
  safeReadPendingResponse,
} from "../recovery.utils.js";

describe("safeReadPendingResponse", () => {
  it("returns pending response when reader succeeds", async () => {
    const result = await safeReadPendingResponse(
      async () => ({ answer: "yes" }),
      "proj-1",
      "TCK-1",
    );
    assert.deepStrictEqual(result, { answer: "yes" });
  });

  it("returns null when reader throws", async () => {
    const result = await safeReadPendingResponse(
      async () => {
        throw new ReferenceError("readResponse is not defined");
      },
      "proj-1",
      "TCK-2",
    );
    assert.strictEqual(result, null);
  });
});

describe("isStalePendingTicketInput", () => {
  it("returns false when ticket input identity matches pending question and current generation", () => {
    const stale = isStalePendingTicketInput({
      providedGeneration: 4,
      providedQuestionId: "q-1",
      expectedGeneration: 4,
      expectedQuestionId: "q-1",
      currentGeneration: 4,
      hasPendingQuestion: true,
    });

    assert.strictEqual(stale, false);
  });

  it("returns true when generation or question id does not match", () => {
    const stale = isStalePendingTicketInput({
      providedGeneration: 3,
      providedQuestionId: "q-old",
      expectedGeneration: 4,
      expectedQuestionId: "q-1",
      currentGeneration: 4,
      hasPendingQuestion: true,
    });

    assert.strictEqual(stale, true);
  });
});

describe("buildContinuityDecisionLogFields", () => {
  it("formats structured continuity fields for fresh fallback when resume is rejected", () => {
    const fields = buildContinuityDecisionLogFields({
      mode: "fresh",
      reason: "resume_not_allowed",
    });

    assert.deepStrictEqual(fields, {
      continuity_mode: "fresh",
      continuity_reason: "resume_not_allowed",
      continuity_scope: "none",
      continuity_source_session_id: "none",
      continuity_resume_rejected: "true",
    });
  });

  it("formats structured continuity fields for resume decisions", () => {
    const fields = buildContinuityDecisionLogFields({
      mode: "resume",
      reason: "same_lifecycle_resume",
      sourceSessionId: "claude_123",
    });

    assert.deepStrictEqual(fields, {
      continuity_mode: "resume",
      continuity_reason: "same_lifecycle_resume",
      continuity_scope: "none",
      continuity_source_session_id: "claude_123",
      continuity_resume_rejected: "false",
    });
  });
});
