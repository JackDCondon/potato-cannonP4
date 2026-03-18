import { describe, it } from "node:test";
import assert from "node:assert";
import { extractDescriptionPrefix } from "../task.tools.js";

describe("extractDescriptionPrefix", () => {
  it("extracts prefix up to first colon", () => {
    assert.strictEqual(
      extractDescriptionPrefix("Ticket 1: Create Button component"),
      "ticket 1"
    );
  });

  it("normalizes whitespace and case", () => {
    assert.strictEqual(
      extractDescriptionPrefix("  Ticket 1:  Create Button  "),
      "ticket 1"
    );
  });

  it("returns full description when no colon present", () => {
    assert.strictEqual(
      extractDescriptionPrefix("Create Button component"),
      "create button component"
    );
  });

  it("handles empty string", () => {
    assert.strictEqual(extractDescriptionPrefix(""), "");
  });

  it("matches different suffixes with same prefix", () => {
    const a = extractDescriptionPrefix("Ticket 1: Create Button component");
    const b = extractDescriptionPrefix("Ticket 1: Create button Component v2");
    assert.strictEqual(a, b);
  });

  it("does not match different ticket numbers", () => {
    const a = extractDescriptionPrefix("Ticket 1: Create Button");
    const b = extractDescriptionPrefix("Ticket 2: Create Button");
    assert.notStrictEqual(a, b);
  });
});
