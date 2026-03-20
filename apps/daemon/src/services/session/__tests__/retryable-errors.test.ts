import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchRetryableError } from "../retryable-errors.js";

describe("matchRetryableError", () => {
  it("should match 'hit your limit' error", () => {
    const reason =
      "Session exited with code 1: You've hit your limit for claude-3-5-sonnet.\n" +
      "Claude rate limit reached (usage). Resets at 3/20/2026, 10:00:00 AM.\n" +
      "This is a model/account quota limit, not an app failure.";

    const result = matchRetryableError(reason);
    assert.equal(result.retryable, true);
    assert.equal(result.patternName, "credits-exhausted");
    assert.ok(result.retryAt, "retryAt should be set");

    // Verify retryAt is ~5 minutes after the parsed reset time
    const retryDate = new Date(result.retryAt!);
    assert.ok(!isNaN(retryDate.getTime()), "retryAt should be valid ISO date");
  });

  it("should match 'rate limit reached' error", () => {
    const reason = "Claude rate limit reached (usage). Resets at 2026-03-20T10:00:00Z.";
    const result = matchRetryableError(reason);
    assert.equal(result.retryable, true);
    assert.equal(result.patternName, "credits-exhausted");
  });

  it("should match 'credits exhausted' error", () => {
    const reason = "Your credits exhausted for this billing period.";
    const result = matchRetryableError(reason);
    assert.equal(result.retryable, true);
    assert.equal(result.patternName, "credits-exhausted");
  });

  it("should return retryAt: null when no reset time is found", () => {
    const reason = "You've hit your limit. Please try again later.";
    const result = matchRetryableError(reason);
    assert.equal(result.retryable, true);
    assert.equal(result.retryAt, null);
  });

  it("should NOT match non-retryable errors", () => {
    const reason = "Session exited with code 1: TypeError: Cannot read property 'foo' of undefined";
    const result = matchRetryableError(reason);
    assert.equal(result.retryable, false);
    assert.equal(result.retryAt, null);
    assert.equal(result.patternName, "none");
  });

  it("should NOT match empty string", () => {
    const result = matchRetryableError("");
    assert.equal(result.retryable, false);
  });

  it("should parse ISO 8601 reset times", () => {
    const reason = "Rate limit reached. Resets at 2026-03-20T15:30:00Z.";
    const result = matchRetryableError(reason);
    assert.equal(result.retryable, true);
    assert.ok(result.retryAt);
    const retryDate = new Date(result.retryAt!);
    const expectedReset = new Date("2026-03-20T15:30:00Z");
    // retryAt should be 5 minutes after the reset
    const diffMs = retryDate.getTime() - expectedReset.getTime();
    assert.ok(diffMs >= 5 * 60 * 1000 - 1000, `Expected ~5 min buffer, got ${diffMs}ms`);
    assert.ok(diffMs <= 5 * 60 * 1000 + 1000, `Expected ~5 min buffer, got ${diffMs}ms`);
  });

  it("should handle malformed reset times gracefully", () => {
    const reason = "Rate limit reached. Resets at not-a-date.";
    const result = matchRetryableError(reason);
    assert.equal(result.retryable, true);
    assert.equal(result.retryAt, null, "Should fall back to null for unparseable dates");
  });
});
