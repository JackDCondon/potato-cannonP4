import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveModelTier } from "../model-tier-resolver.js";

describe("resolveModelTier", () => {
  it("selects a direct tier string unchanged", () => {
    assert.strictEqual(resolveModelTier("high", "simple"), "high");
  });
});
