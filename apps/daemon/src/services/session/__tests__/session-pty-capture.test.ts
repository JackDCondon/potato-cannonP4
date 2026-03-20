import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PtyTextExtractor } from "../pty-text-extractor.js";

describe("PTY text capture integration", () => {
  it("extracts text that would otherwise be lost in raw PTY output", () => {
    // Simulate the exact pattern from the GAM-1 session log
    const extractor = new PtyTextExtractor();
    const collected: string[] = [];

    // Chunk 1: assistant message with text content, fragmented by PTY
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{
          type: "text",
          text: "Good question. Here's my take:\n\n**I'd recommend C.**\n\nThe reasoning is UX-focused.",
        }],
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    });

    // Feed the full event (simulating reassembled fragments)
    collected.push(...extractor.feed(assistantEvent + "\n"));

    // Chunk 2: tool_use event (should NOT produce text)
    const toolEvent = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "toolu_123",
          name: "mcp__potato-ticket__chat_ask",
          input: { question: "Does that make sense?" },
        }],
      },
    });
    collected.push(...extractor.feed(toolEvent + "\n"));

    assert.equal(collected.length, 1);
    assert.ok(collected[0].includes("I'd recommend C"));
    assert.ok(!collected[0].includes("chat_ask"));
  });

  it("handles ANSI-fragmented PTY chunks like a real terminal session", () => {
    const extractor = new PtyTextExtractor();

    const fullJson = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Reasoning across multiple PTY chunks" }],
      },
    });

    // Split into 40-char chunks with ANSI cursor-positioning between them
    const chunks: string[] = [];
    for (let i = 0; i < fullJson.length; i += 40) {
      const prefix = i === 0 ? "" : "\x1b[39;120H";
      chunks.push(prefix + fullJson.slice(i, i + 40) + "\r\n");
    }

    let allTexts: string[] = [];
    for (const chunk of chunks) {
      allTexts = allTexts.concat(extractor.feed(chunk));
    }

    assert.equal(allTexts.length, 1);
    assert.equal(allTexts[0], "Reasoning across multiple PTY chunks");
  });

  it("ignores non-assistant events (system, tool_result, etc.)", () => {
    const extractor = new PtyTextExtractor();

    const systemEvent = JSON.stringify({ type: "system", session_id: "abc123" });
    const resultEvent = JSON.stringify({ type: "tool_result", content: "ok" });

    const texts = [
      ...extractor.feed(systemEvent + "\n"),
      ...extractor.feed(resultEvent + "\n"),
    ];

    assert.equal(texts.length, 0);
  });

  it("skips empty text blocks and only returns non-empty strings", () => {
    const extractor = new PtyTextExtractor();

    const event = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "   \n   " },
          { type: "text", text: "Valid reasoning" },
        ],
      },
    });

    const texts = extractor.feed(event + "\n");
    assert.equal(texts.length, 1);
    assert.equal(texts[0], "Valid reasoning");
  });
});
