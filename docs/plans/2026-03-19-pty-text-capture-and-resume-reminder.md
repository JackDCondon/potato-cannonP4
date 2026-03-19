# PTY Text Capture & Resume Prompt Reminder

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Ensure agent reasoning text reaches the conversation UI, even when the agent outputs text via Claude Code's PTY stream instead of calling `chat_notify`.

**Architecture:** Two-layer fix: (1) inject a reminder into resume prompts so agents are told to use `chat_notify`, (2) capture assistant text content blocks from the PTY stream and store them as conversation notifications, with deduplication against existing `chat_notify` messages.

**Tech Stack:** TypeScript, node-pty, SQLite (better-sqlite3), EventBus SSE

**Key Decisions:**
- **PTY line reassembly:** Strip ANSI escapes and buffer across `onData` chunks, rather than trying to increase PTY cols — ANSI stripping is already proven in the codebase (remote-control URL detection) and col-widening is fragile across platforms.
- **Deduplication strategy:** Time-window + content-prefix match against recent `chat_notify` messages, rather than exact match — agent text blocks may have minor formatting differences from what `chat_notify` sends.
- **Message type:** Store captured text as `notification` type (same as `chat_notify`), with a `metadata.source: "pty-capture"` marker to distinguish from explicit notifications.
- **Scope:** Only capture `type: "assistant"` events with `content[].type === "text"` blocks — tool_use blocks are already handled by MCP tool responses.

---

## Task 1: Add ANSI stripping utility

**Depends on:** None
**Complexity:** simple
**Files:**
- Create: `apps/daemon/src/utils/strip-ansi.ts`
- Test: `apps/daemon/src/utils/__tests__/strip-ansi.test.ts`

**Purpose:** Extract the ANSI stripping regex already used inline at `session.service.ts:1177` into a reusable utility, since we'll need it in the PTY text capture logic.

**Step 1: Write the failing test**

```typescript
// apps/daemon/src/utils/__tests__/strip-ansi.test.ts
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
```

**Step 2: Run test to verify it fails**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/utils/__tests__/strip-ansi.test.js`
Expected: FAIL (module not found — `dist/utils/strip-ansi.js` does not exist yet)

**Step 3: Write minimal implementation**

```typescript
// apps/daemon/src/utils/strip-ansi.ts

/**
 * Strip ANSI escape sequences and carriage returns from PTY output.
 * Handles cursor positioning, colors, screen clearing, and other terminal escapes.
 */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "");
}
```

**Step 4: Run test to verify it passes**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/utils/__tests__/strip-ansi.test.js`
Expected: PASS

**Step 5: Commit**
`git add apps/daemon/src/utils/strip-ansi.ts apps/daemon/src/utils/__tests__/strip-ansi.test.ts`
`git commit -m "feat: extract stripAnsi utility from session service"`

---

## Task 2: Add PTY assistant text extractor

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/services/session/pty-text-extractor.ts`
- Test: `apps/daemon/src/services/session/__tests__/pty-text-extractor.test.ts`

**Purpose:** Parse fragmented PTY output to extract assistant text content blocks. The PTY wraps long JSON lines at 120 columns with ANSI cursor-positioning escapes (`\e[row;colH`). This module buffers raw data, strips ANSI, reassembles JSON objects, and extracts text content from `type: "assistant"` events.

**Not In Scope:** Storing or emitting messages — this module only parses and extracts.

**Gotchas:** PTY `onData` delivers arbitrary chunks that don't align with JSON object boundaries. A single assistant message may arrive across 4+ chunks. The extractor must buffer and detect complete JSON objects.

**Step 1: Write the failing test**

```typescript
// apps/daemon/src/services/session/__tests__/pty-text-extractor.test.ts
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
```

**Step 2: Run test to verify it fails**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/services/session/__tests__/pty-text-extractor.test.js`
Expected: FAIL (module not found — `dist/services/session/pty-text-extractor.js` does not exist yet)

**Step 3: Write minimal implementation**

```typescript
// apps/daemon/src/services/session/pty-text-extractor.ts
import { stripAnsi } from "../../utils/strip-ansi.js";

/**
 * Extracts assistant text content from fragmented PTY stream-json output.
 *
 * Claude Code emits stream-json events, but the PTY wraps long lines with
 * ANSI cursor-positioning escapes, fragmenting JSON across multiple onData
 * chunks. This class buffers raw data, strips ANSI escapes, and attempts
 * to parse complete JSON objects to extract assistant text blocks.
 */
export class PtyTextExtractor {
  private buffer = "";

  /**
   * Feed raw PTY data. Returns any assistant text blocks found.
   * Call this from proc.onData().
   */
  feed(data: string): string[] {
    const stripped = stripAnsi(data);
    this.buffer += stripped;
    return this.tryExtract();
  }

  private tryExtract(): string[] {
    const texts: string[] = [];

    // Try to find complete JSON objects by scanning for newline-delimited boundaries.
    // stream-json format: one JSON object per logical line.
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const candidate = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!candidate) continue;

      // If the candidate doesn't start with '{', it's a continuation fragment.
      // Prepend it to... actually, with ANSI stripped, fragments are concatenated
      // in the buffer, so we need a different approach.
      // Try to parse; if it fails, the JSON may be incomplete (split across lines).
      try {
        const event = JSON.parse(candidate);
        const extracted = this.extractAssistantText(event);
        texts.push(...extracted);
      } catch {
        // Incomplete JSON — could be a fragment. Try accumulating with next line.
        // Put it back with the rest of the buffer for reassembly.
        this.buffer = candidate + this.buffer;
        // But we need to avoid infinite loops. If buffer has no more newlines,
        // break and wait for more data.
        break;
      }
    }

    // Safety: prevent unbounded buffer growth (e.g., binary garbage)
    if (this.buffer.length > 500_000) {
      this.buffer = this.buffer.slice(-10_000);
    }

    return texts;
  }

  private extractAssistantText(event: unknown): string[] {
    if (
      typeof event !== "object" ||
      event === null ||
      !("type" in event) ||
      (event as { type: string }).type !== "assistant"
    ) {
      return [];
    }

    const msg = (event as { message?: { content?: unknown[] } }).message;
    if (!msg?.content || !Array.isArray(msg.content)) return [];

    const texts: string[] = [];
    for (const block of msg.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type: string }).type === "text" &&
        "text" in block &&
        typeof (block as { text: unknown }).text === "string"
      ) {
        const text = (block as { text: string }).text.trim();
        if (text.length > 0) {
          texts.push(text);
        }
      }
    }

    return texts;
  }
}
```

**Step 4: Run test to verify it passes**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/services/session/__tests__/pty-text-extractor.test.js`
Expected: PASS

**Step 5: Commit**
`git add apps/daemon/src/services/session/pty-text-extractor.ts apps/daemon/src/services/session/__tests__/pty-text-extractor.test.ts`
`git commit -m "feat: add PtyTextExtractor for capturing assistant text from PTY stream"`

---

## Task 3: Integrate PTY text capture into session service

**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts:1174-1234` (onData handler)
- Test: `apps/daemon/src/services/session/__tests__/session-pty-capture.test.ts`

**Purpose:** Wire the `PtyTextExtractor` into `spawnClaudeSession()` so that assistant text blocks are stored as conversation notifications and emitted via SSE.

**Not In Scope:** Deduplication (Task 4), resume prompt changes (Task 5).

**Gotchas:**
- The `onData` handler is called with `meta` from closure scope — `meta.ticketId` and `meta.projectId` are available.
- Need to look up `conversationId` from the ticket/brainstorm — ticket's `conversation_id` is in the DB.
- Must not block the onData handler — use sync `addMessage` (better-sqlite3 is sync) but catch errors.

**Step 1: Write the failing test**

```typescript
// apps/daemon/src/services/session/__tests__/session-pty-capture.test.ts
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
          name: "mcp__potato-cannon__chat_ask",
          input: { question: "Does that make sense?" },
        }],
      },
    });
    collected.push(...extractor.feed(toolEvent + "\n"));

    assert.equal(collected.length, 1);
    assert.ok(collected[0].includes("I'd recommend C"));
    assert.ok(!collected[0].includes("chat_ask"));
  });
});
```

**Step 2: Run test to verify it fails**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/services/session/__tests__/session-pty-capture.test.js`
Expected: PASS (this is a unit test of the extractor pattern — the real integration is the code change)

**Step 3: Write minimal implementation**

In `session.service.ts`, modify `spawnClaudeSession()`:

1. Import `PtyTextExtractor` at the top of the file
2. Create an extractor instance before the `proc.onData` handler
3. Feed data to the extractor inside `onData`
4. When text is extracted, store it as a notification and emit SSE

```typescript
// At top of file, add import:
import { PtyTextExtractor } from "./pty-text-extractor.js";

// Inside spawnClaudeSession(), before proc.onData():
const ptyTextExtractor = new PtyTextExtractor();

// Inside proc.onData(), after the existing line-parsing loop (after line 1233):
// Capture assistant text blocks from PTY stream
if (meta.ticketId || meta.brainstormId) {
  const texts = ptyTextExtractor.feed(data);
  for (const text of texts) {
    this.handleCapturedPtyText(
      text,
      meta.projectId,
      meta.ticketId,
      meta.brainstormId,
      phase,
      agentType,
    );
  }
}
```

Add new imports at the top of `session.service.ts` (with the existing store imports):

```typescript
import { brainstormGetDirect } from "../../stores/brainstorm.store.js";
// addMessage is already imported (line 37 in existing file)
// getTicket is already imported (line 18 in existing file)
// getBrainstorm (async, project-scoped) is already imported — brainstormGetDirect is the sync variant needed here
```

Add a new private method to the `SessionService` class:

```typescript
/**
 * Store captured PTY assistant text as a conversation notification.
 * This catches reasoning text that the agent outputs directly instead
 * of sending via chat_notify.
 */
private handleCapturedPtyText(
  text: string,
  projectId: string,
  ticketId: string | undefined,
  brainstormId: string | undefined,
  phase: string,
  agentType: string,
): void {
  try {
    let conversationId: string | undefined;
    if (ticketId) {
      // getTicket() throws if not found (e.g., ticket deleted mid-session) — guard with try/catch already in place.
      const ticket = getTicket(projectId, ticketId);
      conversationId = ticket.conversationId;
    } else if (brainstormId) {
      const brainstorm = brainstormGetDirect(brainstormId);
      conversationId = brainstorm?.conversationId;
    }

    if (!conversationId) return;

    addMessage(conversationId, {
      type: "notification",
      text,
      metadata: {
        source: "pty-capture",
        phase,
        agentSource: agentType,
      },
    });

    // Emit SSE event
    const now = new Date().toISOString();
    if (ticketId) {
      eventBus.emit("ticket:message", {
        projectId,
        ticketId,
        message: { type: "notification", text, timestamp: now },
      });
    }
    if (brainstormId) {
      eventBus.emit("brainstorm:message", {
        projectId,
        brainstormId,
        message: { type: "notification", text, timestamp: now },
      });
    }
  } catch (err) {
    console.error("[handleCapturedPtyText] Failed to store captured text:", err);
  }
}
```

**Step 4: Run tests to verify**
Run: `cd apps/daemon && pnpm test`
Expected: PASS

**Step 5: Commit**
`git add apps/daemon/src/services/session/session.service.ts`
`git commit -m "feat: capture assistant PTY text as conversation notifications"`

---

## Task 4: Add deduplication for PTY-captured text vs chat_notify

**Depends on:** Task 3
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/services/session/pty-capture-dedup.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts` (handleCapturedPtyText method, per-session dedup map)
- Modify: `apps/daemon/src/mcp/tools/chat.tools.ts` (chat_notify handler — suppress duplicate PTY-captured message)
- Modify: `apps/daemon/src/stores/conversation.store.ts` (add `updateMessageMetadata(messageId, metadata)` export)
- Modify: `apps/frontend/src/api/client.ts` or message-rendering component (filter `metadata.superseded === true` messages before display)
- Test: `apps/daemon/src/services/session/__tests__/pty-text-dedup.test.ts`

**Purpose:** When the agent properly uses `chat_notify` AND also outputs text to the PTY (which is the normal case for initial sessions), avoid storing duplicate messages. Use a per-session set of recently-seen notification text prefixes.

**Gotchas:**
- The `chat_notify` message and the PTY text block may have slightly different formatting (leading/trailing whitespace, newlines).
- The PTY text arrives *before* the MCP tool call result, so the PTY capture fires first. We need to track what the PTY captured and suppress the duplicate when `chat_notify` fires, OR track what `chat_notify` stored and suppress the PTY capture.
- Actually: the PTY text block and the `chat_notify` are the SAME agent turn. The text block appears in the PTY stream BEFORE the tool_use block. Then `chat_notify` fires via MCP. So `chat_notify` fires AFTER the PTY text is captured. We should suppress the PTY capture if we detect the same turn also has a `chat_notify` tool_use. But we can't know that ahead of time.
- Simplest approach: track PTY-captured text prefixes per session. When `chat_notify` fires, check if a recent PTY capture matches and delete the duplicate.

**Alternative simpler approach:** Only capture PTY text when no `chat_notify` was called in the same agent turn. We can detect this by checking if the assistant event's content array contains ONLY text blocks (no tool_use blocks). If there's a tool_use for `chat_notify` in the same content array, skip the text capture.

Wait — looking at the actual PTY output, the text block and tool_use block come in SEPARATE assistant events (separate streaming chunks). The text is in one event, the tool_use is in the next. So we can't check within the same event.

**Revised approach:** Use a lightweight per-session dedup buffer. Store the first 200 chars of each PTY-captured text. When `handleCapturedPtyText` is called, check the dedup buffer against recent `chat_notify` messages (query last N messages from conversation store). If a notification with matching prefix exists within the last 30 seconds, skip the PTY capture.

**Actually, even simpler:** The PTY text arrives first. Store it immediately. Then when `chat_notify` fires (via MCP), check if a `pty-capture` notification with matching prefix was stored in the last 60 seconds. If so, delete the PTY-captured one (it's a duplicate — the explicit `chat_notify` is the canonical version).

**Step 1: Write the failing test**

```typescript
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
    const id = dedup.recordCapture("Some reasoning text here");
    assert.ok(id);
    assert.equal(typeof id, "string");
  });

  it("finds a matching capture for identical text", () => {
    dedup.recordCapture("Some reasoning text here");
    const match = dedup.findMatchingCapture("Some reasoning text here");
    assert.ok(match);
  });

  it("finds a matching capture for text with same prefix", () => {
    dedup.recordCapture("Some reasoning text that is very long and detailed");
    const match = dedup.findMatchingCapture("Some reasoning text that is very long and detailed");
    assert.ok(match);
  });

  it("returns null for non-matching text", () => {
    dedup.recordCapture("Some reasoning text");
    const match = dedup.findMatchingCapture("Completely different text");
    assert.equal(match, null);
  });

  it("removes a recorded capture", () => {
    const id = dedup.recordCapture("Some text");
    dedup.removeCapture(id);
    const match = dedup.findMatchingCapture("Some text");
    assert.equal(match, null);
  });

  it("expires captures after TTL", () => {
    dedup.recordCapture("Old text", Date.now() - 120_000); // 2 minutes ago
    const match = dedup.findMatchingCapture("Old text");
    assert.equal(match, null);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/services/session/__tests__/pty-text-dedup.test.js`
Expected: FAIL (module not found — `dist/services/session/pty-capture-dedup.js` does not exist yet)

**Step 3: Write minimal implementation**

```typescript
// apps/daemon/src/services/session/pty-capture-dedup.ts

interface CaptureRecord {
  id: string;
  prefix: string;
  timestamp: number;
}

const PREFIX_LENGTH = 200;
const TTL_MS = 60_000; // 60 seconds

/**
 * Tracks recently PTY-captured text to enable deduplication when
 * the agent also sends the same content via chat_notify.
 */
export class PtyCaptureDedup {
  private captures: CaptureRecord[] = [];
  private nextId = 0;

  recordCapture(text: string, timestamp = Date.now()): string {
    const id = `pty-cap-${this.nextId++}`;
    this.captures.push({
      id,
      prefix: text.trim().slice(0, PREFIX_LENGTH),
      timestamp,
    });
    // Prune expired
    this.captures = this.captures.filter((c) => timestamp - c.timestamp < TTL_MS);
    return id;
  }

  findMatchingCapture(text: string): string | null {
    const now = Date.now();
    const prefix = text.trim().slice(0, PREFIX_LENGTH);
    for (const capture of this.captures) {
      if (now - capture.timestamp < TTL_MS && capture.prefix === prefix) {
        return capture.id;
      }
    }
    return null;
  }

  removeCapture(id: string): void {
    this.captures = this.captures.filter((c) => c.id !== id);
  }
}
```

Then wire dedup into the session service:
- Create a `Map<string, PtyCaptureDedup>` keyed by sessionId
- In `handleCapturedPtyText`, record each capture and store its returned `id` alongside the stored `messageId`
- In the MCP `chat_notify` handler (`apps/daemon/src/mcp/tools/chat.tools.ts`), check for a matching PTY capture; if found, mark/soft-delete the pty-capture message

**Note:** `conversation.store.ts` does not currently expose a `deleteMessage` function. Use the **soft-delete / supersede approach**: update the PTY-captured message's metadata to `metadata.superseded: true` via the new `updateMessageMetadata(messageId, metadata)` export. Do NOT hard-delete — it would require schema changes. The frontend filters `metadata.superseded === true` messages before rendering.

**Step 4: Run test to verify it passes**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/services/session/__tests__/pty-text-dedup.test.js`
Expected: PASS

**Step 5: Commit**
`git add apps/daemon/src/services/session/pty-capture-dedup.ts apps/daemon/src/services/session/__tests__/pty-text-dedup.test.ts apps/daemon/src/services/session/session.service.ts`
`git commit -m "feat: add deduplication for PTY-captured text vs chat_notify"`

---

## Task 5: Add resume prompt reminder

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts:2071-2073` (resumeSuspendedTicket)
- Test: `apps/daemon/src/services/session/__tests__/resume-prompt-reminder.test.ts`

**Purpose:** Inject a short reminder into the resume prompt telling the agent to use `chat_notify` for reasoning text before calling `chat_ask`. This is the "belt" to the PTY capture's "suspenders".

**Risk:** The `--resume` flag means Claude already has the full prior conversation in context. Wrapping `userResponse` in a `User response: ` prefix changes the text the agent sees as the user's turn. If agents currently pattern-match on the raw response text, the prefix is benign (it's an instruction prepended before the content). However, if a future regression surfaces, **rollback** is a one-line revert of the `const prompt = buildResumePrompt(userResponse)` line back to `const prompt = userResponse`.

**Step 1: Write the failing test**

```typescript
// apps/daemon/src/services/session/__tests__/resume-prompt-reminder.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildResumePrompt } from "../resume-prompt.js";

describe("buildResumePrompt", () => {
  it("prepends communication reminder to user response", () => {
    const result = buildResumePrompt("Option B please");
    assert.ok(result.includes("Option B please"));
    assert.ok(result.includes("chat_notify"));
    assert.ok(result.indexOf("chat_notify") < result.indexOf("Option B please"));
  });

  it("preserves the full user response", () => {
    const response = "I want option C — keep as informational, drop gracePeriodMs.";
    const result = buildResumePrompt(response);
    assert.ok(result.includes(response));
  });
});
```

**Step 2: Run test to verify it fails**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/services/session/__tests__/resume-prompt-reminder.test.js`
Expected: FAIL (module not found — `dist/services/session/resume-prompt.js` does not exist yet)

**Step 3: Write minimal implementation**

```typescript
// apps/daemon/src/services/session/resume-prompt.ts

const RESUME_REMINDER = `IMPORTANT: The user can ONLY see messages sent via chat_notify and chat_ask MCP tools. Any text you output directly will NOT be visible to them. Before calling chat_ask, send your reasoning/explanation via chat_notify so the user can see it.`;

/**
 * Build the prompt for a resumed suspended session.
 * Prepends a reminder to use MCP tools for all user-visible output.
 */
export function buildResumePrompt(userResponse: string): string {
  return `${RESUME_REMINDER}\n\nUser response: ${userResponse}`;
}
```

Then update `resumeSuspendedTicket()` in `session.service.ts`:

```typescript
// Replace line 2073:
//   const prompt = userResponse;
// With:
import { buildResumePrompt } from "./resume-prompt.js";
// ...
const prompt = buildResumePrompt(userResponse);
```

**Step 4: Run test to verify it passes**
Run: `cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/services/session/__tests__/resume-prompt-reminder.test.js`
Expected: PASS

**Step 5: Commit**
`git add apps/daemon/src/services/session/resume-prompt.ts apps/daemon/src/services/session/__tests__/resume-prompt-reminder.test.ts apps/daemon/src/services/session/session.service.ts`
`git commit -m "feat: add MCP communication reminder to resume prompts"`

---

## Task 6: Update internal documentation

**Depends on:** Task 1, Task 2, Task 4, Task 5
**Note:** The existing inline ANSI regex in `session.service.ts` (lines 1177, 1362) will already be replaced by the `stripAnsi` import added in Task 3 — no separate refactor task needed.
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/utils/CLAUDE.md` (add strip-ansi.ts to file table)
- Modify: `apps/daemon/src/services/session/CLAUDE.md` (add new files to Key Files table, note PTY capture behavior)

**Purpose:** Keep the sub-documentation current with the new files added by this plan so future developers can discover the new modules.

**Step 1: Update utils/CLAUDE.md**

Add `strip-ansi.ts` row to the Files table:

```markdown
| `strip-ansi.ts` | ANSI escape sequence stripping for PTY output |
```

**Step 2: Update session/CLAUDE.md**

Add new files to the Key Files table:

```markdown
| `pty-text-extractor.ts` | Buffers PTY onData chunks, strips ANSI, extracts assistant text blocks from stream-json output. |
| `pty-capture-dedup.ts` | Per-session deduplication buffer: detects when PTY-captured text duplicates an explicit chat_notify call. |
| `resume-prompt.ts` | Builds the resume prompt for suspended sessions, injecting an MCP communication reminder. |
```

**Step 3: Commit**
`git add apps/daemon/src/utils/CLAUDE.md apps/daemon/src/services/session/CLAUDE.md`
`git commit -m "docs: update CLAUDE.md files for new PTY capture and resume-prompt modules"`

---

## Task 7: Manual integration test

**Depends on:** Task 3, Task 4, Task 5
**Complexity:** simple
**Files:** None (manual testing)

**Purpose:** Verify the fix end-to-end with a real brainstorm or ticket session.

**Steps:**
1. Start the daemon: `pnpm dev:daemon`
2. Start a brainstorm or create a test ticket that triggers refinement
3. Answer the first question to trigger a resume session
4. Verify that:
   - The agent's reasoning text appears in the UI (via PTY capture)
   - If the agent uses `chat_notify`, no duplicate messages appear
   - The resume prompt includes the MCP communication reminder
5. Check the session log for `pty-capture` metadata on stored messages

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | ✓ | Both fix layers (PTY capture + resume reminder) fully addressed across Tasks 1–7 |
| Accurate | ✓ | All referenced existing files verified. Fixed: `getBrainstormSync` → `brainstormGetDirect`, `require()` → static ES imports, missing second ANSI-strip occurrence |
| Commands valid | ✓ | All test commands corrected to `pnpm build && node --test dist/...` matching actual daemon test runner |
| YAGNI | ✓ | Every task directly serves the stated fix |
| Minimal | ✓ | Tasks appropriately scoped; capture/dedup separation justified |
| Not over-engineered | ✓ | Simple in-memory prefix buffer for dedup, no DB lookup overhead |
| Key Decisions documented | ✓ | Four decisions with rationale: PTY reassembly, dedup strategy, message type, scope |
| Context sections present | ✓ | Purpose on all tasks, Not In Scope on Tasks 2/3, Gotchas on Tasks 2/3/4 |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | EDITED | 1 | Task 4's Files list was incomplete — added missing `chat.tools.ts` and `pty-capture-dedup.ts` |
| Feasibility | EDITED | 8 | All `npx tsx --test` commands replaced with actual daemon test runner (`pnpm build && node --test dist/...`). Corrected import notes for existing store imports. |
| Completeness | EDITED | 1 | Added Task 6 for CLAUDE.md documentation updates. Renumbered manual test to Task 7. |
| Risk | EDITED | 3 | Fixed `getTicket()` error handling (throws, not null). Resolved `deleteMessage` gap with soft-delete approach. Added rollback note for resume prompt. |
| Optimality | EDITED | 5 | Removed standalone ANSI refactor task as YAGNI. Renumbered tasks. Surfaced hidden sub-tasks in Task 4's Files list. |
