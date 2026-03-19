import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PtyTextExtractor } from "../pty-text-extractor.js";

describe("PtyTextExtractor", () => {
  let extractor: PtyTextExtractor;

  beforeEach(() => {
    extractor = new PtyTextExtractor();
  });

  it("extracts text from a complete assistant message on one line", () => {
    const event = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    });
    const texts = extractor.feed(event + "\n");
    assert.deepEqual(texts, ["Hello world"]);
  });

  it("extracts text from assistant message split across multiple chunks", () => {
    const event = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Split message" }],
      },
    });
    // Simulate PTY fragmentation with ANSI cursor positioning
    const half = Math.floor(event.length / 2);
    const chunk1 = event.slice(0, half) + "\r\n";
    const chunk2 = "\x1b[39;120H" + event.slice(half) + "\r\n";

    const texts1 = extractor.feed(chunk1);
    assert.deepEqual(texts1, []);

    const texts2 = extractor.feed(chunk2);
    assert.deepEqual(texts2, ["Split message"]);
  });

  it("ignores tool_use content blocks", () => {
    const event = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Some reasoning" },
          { type: "tool_use", id: "tool1", name: "chat_ask", input: {} },
        ],
      },
    });
    const texts = extractor.feed(event + "\n");
    assert.deepEqual(texts, ["Some reasoning"]);
  });

  it("ignores non-assistant events", () => {
    const event = JSON.stringify({ type: "system", session_id: "abc" });
    const texts = extractor.feed(event + "\n");
    assert.deepEqual(texts, []);
  });

  it("ignores non-JSON data", () => {
    const texts = extractor.feed("some raw output\n");
    assert.deepEqual(texts, []);
  });

  it("skips empty or whitespace-only text blocks", () => {
    const event = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "  \n  " }],
      },
    });
    const texts = extractor.feed(event + "\n");
    assert.deepEqual(texts, []);
  });

  it("handles multiple assistant events in one chunk", () => {
    const event1 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "First" }] },
    });
    const event2 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Second" }] },
    });
    const texts = extractor.feed(event1 + "\n" + event2 + "\n");
    assert.deepEqual(texts, ["First", "Second"]);
  });

  it("handles ANSI-heavy fragmentation like real PTY output", () => {
    // Simulate the actual pattern from the session log:
    // Line 1: start of JSON + truncated at col 120
    // Lines 2-4: \e[row;colH + continuation
    const fullJson = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Real PTY reasoning text" }],
        model: "claude-opus-4-6",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });

    // Split into 50-char chunks with ANSI between them
    const chunks: string[] = [];
    for (let i = 0; i < fullJson.length; i += 50) {
      const prefix = i === 0 ? "" : "\x1b[39;120H";
      chunks.push(prefix + fullJson.slice(i, i + 50) + "\r\n");
    }

    let allTexts: string[] = [];
    for (const chunk of chunks) {
      allTexts = allTexts.concat(extractor.feed(chunk));
    }
    assert.deepEqual(allTexts, ["Real PTY reasoning text"]);
  });
});
