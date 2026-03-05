import { describe, it } from "node:test";
import assert from "node:assert";

import { toSlackMrkdwn } from "../mrkdwn.js";

describe("toSlackMrkdwn", () => {
  it("should convert bold markdown to slack bold", () => {
    assert.strictEqual(toSlackMrkdwn("**hello**"), "*hello*");
  });

  it("should convert italic markdown to slack italic", () => {
    assert.strictEqual(toSlackMrkdwn("*hello*"), "_hello_");
  });

  it("should not convert bold to italic (collision avoidance)", () => {
    // This is the key test: **bold** should become *bold*, NOT _bold_
    assert.strictEqual(toSlackMrkdwn("**bold text**"), "*bold text*");
  });

  it("should handle mixed bold and italic in same string", () => {
    assert.strictEqual(
      toSlackMrkdwn("**bold** and *italic*"),
      "*bold* and _italic_",
    );
  });

  it("should convert markdown links to slack links", () => {
    assert.strictEqual(
      toSlackMrkdwn("[click here](https://example.com)"),
      "<https://example.com|click here>",
    );
  });

  it("should leave inline code unchanged", () => {
    assert.strictEqual(toSlackMrkdwn("`some code`"), "`some code`");
  });

  it("should handle plain text without changes", () => {
    assert.strictEqual(toSlackMrkdwn("no formatting"), "no formatting");
  });

  it("should handle multiple links in one string", () => {
    assert.strictEqual(
      toSlackMrkdwn("[a](https://a.com) and [b](https://b.com)"),
      "<https://a.com|a> and <https://b.com|b>",
    );
  });

  it("should handle bold, italic, code, and links together", () => {
    const input = "**Bold** and *italic* with `code` and [link](https://x.com)";
    const expected = "*Bold* and _italic_ with `code` and <https://x.com|link>";
    assert.strictEqual(toSlackMrkdwn(input), expected);
  });
});
