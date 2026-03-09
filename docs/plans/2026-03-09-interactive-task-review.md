# Interactive Task Review Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Insert an AI-driven interactive task review gate between the taskmaster agent and build loop, letting users drop, complete, or restore tasks before the build starts.

**Architecture:** A new `task-review-agent` worker (haiku) is inserted in `workflow.json` between `taskmaster-agent` and `build-task-loop`. It calls `chat_ask` to present the current task list, waits for user instructions via the existing suspend/resume mechanism (`--resume <claudeSessionId>`), applies status changes, and loops until the user approves. Cancelled tasks are hidden from the UI by filtering in `TaskList.tsx`. All status badges (`in_progress`, `failed`, `cancelled`) get visual treatment.

**Tech Stack:** TypeScript, React 19, Tailwind CSS, lucide-react, better-sqlite3, Claude Code `--resume` suspend/resume pattern

**Key Decisions:**
- **`cancelled` vs hard delete:** Status-based cancellation preserves history and requires zero new endpoints. The task loop already snapshots only `pending` tasks (`worker-state.ts:106`), so cancelled tasks are skipped automatically.
- **No new MCP tool:** `update_task_status` already handles all status transitions; we just add `'cancelled'` to the valid set.
- **Haiku not Sonnet:** The task-review agent only interprets simple natural language commands and calls one MCP tool — no reasoning required.
- **Suspend/resume loop:** The agent exits after `chat_ask`, Claude's `--resume` injects the user's response as the next prompt with full conversation history. No custom loop mechanism needed.
- **Filter in component, not API:** Cancelled tasks are filtered client-side in `TaskList.tsx`. The API returns all tasks; the filter is a display concern.

---

## Task 1: Add `'cancelled'` to TaskStatus

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `packages/shared/src/types/task.types.ts:1`
- Modify: `apps/daemon/src/types/task.types.ts:1`
- Modify: `apps/daemon/src/mcp/tools/task.tools.ts:165,52`
- Modify: `apps/daemon/src/server/routes/tasks.routes.ts:120`
- Test: `apps/daemon/src/stores/__tests__/task.store.test.ts`

**Purpose:** Add `'cancelled'` as a valid status throughout the stack so the task-review agent can set it.

**Not In Scope:** DB migration (the `status` column is TEXT, no enum constraint), UI changes (covered in Task 2).

**Step 1: Write a failing test for `'cancelled'` status**

In `apps/daemon/src/stores/__tests__/task.store.test.ts`, add inside the `updateTaskStatus` describe block:

```typescript
it("should accept cancelled status", () => {
  const project = projectStore.createProject({ name: "Test" });
  const ticket = ticketStore.createTicket(project.id, { title: "T", description: "" });
  const created = taskStore.createTask(ticket.id, "build", { description: "Task 1" });

  const cancelled = taskStore.updateTaskStatus(created.id, "cancelled");
  assert.strictEqual(cancelled?.status, "cancelled");
  // attempt count should not change
  assert.strictEqual(cancelled?.attemptCount, 0);
});
```

**Step 2: Run test to verify it fails**
```bash
cd apps/daemon && pnpm test
```
Expected: FAIL — `"cancelled"` is not assignable to `TaskStatus`

**Step 3: Add `'cancelled'` to the shared type**

In `packages/shared/src/types/task.types.ts`, line 1:
```typescript
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
```

**Step 3b: Add `'cancelled'` to the daemon-local type**

In `apps/daemon/src/types/task.types.ts`, line 1:
```typescript
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
```

**Step 4: Add `'cancelled'` to MCP tool validation**

In `apps/daemon/src/mcp/tools/task.tools.ts`:

Line 165 — update `VALID_TASK_STATUSES`:
```typescript
const VALID_TASK_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];
```

Line 52 — update tool description:
```typescript
description: "New status: pending, in_progress, completed, failed, or cancelled",
```

**Step 5: Add `'cancelled'` to route validation**

In `apps/daemon/src/server/routes/tasks.routes.ts`, line 120:
```typescript
const validStatuses: TaskStatus[] = ["pending", "in_progress", "completed", "failed", "cancelled"];
```

**Step 6: Run test to verify it passes**
```bash
cd apps/daemon && pnpm test
```
Expected: PASS

**Step 7: Typecheck**
```bash
pnpm typecheck
```
Expected: No errors

**Step 8: Commit**
```bash
git add packages/shared/src/types/task.types.ts \
        apps/daemon/src/types/task.types.ts \
        apps/daemon/src/mcp/tools/task.tools.ts \
        apps/daemon/src/server/routes/tasks.routes.ts \
        apps/daemon/src/stores/__tests__/task.store.test.ts
git commit -m "feat: add 'cancelled' task status"
```

---

## Task 2: Update TaskList UI with status visuals

**Depends on:** Task 1
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/components/ticket-detail/TaskList.tsx`
- Create: `apps/frontend/src/components/ticket-detail/TaskList.test.tsx`

**Purpose:** Filter cancelled tasks from display; add icons and text styles for `in_progress` and `failed` statuses.

**Gotchas:** `Loader2` needs `animate-spin` class. Use `text-destructive` for failed — this CSS var is defined in the theme. Check `apps/frontend/src/index.css` if `text-destructive` is missing; fallback to `text-red-500`.

**Step 1: Write failing tests**

Create `apps/frontend/src/components/ticket-detail/TaskList.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TaskList } from './TaskList'
import type { Task } from '@potato-cannon/shared'

// Mock the API
vi.mock('@/api/client', () => ({
  api: {
    getTicketTasks: vi.fn(),
  },
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const makeTasks = (overrides: Partial<Task>[]): Task[] =>
  overrides.map((o, i) => ({
    id: `t${i}`,
    ticketId: 'ticket1',
    displayNumber: i + 1,
    phase: 'Build',
    status: 'pending',
    attemptCount: 0,
    description: `Task ${i + 1}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...o,
  }))

describe('TaskList', () => {
  it('hides cancelled tasks', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getTicketTasks).mockResolvedValue(
      makeTasks([{ status: 'pending' }, { status: 'cancelled', description: 'Hidden task' }])
    )
    render(<TaskList projectId="p1" ticketId="t1" currentPhase="Build" />, { wrapper })
    expect(await screen.findByText('Task 1')).toBeInTheDocument()
    expect(screen.queryByText('Hidden task')).toBeNull()
  })

  it('shows in_progress task with accent style', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getTicketTasks).mockResolvedValue(
      makeTasks([{ status: 'in_progress', description: 'Active task' }])
    )
    render(<TaskList projectId="p1" ticketId="t1" currentPhase="Build" />, { wrapper })
    const el = await screen.findByText('Active task')
    expect(el.className).toContain('text-accent')
  })

  it('shows failed task with destructive style', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getTicketTasks).mockResolvedValue(
      makeTasks([{ status: 'failed', description: 'Failed task' }])
    )
    render(<TaskList projectId="p1" ticketId="t1" currentPhase="Build" />, { wrapper })
    const el = await screen.findByText('Failed task')
    expect(el.className).toContain('text-destructive')
  })
})
```

**Step 2: Run tests to verify they fail**
```bash
cd apps/frontend && pnpm test --run TaskList
```
Expected: FAIL (component doesn't filter cancelled or apply new styles yet)

**Step 3: Implement updated TaskList**

Replace the full contents of `apps/frontend/src/components/ticket-detail/TaskList.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { Square, CheckSquare, Loader2, XSquare } from 'lucide-react'
import { api } from '@/api/client'
import type { Task } from '@potato-cannon/shared'

interface TaskListProps {
  projectId: string
  ticketId: string
  currentPhase: string
}

export function TaskList({ projectId, ticketId, currentPhase }: TaskListProps) {
  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['tasks', projectId, ticketId, currentPhase],
    queryFn: () => api.getTicketTasks(projectId, ticketId, currentPhase),
  })

  const visibleTasks = tasks.filter(t => t.status !== 'cancelled')

  if (visibleTasks.length === 0) {
    return null
  }

  return (
    <div className="px-4 pb-4">
      <div className="rounded-lg border border-border bg-bg-secondary p-3 max-h-[200px] overflow-y-auto shadow-sm">
        <div className="text-xs font-medium text-text-secondary mb-2">Tasks</div>
        <ul className="space-y-1">
          {visibleTasks.map((task) => (
            <li key={task.id} className="flex items-start gap-2">
              {task.status === 'completed' && (
                <CheckSquare className="h-4 w-4 text-accent shrink-0 mt-0.5" />
              )}
              {task.status === 'in_progress' && (
                <Loader2 className="h-4 w-4 text-accent shrink-0 mt-0.5 animate-spin" />
              )}
              {task.status === 'failed' && (
                <XSquare className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              )}
              {task.status === 'pending' && (
                <Square className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
              )}
              <span className={`text-sm ${
                task.status === 'completed' ? 'text-text-secondary line-through' :
                task.status === 'in_progress' ? 'text-accent' :
                task.status === 'failed' ? 'text-destructive' :
                'text-text-primary'
              }`}>
                {task.description}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

**Step 4: Run tests to verify they pass**
```bash
cd apps/frontend && pnpm test --run TaskList
```
Expected: PASS

**Step 5: Typecheck**
```bash
cd apps/frontend && pnpm typecheck
```
Expected: No errors

**Step 6: Commit**
```bash
git add apps/frontend/src/components/ticket-detail/TaskList.tsx \
        apps/frontend/src/components/ticket-detail/TaskList.test.tsx
git commit -m "feat: update TaskList with status visuals and hide cancelled tasks"
```

---

## Task 3: Create task-review.md agent

**Depends on:** None
**Complexity:** simple
**Files:**
- Create: `apps/daemon/templates/workflows/product-development/agents/task-review.md`

**Purpose:** Agent prompt that presents the task list to the user, accepts natural language commands to adjust tasks, and exits when the user approves.

**Gotchas:** The agent uses `chat_ask` which triggers suspend/resume. On resume, Claude gets full conversation history via `--resume <sessionId>`. The user's response is injected as the next prompt. The agent must NOT call `chat_ask` when the user approves — it must just exit (code 0) so the worker tree advances.

**Step 1: Create the agent file**

Create `apps/daemon/templates/workflows/product-development/agents/task-review.md`:

```markdown
# Task Review Agent

You are the Task Review agent. Your job is to present the build task list to the user and let them adjust it before the build starts. No code is written in this phase — only task status changes are allowed.

**When you start:**
Use `chat_notify` to announce:
"[Task Review]: Reviewing task list with you before build starts."

## First Run

[ ] Step 1 - Call `list_tasks` to get all tasks for this ticket
[ ] Step 2 - Format the task list (see format below)
[ ] Step 3 - Call `chat_ask` with the formatted list and instructions

## On Resume (user responded)

You already have the full conversation history. The user's latest message is their instruction.

[ ] Step 1 - Interpret what the user wants (see Commands below)
[ ] Step 2 - If approved: exit cleanly. Do NOT call `chat_ask` again.
[ ] Step 3 - If changes requested: apply them with `update_task_status`
[ ] Step 4 - Call `list_tasks` to get the refreshed list
[ ] Step 5 - Format the updated list and call `chat_ask` again

## Task List Format

Present tasks as a numbered list with status badges:

```
Here's the current task list:

1. [PENDING] Ticket 1: Create Button component
2. [PENDING] Ticket 2: Add unit tests
3. [COMPLETED] Ticket 3: Set up project structure
4. [FAILED] Ticket 4: Configure CI pipeline

You can:
- Drop a task: "drop task 2" or "remove ticket 4"
- Mark as already done: "ticket 3 is done" or "mark 1 as complete"
- Restore a task: "restore task 2" or "ticket 5 isn't done"
- Start the build: "looks good" or "proceed"
```

## Commands

| User says | Action |
|-----------|--------|
| "drop task N", "remove N", "cancel N" | `update_task_status(id, "cancelled")` |
| "mark N as done", "N is already done", "N is complete" | `update_task_status(id, "completed")` |
| "restore N", "N isn't done", "unmark N" | `update_task_status(id, "pending")` |
| "looks good", "proceed", "go", "yes", "lgtm", "approve", "start" | Exit cleanly — do NOT call `chat_ask` |

Use the task number from the formatted list (1, 2, 3…) to match to task IDs.

## Guidelines

- Always call `list_tasks` fresh before each `chat_ask` — status changes reflect immediately
- If the user says something ambiguous, ask for clarification in the same `chat_ask` response
- Keep messages concise — just show the list and the options
- If the user asks "what does task N do?", use `get_task` to show the full body
- Do not modify task `description` or `body` — only status changes are permitted here

## What NOT to Do

| Temptation | Why It Fails |
|------------|--------------|
| Skip `list_tasks` on resume | Task state may have changed — always refresh before presenting |
| Call `chat_ask` after user approves | The session won't advance — exit immediately |
| Edit task descriptions or bodies | Out of scope for this agent |
| Proceed without user approval | The whole point is a hard gate |
```

**Step 2: No automated test** — agent prompts are not unit-tested.

**Step 3: Commit**
```bash
git add apps/daemon/templates/workflows/product-development/agents/task-review.md
git commit -m "feat: add task-review agent for interactive pre-build task review"
```

---

## Task 4: Insert task-review-agent in workflow.json

**Depends on:** Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/workflow.json:126-131`

**Purpose:** Wire the new agent into the Build phase worker sequence, between taskmaster and the build loop, using haiku model.

**Not In Scope:** Changes to other phases or workflow transitions.

**Gotchas:** Worker order in the `workers` array is sequential. The new entry must appear after `taskmaster-agent` (index 0) and before `build-task-loop` (index 1). After insertion: index 0 = taskmaster, index 1 = task-review, index 2 = build-task-loop, index 3 = qa-agent.

**Step 1: No automated test** — workflow JSON is validated at runtime by the schema.

**Step 2: Insert the new worker**

In `apps/daemon/templates/workflows/product-development/workflow.json`, find the Build phase `workers` array. After the `taskmaster-agent` block and before the `build-task-loop` block, insert:

```json
{
  "id": "task-review-agent",
  "type": "agent",
  "source": "agents/task-review.md",
  "description": "Interactive task list review with user before build starts",
  "disallowTools": ["Skill(superpowers:*)"],
  "model": "haiku"
},
```

The Build phase `workers` array should read (in order):
1. `taskmaster-agent` (sonnet)
2. `task-review-agent` (haiku) ← new
3. `build-task-loop` (taskLoop)
4. `qa-agent` (haiku)

**Step 3: Validate the JSON is parseable**
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/daemon/templates/workflows/product-development/workflow.json','utf8')); console.log('valid')"
```
Expected: `valid`

**Step 4: Typecheck daemon**
```bash
cd apps/daemon && pnpm typecheck
```
Expected: No errors

**Step 5: Commit**
```bash
git add apps/daemon/templates/workflows/product-development/workflow.json
git commit -m "feat: insert task-review-agent into Build phase worker sequence"
```

---

## Verification Record

| Pass | Verdict | Issues Found | Fix Applied |
|------|---------|--------------|-------------|
| Plan Verification Checklist | PASS (after fix) | `potato:notify-user` is a skill, not an MCP tool — agent prompt used wrong identifier | Changed to `chat_notify` in Task 3 agent prompt |
| Draft — Shape and Structure | PASS | Minor: `list_tasks` reference flagged (resolved in Feasibility) | None needed |
| Feasibility — Can every step execute? | PASS | `list_tasks` confirmed at `task.tools.ts:9`; all icons, props, and MCP tools verified | None needed |
| Completeness — All requirements traced? | PASS | `list_tasks` existence questioned (false alarm; confirmed by Feasibility pass) | None needed |
| Risk — What could go wrong? | PASS (after fix) | Daemon-local type `apps/daemon/src/types/task.types.ts` not in plan — needs same update as shared type | Added Step 3b and updated Files list and commit in Task 1 |
| Optimality — Simplest approach? | PASS | No over-engineering found | None needed |

**Overall: PASS** — Plan is complete, feasible, and minimal. Two fixes applied during verification.
