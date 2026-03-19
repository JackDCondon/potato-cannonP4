// apps/daemon/src/services/session/__tests__/pty-text-dedup.test.ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PtyCaptureDedup } from "../pty-capture-dedup.js";

describe("PtyCaptureDedup", () => {
  let dedup: PtyCaptureDedup;

  beforeEach(() => {
    dedup = new PtyCaptureDedup();
  });

  it("records a PTY capture and returns its ID", () => {
    const id = dedup.recordCapture("Some reasoning text here", "msg-123");
    assert.ok(id);
    assert.equal(typeof id, "string");
  });

  it("finds a matching capture for identical text", () => {
    dedup.recordCapture("Some reasoning text here", "msg-123");
    const match = dedup.findMatchingCapture("Some reasoning text here");
    assert.ok(match);
    assert.equal(match, "msg-123");
  });

  it("finds a matching capture for text with same prefix", () => {
    const longText = "Some reasoning text that is very long and detailed";
    dedup.recordCapture(longText, "msg-456");
    const match = dedup.findMatchingCapture(longText);
    assert.ok(match);
    assert.equal(match, "msg-456");
  });

  it("returns null for non-matching text", () => {
    dedup.recordCapture("Some reasoning text", "msg-123");
    const match = dedup.findMatchingCapture("Completely different text");
    assert.equal(match, null);
  });

  it("removes a recorded capture by ID", () => {
    const id = dedup.recordCapture("Some text", "msg-789");
    dedup.removeCapture(id);
    const match = dedup.findMatchingCapture("Some text");
    assert.equal(match, null);
  });

  it("removes a recorded capture by messageId", () => {
    dedup.recordCapture("Some text", "msg-999");
    dedup.removeCaptureByMessageId("msg-999");
    const match = dedup.findMatchingCapture("Some text");
    assert.equal(match, null);
  });

  it("expires captures after TTL", () => {
    dedup.recordCapture("Old text", "msg-old", Date.now() - 120_000); // 2 minutes ago
    const match = dedup.findMatchingCapture("Old text");
    assert.equal(match, null);
  });

  it("trims whitespace when comparing text", () => {
    dedup.recordCapture("  Leading spaces  ", "msg-trim");
    const match = dedup.findMatchingCapture("Leading spaces");
    assert.ok(match, "Should match after trimming whitespace");
    assert.equal(match, "msg-trim");
  });

  it("handles multiple captures and returns the correct messageId", () => {
    dedup.recordCapture("First message", "msg-first");
    dedup.recordCapture("Second message", "msg-second");

    const matchFirst = dedup.findMatchingCapture("First message");
    const matchSecond = dedup.findMatchingCapture("Second message");

    assert.equal(matchFirst, "msg-first");
    assert.equal(matchSecond, "msg-second");
  });

  it("matches texts with different content after position 200 (PREFIX_LENGTH boundary)", () => {
    // Build a 200-char prefix (exactly at the boundary)
    const prefix = "A".repeat(200);
    // Two texts that share the same 200-char prefix but differ after position 200
    const textA = prefix + " --- suffix A that is unique to this message";
    const textB = prefix + " --- suffix B that is completely different from A";

    assert.ok(textA.length > 200, "textA must be longer than PREFIX_LENGTH");
    assert.ok(textB.length > 200, "textB must be longer than PREFIX_LENGTH");

    dedup.recordCapture(textA, "msg-boundary");

    // textB differs after position 200 but shares the same prefix → should match
    const match = dedup.findMatchingCapture(textB);
    assert.equal(
      match,
      "msg-boundary",
      "Two texts with identical 200-char prefix should match regardless of content after position 200",
    );
  });
});
