# Taskmaster Performance: `body_from` Artifact Resolution

**Date:** 2026-03-17
**Status:** Design

## Problem

The taskmaster agent is slow because it regenerates spec content token-by-token through Claude's output stream. For each task, the LLM copies hundreds of lines of JSON schemas verbatim as `create_task` tool arguments. With 7+ tasks, that's thousands of output tokens generated sequentially — the bottleneck is output token generation, not the daemon or MCP.

The fundamental issue: the taskmaster is a copy-paste machine being run through an LLM. It reads a spec artifact, then parrots the content back through the output stream into individual `create_task` calls. The artifact already lives on disk in the daemon's file system.

## Solution

Add an optional `body_from` field to the `create_task` MCP tool. Instead of the agent outputting the full task body, it provides a reference to an artifact and markers — the daemon resolves the content server-side.

**Before** (agent outputs ~500 tokens per task):
```json
{
  "description": "Ticket 3: Protocol Message Types",
  "body": "### Ticket 3: Protocol Message Types\n\nImplement the following...\n```json\n{ huge schema... }\n```\n...(hundreds of lines)..."
}
```

**After** (agent outputs ~50 tokens per task):
```json
{
  "description": "Ticket 3: Protocol Message Types",
  "body_from": {
    "artifact": "specification.md",
    "start_marker": "### Ticket 3: Protocol Message Types",
    "end_marker": "### Ticket 4: Server Implementation"
  }
}
```

## Design

### The `body_from` Contract

The `create_task` MCP tool gets one new optional field:

```typescript
create_task({
  description: string;
  body?: string;
  complexity?: string;
  // New field
  body_from?: {
    artifact: string;      // artifact filename, e.g. "specification.md"
    start_marker: string;  // literal string to find
    end_marker?: string;   // if omitted, extract to end of file
  };
})
```

### Resolution Rules

1. If `body_from` is present, resolve it — read the artifact file, find `start_marker`, extract to `end_marker` (or EOF). Use the result as `body`.
2. If `body_from` is present AND `body` is also present, `body_from` wins (ignore `body`).
3. If `body_from` resolution fails (artifact missing, marker not found), return a tool error with a descriptive message. Do not create the task.
4. If neither `body_from` nor `body` is present, create the task with no body (existing behavior).

### Marker Extraction Logic

```
function extractSection(content, startMarker, endMarker?):
  1. Find index of startMarker in content
  2. If not found -> error: "Start marker not found: {startMarker}"
  3. Extract from startMarker position to:
     - If endMarker provided: find endMarker index after startMarker
       - If not found -> error: "End marker not found: {endMarker}"
       - Extract from startMarker to endMarker (exclusive)
     - If no endMarker: extract from startMarker to EOF
  4. Trim trailing whitespace, return result
```

**Key decisions:**
- Extracted content **includes** the start marker line (useful context for the builder)
- Extracted content **excludes** the end marker line (it belongs to the next task)
- Uses **first occurrence** of each marker — if a spec has duplicate headers, the agent must use more specific markers
- Literal string matching (no regex) — predictable, easy to debug, agent knows exact strings since it just read the artifact

### Error Messages

Clear, actionable errors returned to the agent:
- `"Artifact 'specification.md' not found for this ticket"`
- `"Start marker '### Ticket 9:' not found in artifact 'specification.md'"`
- `"End marker '### Ticket 10:' not found after start marker in artifact 'specification.md'"`

The agent can then fall back to providing `body` directly.

## Implementation Scope

### Daemon Changes (3 files)

1. **`apps/daemon/src/mcp/tools/task.tools.ts`** — Add `body_from` to the tool's input schema. Before calling the task creation API, resolve `body_from` if present: read artifact from disk, extract content between markers, pass result as `body` to the existing route.

2. **`apps/daemon/src/stores/artifact.store.ts`** (or artifact reading utility) — Reuse existing artifact file reading path from `get_artifact` MCP tool to read artifact content by filename for a given ticket.

3. **`packages/shared/src/types/`** — Add `BodyFrom` type to shared types.

### Agent Prompt Changes (1 file)

4. **`apps/daemon/templates/workflows/product-development/agents/taskmaster.md`** — Update to use `body_from` when specification.md exists. Fall back to direct `body` when no spec is available.

### No Changes To

- Task store / database schema
- Task routes (resolution happens at MCP tool layer before route is called)
- Task-loop execution
- Builder agents
- Workflow schema / templates
- Frontend

### Test Coverage

- `body_from` resolves correctly (happy path)
- `body_from` with no `end_marker` extracts to EOF
- `body_from` fails on missing artifact (error returned)
- `body_from` fails on missing start marker (error returned)
- `body_from` fails on missing end marker (error returned)
- `body_from` + `body` both present — `body_from` wins
- Existing `body`-only path unchanged (regression)

## Design Principles

- **Backward compatible**: Existing `body` field works identically. No workflow template or schema changes required.
- **Workflow agnostic**: The daemon has no knowledge of "taskmaster" or spec structure. Any agent in any workflow can use `body_from` with any artifact.
- **Fail loud**: Bad references produce clear errors. The agent decides how to recover.
- **Agent decides**: The agent chooses whether to use `body_from` or `body`. The daemon just resolves references.

## Expected Impact

For a spec with 7 tickets averaging 200 lines each:
- **Before**: ~3,500 lines of output tokens (7 x 500 tokens avg) generated sequentially
- **After**: ~350 tokens total (7 x 50 tokens for title + markers)
- **~10x reduction** in output tokens for task creation
