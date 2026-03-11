import { describe, it } from "node:test";
import assert from "node:assert";

import {
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
