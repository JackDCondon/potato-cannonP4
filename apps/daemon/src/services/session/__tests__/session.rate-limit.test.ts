import { describe, it } from "node:test";
import assert from "node:assert";

import {
  extractRateLimitNotice,
  formatBlockedReasonWithRateLimit,
} from "../session.service.js";

describe("extractRateLimitNotice", () => {
  it("extracts rate-limit message from result events", () => {
    const notice = extractRateLimitNotice({
      type: "result",
      result: "You've hit your limit · resets Mar 13, 4pm (Australia/Sydney)",
    });

    assert.strictEqual(
      notice,
      "You've hit your limit · resets Mar 13, 4pm (Australia/Sydney)",
    );
  });

  it("builds fallback notice from rate_limit_event payload", () => {
    const notice = extractRateLimitNotice({
      type: "rate_limit_event",
      rate_limit_info: {
        rateLimitType: "seven_day_sonnet",
        resetsAt: 1773378000,
      },
    });

    assert.ok(notice);
    assert.match(notice!, /Claude rate limit reached \(seven_day_sonnet\)/);
    assert.match(notice!, /Resets at/);
  });

  it("returns null for unrelated events", () => {
    const notice = extractRateLimitNotice({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });

    assert.strictEqual(notice, null);
  });
});

describe("formatBlockedReasonWithRateLimit", () => {
  it("adds rate-limit notice and quota explanation on a new line", () => {
    const formatted = formatBlockedReasonWithRateLimit(
      'Agent "taskmaster-agent" failed with exit code 1',
      "Claude rate limit reached (seven_day_sonnet). Resets at 3/13/2026, 4:00:00 PM.",
    );

    assert.strictEqual(
      formatted,
      'Agent "taskmaster-agent" failed with exit code 1\nClaude rate limit reached (seven_day_sonnet). Resets at 3/13/2026, 4:00:00 PM.\nThis is a model/account quota limit, not an app failure.',
    );
  });

  it("normalizes inline rate-limit details into a separate line", () => {
    const formatted = formatBlockedReasonWithRateLimit(
      'Agent "taskmaster-agent" failed with exit code 1. Claude rate limit reached (seven_day_sonnet). Resets at 3/13/2026, 4:00:00 PM.',
      null,
    );

    assert.match(formatted, /failed with exit code 1\.\nClaude rate limit reached/);
    assert.match(formatted, /model\/account quota limit, not an app failure/);
  });
});
