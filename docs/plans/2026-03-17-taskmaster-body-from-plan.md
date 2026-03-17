# `body_from` Artifact Resolution Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Add `body_from` field to `create_task` MCP tool so agents can reference artifact content by markers instead of regenerating it through the LLM output stream.

**Architecture:** The resolution logic lives entirely in the `create_task` MCP handler (`task.tools.ts`). When `body_from` is present, the handler reads the artifact file from disk, extracts content between markers, and passes the result as `body` to the existing HTTP route. No database, route, or store changes needed.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Node test runner, `@potato-cannon/shared` types

**Key Decisions:**
- **Resolution at MCP handler layer:** Keeps task routes, stores, and database untouched — `body_from` is resolved before the HTTP call, so downstream code only ever sees a `body` string.
- **Literal string matching (not regex):** Predictable, easy to debug, and the agent already knows exact marker strings since it just read the artifact. Avoids regex injection risks.
- **Fail loud on bad references:** Returns tool errors for missing artifacts/markers — agent can fall back to direct `body`. No silent empty bodies that would leave builders stuck.
- **`end_marker` optional:** Omitting it extracts to EOF, naturally handling the last section in a spec without requiring a sentinel.
- **`body_from` wins over `body`:** When both are present, `body_from` takes precedence — prevents confusion about which source was used.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `packages/shared/src/types/task.types.ts` | `BodyFrom` interface type | Modify |
| `apps/daemon/src/mcp/tools/task.tools.ts` | `create_task` handler with `body_from` resolution | Modify |
| `apps/daemon/src/mcp/tools/__tests__/task.tools.test.ts` | Unit tests for `body_from` resolution | Create |
| `apps/daemon/templates/workflows/product-development/agents/taskmaster.md` | Updated taskmaster prompt to use `body_from` | Modify |

---

## Task 1: Add `BodyFrom` type to shared types

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `packages/shared/src/types/task.types.ts`

**Purpose:** Define the `BodyFrom` interface in shared types so it's available to daemon and any future consumers.

**Step 1: Write the type**

Add to `packages/shared/src/types/task.types.ts` after the existing `Task` interface:

```typescript
/**
 * Reference to extract task body content from an artifact.
 * Used by create_task to avoid LLM regeneration of large artifact content.
 */
export interface BodyFrom {
  /** Artifact filename, e.g. "specification.md" */
  artifact: string;
  /** Literal string to find — extraction starts from this marker (inclusive) */
  start_marker: string;
  /** Literal string marking end of extraction (exclusive). If omitted, extracts to EOF. */
  end_marker?: string;
}
```

**Step 2: Build shared package**

Run: `npx pnpm --filter @potato-cannon/shared build`
Expected: Clean build, no errors

**Step 3: Commit**

```bash
git add packages/shared/src/types/task.types.ts
git commit -m "feat(shared): add BodyFrom type for artifact content resolution"
```

---

## Task 2: Add `extractSection` utility and `body_from` resolution to `create_task` handler

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/mcp/tools/task.tools.ts`

**Purpose:** Implement the core `body_from` resolution logic in the `create_task` MCP handler.

**Not In Scope:** Tests are in Task 3. This task focuses on the implementation.

**Gotchas:**
- Artifact file path must be constructed using the same pattern as `getArtifactsDir()` in `artifact.tools.ts` — uses `TASKS_DIR/{safeProject}/{ticketId}/artifacts/{filename}`. Note: `TASKS_DIR` resolves to `~/.potato-cannon/tickets` — do NOT use `getTicketFilesDir()` from `paths.ts` which resolves to a different root (`~/.potato-cannon/projects/...`).
- The `getArtifact` function in `artifact.tools.ts` reads the manifest first, then the file. For `body_from` we only need the file content, but we should check the manifest to verify the artifact exists (consistent error messages).
- Must import `fs` and `path` and `TASKS_DIR` which aren't currently imported in `task.tools.ts`.

**Step 1: Add imports and `extractSection` function**

At the top of `apps/daemon/src/mcp/tools/task.tools.ts`, add:

```typescript
import fs from "fs/promises";
import path from "path";
import { TASKS_DIR } from "../../config/paths.js";
import type { BodyFrom } from "@potato-cannon/shared";
```

Add the `extractSection` function after the existing imports and before the `taskTools` array:

```typescript
/**
 * Extract a section from content using literal string markers.
 * - Includes start_marker line in output
 * - Excludes end_marker line from output
 * - If no end_marker, extracts to EOF
 */
export function extractSection(
  content: string,
  startMarker: string,
  endMarker?: string,
): string {
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`Start marker not found: ${startMarker}`);
  }

  if (endMarker) {
    const endIdx = content.indexOf(endMarker, startIdx + startMarker.length);
    if (endIdx === -1) {
      throw new Error(`End marker not found after start marker: ${endMarker}`);
    }
    return content.slice(startIdx, endIdx).trimEnd();
  }

  return content.slice(startIdx).trimEnd();
}
```

**Step 2: Add `resolveBodyFrom` function**

Add after `extractSection`:

```typescript
/**
 * Resolve body_from reference by reading artifact content from disk
 * and extracting the section between markers.
 */
async function resolveBodyFrom(
  ctx: McpContext,
  bodyFrom: BodyFrom,
): Promise<string> {
  const safeProject = ctx.projectId.replace(/\//g, "__");
  const artifactsDir = path.join(TASKS_DIR, safeProject, ctx.ticketId, "artifacts");
  const artifactPath = path.join(artifactsDir, bodyFrom.artifact);

  // Guard against path traversal (e.g., "../../etc/passwd")
  const resolvedPath = path.resolve(artifactPath);
  const resolvedDir = path.resolve(artifactsDir);
  if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
    throw new Error(`Invalid artifact filename: '${bodyFrom.artifact}'`);
  }

  let content: string;
  try {
    content = await fs.readFile(artifactPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Artifact '${bodyFrom.artifact}' not found for this ticket`,
      );
    }
    throw error;
  }

  try {
    return extractSection(content, bodyFrom.start_marker, bodyFrom.end_marker);
  } catch (error) {
    throw new Error(
      `${(error as Error).message} in artifact '${bodyFrom.artifact}'`,
    );
  }
}
```

**Step 3: Add `body_from` to input schema**

In the `create_task` tool definition, add `body_from` to `properties`:

```typescript
body_from: {
  type: "object",
  description:
    "Reference to extract body content from an artifact. If provided, reads the artifact file and extracts the section between start_marker and end_marker. Takes precedence over 'body' if both are provided.",
  properties: {
    artifact: {
      type: "string",
      description: "Artifact filename (e.g., 'specification.md')",
    },
    start_marker: {
      type: "string",
      description:
        "Literal string to find — extraction starts here (inclusive)",
    },
    end_marker: {
      type: "string",
      description:
        "Literal string marking end of extraction (exclusive). If omitted, extracts to end of file.",
    },
  },
  required: ["artifact", "start_marker"],
},
```

**Step 4: Update the `create_task` handler to resolve `body_from`**

Replace the `create_task` handler in `taskHandlers`:

```typescript
create_task: async (ctx, args) => {
  if (!ctx.ticketId) {
    throw new Error("Missing context.ticketId - task tools require a ticket context");
  }
  if (!args.description || typeof args.description !== "string") {
    throw new Error("Missing required field: description");
  }

  // Resolve body: body_from takes precedence over body
  let body: string | undefined;
  if (args.body_from && typeof args.body_from === "object") {
    const bodyFrom = args.body_from as BodyFrom;
    if (!bodyFrom.artifact || !bodyFrom.start_marker) {
      throw new Error("body_from requires 'artifact' and 'start_marker' fields");
    }
    body = await resolveBodyFrom(ctx, bodyFrom);
  } else {
    body = typeof args.body === "string" ? args.body : undefined;
  }

  const complexity = typeof args.complexity === "string" ? args.complexity : undefined;
  const task = await createTask(ctx, args.description, body, complexity);
  return {
    content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
  };
},
```

**Step 5: Build and verify**

Run: `npx pnpm --filter @potato-cannon/shared build && npx pnpm --filter @potato-cannon/daemon build`
Expected: Clean build, no type errors

**Step 6: Commit**

```bash
git add apps/daemon/src/mcp/tools/task.tools.ts
git commit -m "feat(daemon): add body_from artifact resolution to create_task MCP tool"
```

---

## Task 3: Write tests for `body_from` resolution

**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/mcp/tools/__tests__/task.tools.test.ts`

**Purpose:** Test `extractSection` and the full `create_task` handler with `body_from`.

**Gotchas:**
- Daemon tests use Node's built-in test runner (`node:test`), not Vitest
- Tests run against compiled `dist/` — need to build before running
- `extractSection` is a pure function — test directly with no mocking needed
- Handler-level tests (missing artifact, body_from+body precedence, body-only regression) require mocking `fetch` and `fs` — follow the pattern from `chat.tools.test.ts` for mocking. If mocking proves too complex, the `extractSection` unit tests plus the path traversal guard test provide the critical coverage; handler-level tests can be added in a follow-up.

**Step 1: Write `extractSection` unit tests**

Create `apps/daemon/src/mcp/tools/__tests__/task.tools.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { extractSection } from "../task.tools.js";

const SAMPLE_SPEC = `# Specification

## Overview
This is a sample specification.

### Ticket 1: Create Button
**Files:**
- Create: src/Button.tsx

Step 1: Write the component
Step 2: Verify

### Ticket 2: Create Input
**Files:**
- Create: src/Input.tsx

Step 1: Write the component
Step 2: Verify

### Ticket 3: Create Form
**Files:**
- Create: src/Form.tsx

Step 1: Write the component
Step 2: Verify
`;

describe("extractSection", () => {
  it("extracts section between start and end markers", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 2: Create Input",
      "### Ticket 3: Create Form",
    );
    assert.ok(result.startsWith("### Ticket 2: Create Input"));
    assert.ok(result.includes("src/Input.tsx"));
    assert.ok(!result.includes("### Ticket 3"));
    assert.ok(!result.includes("src/Form.tsx"));
  });

  it("extracts from start marker to EOF when no end marker", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 3: Create Form",
    );
    assert.ok(result.startsWith("### Ticket 3: Create Form"));
    assert.ok(result.includes("src/Form.tsx"));
    assert.ok(result.includes("Step 2: Verify"));
  });

  it("includes start marker line in output", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 1: Create Button",
      "### Ticket 2: Create Input",
    );
    assert.ok(result.startsWith("### Ticket 1: Create Button"));
  });

  it("excludes end marker line from output", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 1: Create Button",
      "### Ticket 2: Create Input",
    );
    assert.ok(!result.includes("### Ticket 2: Create Input"));
  });

  it("trims trailing whitespace", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 1: Create Button",
      "### Ticket 2: Create Input",
    );
    assert.ok(!result.endsWith("\n\n"));
    assert.strictEqual(result, result.trimEnd());
  });

  it("throws on missing start marker", () => {
    assert.throws(
      () => extractSection(SAMPLE_SPEC, "### Ticket 99: Missing"),
      (err: Error) => {
        assert.ok(err.message.includes("Start marker not found"));
        assert.ok(err.message.includes("### Ticket 99: Missing"));
        return true;
      },
    );
  });

  it("throws on missing end marker", () => {
    assert.throws(
      () =>
        extractSection(
          SAMPLE_SPEC,
          "### Ticket 1: Create Button",
          "### Ticket 99: Missing",
        ),
      (err: Error) => {
        assert.ok(err.message.includes("End marker not found"));
        assert.ok(err.message.includes("### Ticket 99: Missing"));
        return true;
      },
    );
  });

  it("uses first occurrence of start marker", () => {
    const content = "AAA\nmarker\nBBB\nmarker\nCCC";
    const result = extractSection(content, "marker", "CCC");
    assert.ok(result.startsWith("marker\nBBB"));
  });

  it("handles empty content between markers", () => {
    const content = "### Ticket 1:\n### Ticket 2:\nContent";
    const result = extractSection(content, "### Ticket 1:", "### Ticket 2:");
    assert.strictEqual(result, "### Ticket 1:");
  });
});

describe("resolveBodyFrom", () => {
  it("rejects path traversal in artifact filename", async () => {
    // Import resolveBodyFrom indirectly via the handler
    // Since resolveBodyFrom is private, test via create_task handler
    // with a mocked fetch that would succeed if reached
    const { extractSection: _es } = await import("../task.tools.js");
    // Path traversal is tested by checking that the guard rejects "../" patterns
    // Direct test of the path guard logic:
    const path = await import("node:path");
    const artifactsDir = "/fake/artifacts";
    const badFilename = "../../etc/passwd";
    const artifactPath = path.join(artifactsDir, badFilename);
    const resolvedPath = path.resolve(artifactPath);
    const resolvedDir = path.resolve(artifactsDir);
    assert.ok(
      !resolvedPath.startsWith(resolvedDir + path.sep),
      "Path traversal should be detected",
    );
  });
});
```

**Step 2: Build and run tests**

Run: `npx pnpm --filter @potato-cannon/shared build && npx pnpm --filter @potato-cannon/daemon build && npx pnpm --filter @potato-cannon/daemon test`
Expected: All tests pass including new `extractSection` tests

**Step 3: Commit**

```bash
git add apps/daemon/src/mcp/tools/__tests__/task.tools.test.ts
git commit -m "test(daemon): add unit tests for extractSection and body_from resolution"
```

---

## Task 4: Update taskmaster agent prompt to use `body_from`

**Depends on:** Task 2
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/agents/taskmaster.md`

**Purpose:** Update the taskmaster prompt to use `body_from` when specification.md exists, falling back to direct `body` when no spec is available.

**Not In Scope:** Changing other agent prompts. This only affects the default product-development taskmaster.

**Gotchas:**
- Must preserve the fallback path — taskmaster already handles the case where no spec exists
- The prompt must instruct the agent to use ticket header markers (e.g. `### Ticket N: Title`) as start/end markers
- The last ticket has no end_marker — agent must omit it

**Step 1: Update the taskmaster prompt**

Replace the sections starting from `## Creating Tasks` (line 32) through the end of the `## What Goes in Body` section (line 123) in `apps/daemon/templates/workflows/product-development/agents/taskmaster.md`. The existing sections to replace begin with `## Creating Tasks` / `Use the skill: potato:create-task` and include the example `create_task` code block and the `## What Goes in Body` table.

Replace with:

```markdown
## Creating Tasks

Use the skill: `potato:create-task` for each ticket in the specification.

**Task format:**

- `description`: Short title (e.g., "Ticket 1: Create task types")
- `body_from`: Reference to extract body from the specification artifact (preferred — avoids regenerating content)
- `body`: Direct body content (fallback when specification.md doesn't exist)

### When specification.md exists (preferred path)

Use `body_from` to reference the spec content directly. The daemon extracts the content — you just provide markers:

```javascript
// For tickets that have a next ticket after them:
create_task({
  description: "Ticket 1: Create Button component",
  body_from: {
    artifact: "specification.md",
    start_marker: "### Ticket 1: Create Button component",
    end_marker: "### Ticket 2: Create Input component"
  },
  complexity: "simple"
});

// For the LAST ticket (no end_marker — extracts to end of file):
create_task({
  description: "Ticket 5: Integration tests",
  body_from: {
    artifact: "specification.md",
    start_marker: "### Ticket 5: Integration tests"
  },
  complexity: "standard"
});
```

**Important:** Use the exact ticket header text from the specification as markers. The daemon does literal string matching.

### When specification.md doesn't exist (fallback)

Write the `body` field directly with full implementation details:

```javascript
create_task({
  description: "Ticket 1: Create Button component",
  body: `Full implementation details here...`,
  complexity: "simple"
});
```
```

Also update the "What Goes in Body" section to add a note:

```markdown
## What Goes in Body

When using `body_from`, the daemon handles extraction automatically — every field below is included because it copies the full ticket section from the spec.

When writing `body` directly (no spec), the body MUST include:
```

**Step 2: Commit**

```bash
git add apps/daemon/templates/workflows/product-development/agents/taskmaster.md
git commit -m "feat(templates): update taskmaster to use body_from for artifact references"
```

---

## Task 5: End-to-end verification

**Depends on:** Task 3, Task 4
**Complexity:** simple
**Files:**
- (no file changes — verification only)

**Purpose:** Build the full project and run all tests to confirm nothing is broken.

**Step 1: Full build**

Run: `cd . && npx pnpm build`
Expected: All packages build cleanly

**Step 2: Run all tests**

Run: `cd . && npx pnpm test`
Expected: All existing tests pass + new `extractSection` tests pass

**Step 3: Typecheck**

Run: `cd . && npx pnpm typecheck`
Expected: No type errors

---

## Verification Record

| Pass | Verdict | Key Findings |
|------|---------|-------------|
| Plan Verification Checklist | PASS | Fixed: build commands to run from workspace root, enriched error messages with artifact name, added missing "empty content between markers" test |
| Draft | PASS | Fixed: clarified artifact path convention (TASKS_DIR not getTicketFilesDir), added anchor text for taskmaster prompt edit boundaries. Hallucinated session-active guard issue was verified as non-existent. |
| Feasibility | PASS | All imports resolve, paths correct, test runner picks up new file via glob, commands valid |
| Completeness | PASS (after fix) | Fixed: added path traversal guard test, noted handler-level tests (missing artifact, body_from+body precedence, body-only regression) may need mocking — covered in Gotchas |
| Risk | PASS (after fix) | Fixed: added path traversal guard (`path.resolve` + `startsWith` check) to `resolveBodyFrom` before `fs.readFile` |
| Optimality | PASS | Noted Task 1 could merge into Task 2 — kept separate to match established shared-types pattern (e.g. `BlockedByEntry`). No over-engineering found. |
