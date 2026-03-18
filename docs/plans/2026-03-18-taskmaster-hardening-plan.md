# Taskmaster Hardening Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Harden the taskmaster agent and surrounding infrastructure to prevent duplicate task creation, enforce `body_from` usage, handle re-entry gracefully, and block silent task-loop skipping.

**Architecture:** Four changes across two layers: prompt-level guidance in `taskmaster.md` (re-entry awareness + `body_from` enforcement) and code-level guards in `task.tools.ts` (duplicate detection) and `worker-executor.ts` (empty task-loop blocking). No schema changes, no new tables, no new MCP tools.

**Tech Stack:** TypeScript (Node.js), SQLite (better-sqlite3), MCP tool handlers, agent prompt markdown

**Key Decisions:**
- **Duplicate detection strategy:** Normalize and compare description prefix up to first colon (e.g., "Ticket 1:") rather than full-string match -- handles Claude rewording titles across sessions while avoiding false positives
- **Task-loop guard behavior:** Block the ticket (hard stop) rather than asking the user -- the worker-executor has no interactive capability, and silent skipping is always wrong
- **`body_from` enforcement level:** MCP nudge (warning) rather than rejection -- there are legitimate edge cases where markers don't match cleanly, and hard rejection would break those
- **Re-entry as prompt guidance:** Handled entirely in the agent prompt rather than daemon code -- workflow templates can only use agents, not subroutines
---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `apps/daemon/templates/workflows/product-development/agents/taskmaster.md` | Taskmaster agent prompt with re-entry + body_from hardening | Modify |
| `apps/daemon/src/mcp/tools/task.tools.ts` | MCP tool handlers for task CRUD | Modify |
| `apps/daemon/src/mcp/tools/__tests__/task-dedup.test.ts` | Tests for duplicate detection in create_task | Create |
| `apps/daemon/src/services/session/worker-executor.ts` | Worker tree interpreter with task-loop logic | Modify |
| `apps/daemon/src/services/session/__tests__/worker-executor-taskloop-guard.test.ts` | Tests for task-loop empty guard | Create |

---

## Task 1: Taskmaster re-entry awareness
**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/agents/taskmaster.md:1-30`

**Purpose:** When the taskmaster starts and tasks already exist (e.g., after a crash, blocked→build transition, or partial run), it should ask the user what to do rather than blindly creating duplicates.

**Not In Scope:** Daemon-level re-entry detection. This is prompt-only.

**Step 1: Update the taskmaster prompt**

Replace the current "The Process" section (lines 22-28) and the opening announcement (lines 5-7) with re-entry-aware logic:

```markdown
**When you start:**

[ ] Step 0 - Check for existing tasks (use `list_tasks`)

If tasks already exist, use `chat_ask` to present the user with options:

"[Taskmaster Agent]: I found {N} existing tasks for this ticket. What would you like me to do?

1. Continue creating tasks from where I left off (starting after task {last_task_number})
2. Go straight to build with the current task list
3. Wipe all tasks and regenerate from the specification
4. [Type a specific instruction]"

**If user chooses option 1:** Read the specification, identify which tickets don't have tasks yet, and create only the missing ones.
**If user chooses option 2:** Exit immediately with code 0 (build phase will proceed with existing tasks).
**If user chooses option 3:** Cancel all existing tasks (set status to "cancelled"), then proceed with fresh task creation from Step 1.
**If user gives a custom instruction:** Follow their instruction.

If NO tasks exist, announce and proceed normally:
"[Taskmaster Agent]: I'm creating tasks from the specification. Each ticket will become a trackable task."

## The Process

[ ] Step 1 - Read specification.md (use skill: `potato:read-artifacts`)
[ ] Step 2 - Identify all tickets (look for `### Ticket N:` headers)
[ ] Step 3 - For each ticket, check if a task with that ticket number already exists (compare description prefixes)
[ ] Step 4 - Create a task for each NEW ticket only (skip existing ones)
[ ] Step 5 - Announce completion with task count
```

**Step 2: Commit**
`git add apps/daemon/templates/workflows/product-development/agents/taskmaster.md`
`git commit -m "feat(taskmaster): add re-entry awareness with user prompt"`

---

## Task 2: Harden body_from enforcement in taskmaster prompt
**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/agents/taskmaster.md:36-79,145-155`

**Purpose:** Change `body_from` from "preferred" to "required when specification.md exists" and add it to the Red Flags section so Claude treats inline `body` as a failure mode.

**Step 1: Update the Creating Tasks section**

Change lines 36-38 from:

```markdown
- `body_from`: Reference to extract body from the specification artifact (preferred — avoids regenerating content)
- `body`: Direct body content (fallback when specification.md doesn't exist)
```

To:

```markdown
- `body_from`: **REQUIRED** when specification.md exists. References the spec content directly — the daemon extracts it. You only provide markers.
- `body`: **ONLY** when specification.md does NOT exist. Direct body content as fallback.
```

Change section header on line 40 from:

```markdown
### When specification.md exists (preferred path)
```

To:

```markdown
### When specification.md exists (REQUIRED path)
```

**Step 2: Add body_from to Red Flags section**

Add to the Red Flags list (after line 153):

```markdown
- "I'll just paste the content into the body field"
- "body_from is too complicated, I'll use body instead"
- "The markers might not match, I'll inline it"
```

Add after the "When you notice these thoughts" line:

```markdown
**For body_from specifically:** If specification.md exists, you MUST use `body_from`. The daemon handles extraction. You only provide the marker strings. Using inline `body` when the spec exists wastes tokens and risks paraphrasing errors.
```

**Step 3: Commit**
`git add apps/daemon/templates/workflows/product-development/agents/taskmaster.md`
`git commit -m "feat(taskmaster): enforce body_from as required when spec exists"`

---

## Task 3: Duplicate detection in create_task MCP tool
**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/mcp/tools/task.tools.ts:345-384`
- Create: `apps/daemon/src/mcp/tools/__tests__/task-dedup.test.ts`

**Purpose:** Before creating a task, check if a task with the same description prefix (up to first colon) already exists for this ticket. Return a warning and skip creation if a duplicate is found.

**Gotchas:** The `create_task` handler calls `listTasksForTicket` which is an HTTP fetch to the daemon API, not a direct store call. The dedup check should use the same API to stay consistent.

**Step 1: Write the failing test**

Create `apps/daemon/src/mcp/tools/__tests__/task-dedup.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**
Run: `cd apps/daemon && npx tsx --test src/mcp/tools/__tests__/task-dedup.test.ts`
Expected: FAIL (extractDescriptionPrefix not exported yet)

**Step 3: Implement the prefix extraction utility**

Add to `apps/daemon/src/mcp/tools/task.tools.ts` (after the `extractSection` function, around line 37):

```typescript
/**
 * Extract and normalize the description prefix for duplicate detection.
 * Compares the portion before the first colon, lowercased and trimmed.
 * If no colon, uses the full description.
 */
export function extractDescriptionPrefix(description: string): string {
  const colonIdx = description.indexOf(":");
  const prefix = colonIdx !== -1
    ? description.slice(0, colonIdx)
    : description;
  return prefix.trim().toLowerCase();
}
```

**Step 4: Run test to verify it passes**
Run: `cd apps/daemon && npx tsx --test src/mcp/tools/__tests__/task-dedup.test.ts`
Expected: PASS

**Step 5: Add duplicate check to the create_task handler**

In `task.tools.ts`, in the `create_task` handler (around line 368, after the session-active write guard), add:

```typescript
    // Duplicate detection: check if a task with the same description prefix exists
    const existingTasks = await listTasksForTicket(ctx, ticketId);
    const newPrefix = extractDescriptionPrefix(args.description);
    if (newPrefix) {
      const duplicate = existingTasks.find(
        (t) => t.status !== "cancelled" && extractDescriptionPrefix(t.description) === newPrefix
      );
      if (duplicate) {
        return {
          content: [{
            type: "text",
            text: `Duplicate detected: task "${duplicate.id}" already has description prefix "${newPrefix}". ` +
                  `Skipping creation. Existing task: ${JSON.stringify({ id: duplicate.id, description: duplicate.description, status: duplicate.status })}`,
          }],
          isError: false,
        };
      }
    }
```

**Step 6: Add body_from nudge warning**

After the duplicate check, before resolving body, add:

```typescript
    // Nudge: warn if using inline body when specification.md exists
    if (args.body && !args.body_from) {
      try {
        const safeProject = ctx.projectId.replace(/\//g, "__");
        const specPath = path.join(TASKS_DIR, safeProject, ticketId, "artifacts", "specification.md");
        await fs.access(specPath);
        // specification.md exists but agent used inline body
        const task = await createTask(ctx, ticketId, args.description, args.body, complexity);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(task, null, 2) +
                  "\n\n⚠️ Warning: specification.md exists for this ticket. " +
                  "Consider using body_from with artifact markers instead of inline body to save tokens and preserve exact spec content.",
          }],
        };
      } catch {
        // specification.md doesn't exist, proceed normally
      }
    }
```

**Step 7: Commit**
`git add apps/daemon/src/mcp/tools/task.tools.ts apps/daemon/src/mcp/tools/__tests__/task-dedup.test.ts`
`git commit -m "feat(mcp): add duplicate detection and body_from nudge to create_task"`

---

## Task 4: Task-loop empty guard in worker-executor
**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/worker-executor.ts:509-523`
- Create: `apps/daemon/src/services/session/__tests__/worker-executor-taskloop-guard.test.ts`

**Purpose:** When a task-loop initializes with zero pending tasks, block the ticket instead of silently skipping. This prevents the GAM-2 scenario where tasks marked done outside the orchestration flow caused the entire build to be skipped.

**Gotchas:** The worker-executor tests require extensive module mocking because it imports many store modules. Follow the pattern in `worker-executor-p4.test.ts` for mock setup.

**Step 1: Write the failing test**

Create `apps/daemon/src/services/session/__tests__/worker-executor-taskloop-guard.test.ts`:

```typescript
import { describe, it, mock, before } from "node:test";
import assert from "node:assert";

// Track callback invocations
const blockedCalls: Array<{ projectId: string; ticketId: string; reason: string }> = [];
const spawnCalls: Array<unknown[]> = [];

// Mock all required modules before importing SUT
// (Follow the pattern from worker-executor-p4.test.ts)

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicket: () => ({ id: "TEST-1", phase: "Build", executionGeneration: 1, workflowId: "wf1" }),
    updateTicket: () => ({}),
    getWorkerState: () => ({
      kind: "active",
      phaseId: "Build",
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    setWorkerState: () => {},
    clearWorkerState: () => {},
  },
});

await mock.module("../../../stores/task.store.js", {
  namedExports: {
    listTasks: () => [],  // No pending tasks
    getTask: () => null,
    updateTaskStatus: () => null,
    getTaskComments: () => [],
  },
});

await mock.module("../../../stores/project.store.js", {
  namedExports: {
    getProjectById: () => ({ id: "proj1", path: "/test", templateName: "product-development" }),
    getProjects: () => [],
    updateProjectTemplate: () => {},
    updateProject: () => {},
    createProject: () => ({}),
  },
});

await mock.module("../../utils/event-bus.js", {
  namedExports: { eventBus: { emit: () => {} } },
});

await mock.module("../ticket-logger.js", {
  namedExports: { logToDaemon: async () => {}, savePrompt: async () => {} },
});

await mock.module("../phase-config.js", {
  namedExports: {
    getPhaseConfig: async () => ({
      id: "Build",
      name: "Build",
      workers: [
        { id: "build-task-loop", type: "taskLoop", maxAttempts: 100, workers: [] },
      ],
      transitions: { next: "Pull Requests" },
    }),
    getNextEnabledPhase: async () => "Pull Requests",
    phaseRequiresIsolation: async () => false,
  },
});

await mock.module("../worker-state.js", {
  namedExports: {
    getWorkerState: () => ({
      kind: "active",
      phaseId: "Build",
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    saveWorkerState: () => {},
    initWorkerState: () => ({
      kind: "active",
      phaseId: "Build",
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    clearWorkerState: () => {},
    createAgentState: (id: string) => ({ id, type: "agent" }),
    prepareForRecovery: (s: unknown) => s,
    hasMatchingExecutionGeneration: () => true,
    createSpawnPendingWorkerState: () => ({}),
    consumeSpawnPendingContinuitySnapshot: () => null,
    createTaskLoopState: () => ({
      id: "build-task-loop",
      type: "taskLoop",
      currentTaskId: null,
      pendingTasks: [],
      completedTasks: [],
      workerIndex: 0,
      activeWorker: null,
    }),
  },
});

await mock.module("../../../stores/ralph-feedback.store.js", {
  namedExports: {
    createRalphFeedback: () => ({}),
    getRalphFeedbackForLoop: () => null,
    addRalphIteration: () => null,
    updateRalphFeedbackStatus: () => null,
  },
});

await mock.module("../../../stores/chat.store.js", {
  namedExports: {
    readQuestion: async () => null,
    clearQuestion: async () => {},
  },
});

await mock.module("../../chat.service.js", {
  namedExports: {
    chatService: { notify: async () => {} },
  },
});

await mock.module("../loops/ralph-loop.js", {
  namedExports: {
    initRalphLoop: () => ({ id: "rl", type: "ralphLoop", iteration: 1, workerIndex: 0, activeWorker: null }),
    handleAgentCompletion: () => ({ loopComplete: true }),
  },
});

await mock.module("../loops/task-loop.js", {
  namedExports: {
    initTaskLoop: () => ({
      id: "build-task-loop", type: "taskLoop", currentTaskId: null,
      pendingTasks: [], completedTasks: [], workerIndex: 0, activeWorker: null,
    }),
    getNextTask: () => null,
    startTask: () => ({}),
    advanceWorkerIndex: () => ({}),
    handleTaskWorkersComplete: () => ({ nextState: {}, result: { status: "completed" } }),
    buildTaskContext: () => ({}),
    formatTaskContext: () => "",
  },
});

const { startPhase } = await import("../worker-executor.js");

describe("task-loop empty guard", () => {
  it("blocks ticket when task-loop has zero pending tasks", async () => {
    blockedCalls.length = 0;

    const callbacks = {
      spawnAgent: async (...args: unknown[]) => {
        spawnCalls.push(args);
        return "session-id";
      },
      onPhaseComplete: async () => {},
      onTicketBlocked: async (projectId: string, ticketId: string, reason: string) => {
        blockedCalls.push({ projectId, ticketId, reason });
      },
    };

    await startPhase("proj1", "TEST-1", "Build", "/test", callbacks);

    assert.strictEqual(blockedCalls.length, 1, "Should have blocked the ticket");
    assert.ok(
      blockedCalls[0].reason.includes("no pending tasks"),
      `Reason should mention no pending tasks, got: ${blockedCalls[0].reason}`
    );
  });
});
```

**Step 2: Run test to verify it fails**
Run: `cd apps/daemon && npx tsx --test src/services/session/__tests__/worker-executor-taskloop-guard.test.ts`
Expected: FAIL (currently skips silently, no blocked call)

**Step 3: Implement the guard**

In `apps/daemon/src/services/session/worker-executor.ts`, replace lines 514-522:

```typescript
    if (!firstTaskId) {
      // No tasks - skip this worker
      const newState: OrchestrationState = {
        ...state,
        workerIndex: state.workerIndex + 1,
        activeWorker: null,
      };
      await saveWorkerState(projectId, ticketId, newState);
      return executeNextWorker(projectId, ticketId, phase, projectPath, phaseConfig, newState, callbacks);
    }
```

With:

```typescript
    if (!firstTaskId) {
      // No pending tasks — block instead of silently skipping.
      // This prevents scenarios where tasks were marked done outside
      // the orchestration flow (e.g., by a resume session) from causing
      // the entire build to be skipped.
      await logToDaemon(projectId, ticketId, `Task loop "${worker.id}" has no pending tasks — blocking ticket`, {
        workerId: worker.id,
        phase,
      });
      await callbacks.onTicketBlocked(
        projectId,
        ticketId,
        `Task loop "${worker.id}" has no pending tasks — refusing to skip. ` +
        `If all tasks are intentionally complete, manually advance the ticket past this phase.`,
      );
      return null;
    }
```

**Step 4: Run test to verify it passes**
Run: `cd apps/daemon && npx tsx --test src/services/session/__tests__/worker-executor-taskloop-guard.test.ts`
Expected: PASS

**Step 5: Run existing worker-executor tests to verify no regressions**
Run: `cd apps/daemon && npx tsx --test src/services/session/__tests__/worker-executor*.test.ts`
Expected: All PASS

**Step 6: Commit**
`git add apps/daemon/src/services/session/worker-executor.ts apps/daemon/src/services/session/__tests__/worker-executor-taskloop-guard.test.ts`
`git commit -m "fix(worker-executor): block ticket when task-loop has no pending tasks"`

---

## Task 5: Integration verification
**Depends on:** Task 1, Task 2, Task 3, Task 4
**Complexity:** simple
**Files:**
- Test: (no new files — runs existing test suites)

**Purpose:** Verify all changes work together and no existing tests break.

**Step 1: Run full daemon test suite**
Run: `cd apps/daemon && pnpm test`
Expected: All tests PASS

**Step 2: Build and typecheck**
Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit any fixes if needed**

---

## Verification Record

| Pass | Verdict | Notes |
|------|---------|-------|
| Plan Verification Checklist | PASS (after fix) | Fixed missing `getRalphFeedbackForLoop` mock in Task 4 test |
| Draft | PASS | Structure, headers, dependencies all correct |
| Feasibility | PASS (after fix) | Fixed missing mocks for `chat.service.js`, `ralph-loop.js`, `task-loop.js` in Task 4 test |
| Completeness | PASS | All 4 requirements fully traced to tasks |
| Risk | PASS | 8 risks evaluated, all acceptable. No migration/breaking changes. |
| Optimality | PASS | body_from nudge flagged as low complexity-to-value but acceptable as belt-and-suspenders |

**Fixes applied during verification:**
1. Task 4 test mock: `getRalphFeedback` → `getRalphFeedbackForLoop` (verification checklist)
2. Task 4 test: added mocks for `chat.service.js`, `loops/ralph-loop.js`, `loops/task-loop.js` (feasibility pass)
