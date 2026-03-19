import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../strip-ansi.js";

describe("stripAnsi", () => {
  it("removes cursor positioning escapes", () => {
    const input = '\x1b[39;120Hsome text here';
    assert.equal(stripAnsi(input), "some text here");
  });

  it("removes color codes", () => {
    const input = '\x1b[31mred text\x1b[0m';
    assert.equal(stripAnsi(input), "red text");
  });

  it("removes screen clear sequences", () => {
    const input = '\x1b[2J\x1b[H\x1b[?25hcontent';
    assert.equal(stripAnsi(input), "content");
  });

  it("passes through plain text unchanged", () => {
    assert.equal(stripAnsi("hello world"), "hello world");
  });

  it("handles empty string", () => {
    assert.equal(stripAnsi(""), "");
  });

  it("strips carriage returns", () => {
    const input = "some text\r";
    assert.equal(stripAnsi(input), "some text");
  });
});
