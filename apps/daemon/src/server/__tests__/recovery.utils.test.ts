import { describe, it } from "node:test";
import assert from "node:assert";

import { safeReadPendingResponse } from "../recovery.utils.js";

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
