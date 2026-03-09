# Complexity-Based Model Routing Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Add a three-level complexity rating (simple/standard/complex) to tickets and tasks that drives automatic per-agent model selection, reducing cost by routing simple work to cheaper models.

**Architecture:** Complexity is a first-class field on tickets and tasks (DB column, default `standard`). Workflow template agent workers declare a model matrix `{ simple, standard, complex }` instead of a single model. The session service resolves the appropriate model at spawn time by reading ticket/task complexity.

**Tech Stack:** TypeScript, better-sqlite3, Express, React 19, TanStack Query, Radix UI / shadcn

**Key Decisions:**
- **Never null complexity:** Default `standard` at DB level — eliminates null-handling throughout the stack. No "unknown" badge state.
- **Template-level matrix, not project-level:** Model matrix lives in workflow.json on each agent, not in project settings. Keeps configuration co-located with agent definitions and editable in the template editor.
- **Complexity at plan time:** Agents (brainstorm, refinement, taskmaster) set complexity — not dispatch-time estimation. Planners have full scope context; dispatch-time estimation adds latency with no benefit.
- **String form stays valid:** `"model": "haiku"` (string) continues to work unchanged. Only agents that opt into the matrix shape get dynamic routing. Zero breaking changes.
- **Skill as single source of truth for heuristics:** `potato:estimate-complexity` skill holds the heuristics table. All three agent prompts invoke it rather than duplicating inline.

---

## Task 1: DB Schema Migration V12 + Shared/Daemon Type Changes

**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `packages/shared/src/types/ticket.types.ts`
- Modify: `packages/shared/src/types/task.types.ts`
- Modify: `apps/daemon/src/types/task.types.ts`
- Modify: `apps/daemon/src/types/ticket.types.ts`

**Purpose:** Foundation for all other tasks. Adds the complexity column with DEFAULT 'standard' so existing rows get the right value automatically.

**Step 1: Write the failing test**

In `apps/daemon/src/stores/__tests__/` (create if needed), verify migration:

```typescript
// apps/daemon/src/stores/__tests__/complexity-migration.test.ts
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

describe('migration V12 complexity columns', () => {
  let db: Database.Database;
  before(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('tickets table has complexity column defaulting to standard', () => {
    db.exec("INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('p1','p1','P1','/p1', '2026-01-01')");
    db.exec("INSERT INTO ticket_counters (project_id, next_number) VALUES ('p1', 1)");
    db.exec("INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at) VALUES ('t1','p1','Test','Backlog','2026-01-01','2026-01-01')");
    const row = db.prepare("SELECT complexity FROM tickets WHERE id = 't1'").get() as { complexity: string };
    assert.equal(row.complexity, 'standard');
  });

  it('tasks table has complexity column defaulting to standard', () => {
    db.exec("INSERT INTO tasks (id, ticket_id, display_number, phase, status, attempt_count, description, created_at, updated_at) VALUES ('task1','t1',1,'Build','pending',0,'Test task','2026-01-01','2026-01-01')");
    const row = db.prepare("SELECT complexity FROM tasks WHERE id = 'task1'").get() as { complexity: string };
    assert.equal(row.complexity, 'standard');
  });
});
```

**Step 2: Run test to verify it fails**
```bash
cd apps/daemon && pnpm test 2>&1 | grep -A 5 "complexity-migration"
```
Expected: FAIL (complexity column doesn't exist)

**Step 3: Add migration V12**

In `apps/daemon/src/stores/migrations.ts`:
- Change `CURRENT_SCHEMA_VERSION` from `11` to `12`
- Add at the end of `runMigrations()` (before pragma):
```typescript
  if (version < 12) {
    migrateV12(db);
  }
```
- Add function:
```typescript
/**
 * V12: Add complexity column to tickets and tasks
 */
function migrateV12(db: Database.Database): void {
  db.exec(`
    ALTER TABLE tickets ADD COLUMN complexity TEXT NOT NULL DEFAULT 'standard'
      CHECK(complexity IN ('simple', 'standard', 'complex'));
    ALTER TABLE tasks ADD COLUMN complexity TEXT NOT NULL DEFAULT 'standard'
      CHECK(complexity IN ('simple', 'standard', 'complex'));
  `);
}
```

**Step 4: Add `Complexity` type and update shared Ticket + Task types**

In `packages/shared/src/types/ticket.types.ts`, add at top:
```typescript
export type Complexity = 'simple' | 'standard' | 'complex'
```
Add to `Ticket` interface:
```typescript
  complexity: Complexity
```

In `packages/shared/src/types/task.types.ts`, import Complexity from ticket.types (or add directly):
```typescript
export type { Complexity } from './ticket.types.js'
```
Add to `Task` interface:
```typescript
  complexity: Complexity
```

**Step 5: Update daemon task types**

In `apps/daemon/src/types/task.types.ts`, add to `CreateTaskInput`:
```typescript
  complexity?: Complexity
```
Import `Complexity` from `@potato-cannon/shared`.

**Step 6: Update daemon ticket types**

In `apps/daemon/src/types/ticket.types.ts`, add to `UpdateTicketInput`:
```typescript
  complexity?: Complexity
```
Import `Complexity` from `@potato-cannon/shared`.

**Step 7: Run test to verify it passes**
```bash
cd apps/daemon && pnpm test 2>&1 | grep -A 5 "complexity-migration"
```
Expected: PASS

**Step 8: Typecheck**
```bash
pnpm typecheck
```
Expected: No errors

**Step 9: Commit**
```bash
git add apps/daemon/src/stores/migrations.ts packages/shared/src/types/ticket.types.ts packages/shared/src/types/task.types.ts apps/daemon/src/types/task.types.ts apps/daemon/src/types/ticket.types.ts apps/daemon/src/stores/__tests__/complexity-migration.test.ts
git commit -m "feat: add complexity column to tickets and tasks (migration V12)"
```

---

## Task 2: Extend ModelSpec + Update model-resolver for complexity map

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/types/template.types.ts`
- Modify: `apps/daemon/src/services/session/model-resolver.ts`
- Modify: `apps/daemon/src/services/session/__tests__/model-resolver.test.ts`

**Purpose:** Makes the model field on agent workers accept `{ simple, standard, complex }` map. Backwards compatible — string form unchanged.

**Step 1: Write failing tests**

Add to `apps/daemon/src/services/session/__tests__/model-resolver.test.ts`:
```typescript
describe('complexity map', () => {
  it('resolves simple complexity from map', () => {
    const result = resolveModel({ simple: 'haiku', standard: 'sonnet', complex: 'opus' }, 'simple');
    assert.strictEqual(result, 'haiku');
  });

  it('resolves standard complexity from map', () => {
    const result = resolveModel({ simple: 'haiku', standard: 'sonnet', complex: 'opus' }, 'standard');
    assert.strictEqual(result, 'sonnet');
  });

  it('resolves complex complexity from map', () => {
    const result = resolveModel({ simple: 'haiku', standard: 'sonnet', complex: 'opus' }, 'complex');
    assert.strictEqual(result, 'opus');
  });

  it('falls back to standard when complexity null', () => {
    const result = resolveModel({ simple: 'haiku', standard: 'sonnet', complex: 'opus' }, null);
    assert.strictEqual(result, 'sonnet');
  });

  it('string model spec ignores complexity param', () => {
    const result = resolveModel('haiku', 'complex');
    assert.strictEqual(result, 'haiku');
  });
});
```

**Step 2: Run test to verify it fails**
```bash
cd apps/daemon && pnpm test 2>&1 | grep -A 5 "complexity map"
```
Expected: FAIL

**Step 3: Add ComplexityModelMap type to template.types.ts**

In `apps/daemon/src/types/template.types.ts`, add after existing `ModelSpec`:
```typescript
export interface ComplexityModelMap {
  simple?: string;
  standard?: string;
  complex?: string;
}
```
Update `ModelSpec`:
```typescript
export type ModelSpec = string | { id: string; provider?: string } | ComplexityModelMap;
```
Add type guard:
```typescript
export function isComplexityModelMap(model: ModelSpec): model is ComplexityModelMap {
  return typeof model === 'object' && !('id' in model);
}
```

**Step 4: Update resolveModel signature**

In `apps/daemon/src/services/session/model-resolver.ts`:

```typescript
import type { ModelSpec, ComplexityModelMap } from '../../types/template.types.js';
import type { Complexity } from '@potato-cannon/shared';
import { isComplexityModelMap } from '../../types/template.types.js';

export function resolveModel(model: ModelSpec | undefined, complexity?: Complexity | null): string | null {
  if (!model) return null;

  // Complexity map: { simple, standard, complex }
  if (isComplexityModelMap(model)) {
    const level = complexity ?? 'standard';
    const resolved = model[level] ?? model.standard;
    if (!resolved) return null;
    return resolveModel(resolved, null); // recurse to validate the string
  }

  // String format: shortcut or explicit ID (existing logic unchanged)
  if (typeof model === 'string') {
    if (model === '') return null;
    if (MODEL_SHORTCUTS.includes(model as (typeof MODEL_SHORTCUTS)[number])) return model;
    if (model.startsWith('claude-')) return model;
    console.warn(`[resolveModel] Unrecognized model "${model}", using default`);
    return null;
  }

  // Object format: { id, provider? } (existing logic unchanged)
  if (typeof model === 'object' && model.id) {
    if (model.id === '') return null;
    if (model.provider && model.provider !== 'anthropic') {
      console.warn(`[resolveModel] Provider "${model.provider}" not supported, using default`);
      return null;
    }
    return model.id;
  }

  return null;
}
```

**Step 5: Run test to verify it passes**
```bash
cd apps/daemon && pnpm test 2>&1 | grep -A 5 "complexity map"
```
Expected: PASS

**Step 6: Typecheck**
```bash
pnpm typecheck
```
Expected: No errors

**Step 7: Commit**
```bash
git add apps/daemon/src/types/template.types.ts apps/daemon/src/services/session/model-resolver.ts apps/daemon/src/services/session/__tests__/model-resolver.test.ts
git commit -m "feat: extend ModelSpec with ComplexityModelMap, update resolveModel"
```

---

## Task 3: Update ticket.store and task.store for complexity

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/ticket.store.ts`
- Modify: `apps/daemon/src/stores/task.store.ts`

**Purpose:** Wire the new complexity column through the store row mappers and CRUD operations.

**Not In Scope:** API routes (Task 7). MCP handlers (Tasks 5, 6).

**Step 1: Write failing test**

In `apps/daemon/src/stores/__tests__/task-complexity.test.ts`:
```typescript
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
import { createTaskStore } from '../task.store.js';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

describe('task store complexity', () => {
  let db: Database.Database;
  before(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.exec("INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('p1','p1','P1','/p1','2026-01-01')");
    db.exec("INSERT INTO ticket_counters (project_id, next_number) VALUES ('p1', 1)");
    db.exec("INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at) VALUES ('t1','p1','Test','Build','2026-01-01','2026-01-01')");
  });

  it('creates task with default complexity standard', () => {
    const store = createTaskStore(db);
    const task = store.createTask('t1', 'Build', { description: 'Test task' });
    assert.equal(task.complexity, 'standard');
  });

  it('creates task with explicit complexity', () => {
    const store = createTaskStore(db);
    const task = store.createTask('t1', 'Build', { description: 'Complex task', complexity: 'complex' });
    assert.equal(task.complexity, 'complex');
  });
});
```

**Step 2: Run test to verify it fails**
```bash
cd apps/daemon && pnpm test 2>&1 | grep -A 5 "task store complexity"
```
Expected: FAIL

**Step 3: Update task.store.ts**

Add `complexity` to `TaskRow`:
```typescript
interface TaskRow {
  // ... existing fields ...
  complexity: string;
}
```

Update `rowToTask()`:
```typescript
function rowToTask(row: TaskRow): Task {
  return {
    // ... existing fields ...
    complexity: row.complexity as Complexity,
  };
}
```

Update `createTask()` INSERT to include complexity:
```typescript
createTask(ticketId: string, phase: string, input: CreateTaskInput): Task {
  // ... existing ID/now generation ...
  const complexity = input.complexity ?? 'standard';

  this.db.prepare(`
    INSERT INTO tasks (id, ticket_id, display_number, phase, status, attempt_count, description, body, complexity, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
  `).run(id, ticketId, displayNumber, phase, input.description, input.body ?? null, complexity, now, now);

  return this.getTask(id)!;
}
```

**Step 4: Update ticket.store.ts**

Add `complexity` to `TicketRow`:
```typescript
interface TicketRow {
  // ... existing fields ...
  complexity: string;
}
```

Update `rowToTicket()` to map complexity field.

Update `updateTicket()` to support complexity in the SET clause when provided.

**Step 5: Run test to verify it passes**
```bash
cd apps/daemon && pnpm test 2>&1 | grep -A 5 "task store complexity"
```
Expected: PASS

**Step 6: Typecheck**
```bash
pnpm typecheck
```
Expected: No errors

**Step 7: Commit**
```bash
git add apps/daemon/src/stores/ticket.store.ts apps/daemon/src/stores/task.store.ts apps/daemon/src/stores/__tests__/task-complexity.test.ts
git commit -m "feat: wire complexity through ticket and task stores"
```

---

## Task 4: session.service — pass complexity to resolveModel

**Depends on:** Task 2, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`

**Purpose:** At agent spawn time, read the ticket or task complexity and pass it to `resolveModel` so the right model from the complexity map is selected.

**Not In Scope:** Changes to worker-executor.ts — the complexity lookup happens inside `spawnAgentWorker` which already has the ticket and taskContext.

**Step 1: Write failing test**

The easiest way is an integration test. In `apps/daemon/src/services/session/__tests__/session.service.test.ts`, add a test that verifies resolveModel is called with complexity (can be a mock check). Alternatively, unit test the resolution logic directly by calling `resolveModel({ simple: 'haiku', standard: 'sonnet', complex: 'opus' }, 'simple')` and asserting `haiku` — this is already covered in Task 2 tests.

For this task, the verification step is a runtime test: after all changes, start the daemon and trigger a ticket that uses a complexity map model. The log will show `Spawning ... with model haiku/sonnet/opus`.

**Step 2: Implement**

In `session.service.ts` around line 968, change:
```typescript
// Before
const resolvedModel = resolveModel(agentWorker.model);
```
to:
```typescript
// After
const taskComplexity = taskContext
  ? (await getTask(taskContext.taskId))?.complexity ?? ticket.complexity
  : ticket.complexity;
const resolvedModel = resolveModel(agentWorker.model, taskComplexity);
```

Import `getTask` from the task store if not already imported:
```typescript
import { getTask } from '../../stores/task.store.js';
```

**Gotcha:** `getTask` is synchronous (better-sqlite3) but `spawnAgentWorker` is async. The `await` is a no-op for sync functions — just use `getTask(taskContext.taskId)` directly without await.

**Step 3: Typecheck**
```bash
pnpm typecheck
```
Expected: No errors

**Step 4: Commit**
```bash
git add apps/daemon/src/services/session/session.service.ts
git commit -m "feat: pass ticket/task complexity to model resolver at agent spawn"
```

---

## Task 5: MCP tool — set_ticket_complexity

**Depends on:** Task 1, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/mcp/tools/ticket.tools.ts`

**Purpose:** Allows brainstorm and refinement agents to set ticket-level complexity via MCP.

**Step 1: Write failing test**

```typescript
// Manual test: after implementing, call from Claude session:
// set_ticket_complexity({ complexity: 'complex' })
// Verify ticket.complexity updated in DB
```
For automated: add to ticket tools handler test file if one exists. Otherwise verify via typecheck + runtime.

**Step 2: Add tool definition to ticket.tools.ts**

Add to the `ticketTools` array:
```typescript
{
  name: 'set_ticket_complexity',
  description: 'Set the complexity rating of the current ticket. Call after estimating complexity using the potato:estimate-complexity skill. Valid values: simple, standard, complex.',
  inputSchema: {
    type: 'object',
    properties: {
      complexity: {
        type: 'string',
        enum: ['simple', 'standard', 'complex'],
        description: 'Complexity rating: simple (≤1 file, ≤1 step), standard (2-3 files, routine), complex (4+ files, new patterns, security, integration)',
      },
    },
    required: ['complexity'],
  },
},
```

**Step 3: Add handler**

In the ticket tool handler (wherever `ticketHandlers` or similar is defined):
```typescript
case 'set_ticket_complexity': {
  const { complexity } = args as { complexity: Complexity };
  const updated = updateTicket(context.projectId, context.ticketId, { complexity });
  if (!updated) {
    return { content: [{ type: 'text', text: 'Error: ticket not found' }] };
  }
  return { content: [{ type: 'text', text: `Complexity set to: ${complexity}` }] };
}
```

**Step 4: Typecheck**
```bash
pnpm typecheck
```
Expected: No errors

**Step 5: Commit**
```bash
git add apps/daemon/src/mcp/tools/ticket.tools.ts
git commit -m "feat: add set_ticket_complexity MCP tool"
```

---

## Task 6: MCP tool — add complexity to create_task

**Depends on:** Task 1, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/mcp/tools/task.tools.ts`

**Purpose:** Allows taskmaster/spec agents to set per-task complexity when creating tasks.

**Step 1: Add complexity parameter to create_task tool definition**

In `apps/daemon/src/mcp/tools/task.tools.ts`, in the `create_task` tool's `inputSchema.properties`, add:
```typescript
complexity: {
  type: 'string',
  enum: ['simple', 'standard', 'complex'],
  description: 'Task complexity: simple (≤1 non-test file, ≤1 step), standard (2-3 files, routine — default), complex (4+ files, new patterns, security, integration)',
},
```
Leave it out of `required` — it's optional, defaults to `standard`.

**Step 2: Update create_task handler**

Pass `complexity` through to the store call:
```typescript
case 'create_task': {
  const { description, body, complexity } = args as {
    description: string;
    body?: string;
    complexity?: Complexity
  };
  const task = createTask(context.ticketId, context.phase, { description, body, complexity });
  return { content: [{ type: 'text', text: `Task created: ${task.id} (complexity: ${task.complexity})` }] };
}
```

**Step 3: Typecheck**
```bash
pnpm typecheck
```
Expected: No errors

**Step 4: Commit**
```bash
git add apps/daemon/src/mcp/tools/task.tools.ts
git commit -m "feat: add optional complexity param to create_task MCP tool"
```

---

## Task 7: REST API endpoint — PATCH ticket complexity

**Depends on:** Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/server/routes/projects.routes.ts`

**Purpose:** Allows the frontend to update ticket-level complexity when the user clicks the badge.

**Step 1: Add route**

In `apps/daemon/src/server/routes/projects.routes.ts`, find the ticket routes section and add:

```typescript
// PATCH /api/projects/:projectId/tickets/:ticketId/complexity
app.patch('/api/projects/:projectId/tickets/:ticketId/complexity', async (req: Request, res: Response) => {
  const { projectId, ticketId } = req.params;
  const { complexity } = req.body as { complexity: string };

  if (!['simple', 'standard', 'complex'].includes(complexity)) {
    return res.status(400).json({ error: 'Invalid complexity value' });
  }

  const ticket = updateTicket(projectId, ticketId, { complexity: complexity as Complexity });
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  res.json(ticket);
});
```

**Step 2: Typecheck**
```bash
pnpm typecheck
```
Expected: No errors

**Step 3: Commit**
```bash
git add apps/daemon/src/server/routes/projects.routes.ts
git commit -m "feat: add PATCH /tickets/:id/complexity REST endpoint"
```

---

## Task 8: potato:estimate-complexity skill

**Depends on:** None
**Complexity:** simple
**Files:**
- Create: `C:/Users/jackd/.claude/plugins/cache/potato-cannon-marketplace/potato/1.0.0/skills/estimate-complexity/SKILL.md`

**Purpose:** Single source of truth for complexity heuristics. All three agent prompts invoke this instead of duplicating the table inline.

**Step 1: Create the skill file**

```markdown
---
name: potato:estimate-complexity
description: "Estimate the complexity of a ticket or task and set it via MCP. Use when brainstorming, refining, or creating tasks."
---

# Estimate Complexity

Use this skill to estimate the complexity of the current ticket or a specific task, then persist it via MCP.

## Complexity Heuristics

| Level | When to use |
|-------|-------------|
| `simple` | ≤1 non-test file modified, ≤1 implementation step. Config changes, wording updates, adding a single export, renaming. |
| `standard` | 2-3 non-test files, clear and well-understood requirements, routine coding work. **Default — use when unsure.** |
| `complex` | 4+ non-test files, OR introducing new architectural patterns, OR security-sensitive changes, OR cross-system integration work. |

## How to Estimate

1. Review the scope: what files will be touched? How many implementation steps?
2. Apply the heuristics above.
3. When in doubt, default to `standard`.
4. Call the appropriate MCP tool:

**For ticket-level complexity** (brainstorm and refinement agents):
```
set_ticket_complexity({ complexity: "simple" | "standard" | "complex" })
```

**For task-level complexity** (taskmaster/spec agent, when calling create_task):
```
create_task({
  description: "...",
  body: "...",
  complexity: "simple" | "standard" | "complex"
})
```

## Re-evaluation

Refinement agents should re-evaluate complexity after requirements are fully understood. It is normal to upgrade simple→standard or standard→complex once the full scope is clear.
```

**Step 2: Verify skill appears in available skills**

Restart the Claude Code session and verify `potato:estimate-complexity` appears in the skill list.

**Step 3: No commit needed** — skill lives outside the repo in the plugin cache.

---

## Task 9: Agent prompt updates

**Depends on:** Task 5, Task 6, Task 8
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/agents/brainstorm.md`
- Modify: `apps/daemon/templates/workflows/product-development/agents/refinement.md`
- Modify: `apps/daemon/templates/workflows/product-development/agents/taskmaster.md`

**Purpose:** Instruct agents to use the skill and call the MCP tools at the right lifecycle points.

**Not In Scope:** Changing agent core logic — only adding a complexity estimation step.

**Step 1: Update brainstorm.md**

Add a section near the end of the prompt (before the final output instructions):
```markdown
## Complexity Estimate

Before finishing, invoke the `potato:estimate-complexity` skill to estimate the complexity of
this ticket based on the brainstormed scope. Call `set_ticket_complexity` with your estimate.
This is an initial estimate — refinement will re-evaluate once requirements are clearer.
```

**Step 2: Update refinement.md**

Add a section at the end of the prompt:
```markdown
## Complexity Re-evaluation

After completing refinement, invoke the `potato:estimate-complexity` skill to re-evaluate
ticket complexity based on the now-understood scope. Update with `set_ticket_complexity`.
This supersedes the brainstorm estimate and should reflect the refined requirements.
```

**Step 3: Update taskmaster.md**

Add to the task creation instructions:
```markdown
## Task Complexity

For each task you create, invoke `potato:estimate-complexity` and include a `complexity` field
in your `create_task` call. Estimate based on the individual task scope (not the whole ticket).
```

**Step 4: Typecheck (N/A for markdown — verify no syntax issues)**

**Step 5: Commit**
```bash
git add apps/daemon/templates/workflows/product-development/agents/brainstorm.md apps/daemon/templates/workflows/product-development/agents/refinement.md apps/daemon/templates/workflows/product-development/agents/taskmaster.md
git commit -m "feat: add complexity estimation instructions to brainstorm, refinement, taskmaster agents"
```

---

## Task 10: Frontend — AgentCard model matrix UI

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/templates/AgentCard.tsx`
- Modify: `packages/shared/src/types/template.types.ts`

**Purpose:** Replace (absent) single model dropdown with a 3-row complexity matrix in the template editor's agent card.

**Not In Scope:** Changing template persistence — `workflow.json` already accepts the object form from Task 2.

**Step 1: Expose model on TemplateWorker in shared types**

In `packages/shared/src/types/template.types.ts`, update `TemplateWorker`:
```typescript
export interface TemplateWorker {
  id: string;
  type: 'agent' | 'ralphLoop' | 'taskLoop'
  description?: string
  source?: string
  workers?: TemplateWorker[]
  maxAttempts?: number
  model?: string | { simple?: string; standard?: string; complex?: string }
}
```

**Step 2: Add ComplexityModelMatrix component in AgentCard.tsx**

In the expanded content section of `AgentCard.tsx`, after the Description field, add a "Model Routing" section:

```tsx
const MODEL_OPTIONS = ['haiku', 'sonnet', 'opus'] as const;
type ModelOption = typeof MODEL_OPTIONS[number] | string;

// Helper to get initial matrix from agent model spec
function getModelMatrix(model: TemplateAgent['model'] | undefined): { simple: string; standard: string; complex: string } {
  const defaults = { simple: 'haiku', standard: 'sonnet', complex: 'opus' };
  if (!model) return defaults;
  if (typeof model === 'string') return { simple: model, standard: model, complex: model };
  return { simple: model.simple ?? 'haiku', standard: model.standard ?? 'sonnet', complex: model.complex ?? 'opus' };
}
```

Add the UI in the expanded section:
```tsx
{/* Model Routing */}
<div className="space-y-1.5">
  <label className="text-xs font-medium text-muted-foreground">Model Routing</label>
  <div className="space-y-1.5">
    {(['simple', 'standard', 'complex'] as const).map((level) => {
      const matrix = getModelMatrix(agent.model);
      return (
        <div key={level} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-16 capitalize">{level}</span>
          <Select
            value={matrix[level]}
            onValueChange={(value) => {
              const next = { ...matrix, [level]: value };
              onChange({ ...agent, model: next });
            }}
          >
            <SelectTrigger className="h-7 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="haiku">haiku</SelectItem>
              <SelectItem value="sonnet">sonnet</SelectItem>
              <SelectItem value="opus">opus</SelectItem>
            </SelectContent>
          </Select>
        </div>
      );
    })}
  </div>
</div>
```

**Note:** `TemplateAgent` in shared types doesn't have `model`. Since AgentCard works with `TemplateAgent`, add `model?` to it as well, or adapt to use `TemplateWorker` — check how AgentCard's props map. Adjust as needed.

**Step 3: Typecheck**
```bash
cd apps/frontend && pnpm typecheck
```
Expected: No errors

**Step 4: Commit**
```bash
git add apps/frontend/src/components/templates/AgentCard.tsx packages/shared/src/types/template.types.ts
git commit -m "feat: add complexity model matrix to AgentCard template editor"
```

---

## Task 11: Frontend — Ticket complexity badge

**Depends on:** Task 1, Task 7
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/ticket-detail/DetailsTab.tsx`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Modify: `apps/frontend/src/api/client.ts`

**Purpose:** Show an always-visible complexity badge in the ticket detail view. Clicking it opens a dropdown to change complexity.

**Step 1: Add API call to client.ts**

In `apps/frontend/src/api/client.ts`:
```typescript
async setTicketComplexity(projectId: string, ticketId: string, complexity: 'simple' | 'standard' | 'complex') {
  return this.patch(`/api/projects/${projectId}/tickets/${ticketId}/complexity`, { complexity });
}
```

**Step 2: Add mutation to queries.ts**

```typescript
export function useSetTicketComplexity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ticketId, complexity }: {
      projectId: string;
      ticketId: string;
      complexity: 'simple' | 'standard' | 'complex'
    }) => api.setTicketComplexity(projectId, ticketId, complexity),
    onSuccess: (_, { projectId, ticketId }) => {
      queryClient.invalidateQueries({ queryKey: ['ticket', projectId, ticketId] });
    },
  });
}
```

**Step 3: Add ComplexityBadge component inline in DetailsTab.tsx**

```tsx
const COMPLEXITY_STYLES = {
  simple: 'bg-muted text-muted-foreground',
  standard: 'bg-blue-500/15 text-blue-400',
  complex: 'bg-amber-500/15 text-amber-400',
} as const;

function ComplexityBadge({
  complexity,
  onChange
}: {
  complexity: 'simple' | 'standard' | 'complex';
  onChange: (c: 'simple' | 'standard' | 'complex') => void
}) {
  return (
    <Select value={complexity} onValueChange={onChange}>
      <SelectTrigger className={cn('h-6 w-auto border-0 px-2 text-xs font-medium rounded-full', COMPLEXITY_STYLES[complexity])}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="simple">simple</SelectItem>
        <SelectItem value="standard">standard</SelectItem>
        <SelectItem value="complex">complex</SelectItem>
      </SelectContent>
    </Select>
  );
}
```

Wire up in DetailsTab, adding the badge to the ticket metadata row.

**Step 4: Typecheck**
```bash
cd apps/frontend && pnpm typecheck
```
Expected: No errors

**Step 5: Commit**
```bash
git add apps/frontend/src/components/ticket-detail/DetailsTab.tsx apps/frontend/src/hooks/queries.ts apps/frontend/src/api/client.ts
git commit -m "feat: add complexity badge to ticket detail view"
```

---

## Task 12: Frontend — Task complexity dot

**Depends on:** Task 1, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/components/ticket-detail/TaskList.tsx`

**Purpose:** Show a small colored dot after each task name to indicate complexity. Read-only — agent-set only in MVP.

**Step 1: Add dot to TaskList.tsx**

Find where task names are rendered in `TaskList.tsx` and add a colored dot:

```tsx
const COMPLEXITY_DOT: Record<string, string> = {
  simple: 'bg-muted-foreground/40',
  standard: 'bg-blue-400',
  complex: 'bg-amber-400',
};

// In task row render:
<span className="truncate">{task.description}</span>
<span
  className={cn('ml-1.5 inline-block h-2 w-2 rounded-full shrink-0', COMPLEXITY_DOT[task.complexity ?? 'standard'])}
  title={`Complexity: ${task.complexity ?? 'standard'}`}
/>
```

**Step 2: Typecheck**
```bash
cd apps/frontend && pnpm typecheck
```
Expected: No errors

**Step 3: Commit**
```bash
git add apps/frontend/src/components/ticket-detail/TaskList.tsx
git commit -m "feat: add complexity dot to task list items"
```

---

## Task 13: Update workflow.json with complexity model matrix

**Depends on:** Task 1, Task 2
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/workflow.json`

**Purpose:** Apply the complexity model matrix to every agent in the default workflow template, giving the feature a working demonstration out of the box. Also updates the workflow schema to allow the `ComplexityModelMap` object form.

**Not In Scope:** Changing agent prompt files (Task 9). This is JSON config only.

**Routing rules applied:**
| Previous model | simple | standard | complex |
|---------------|--------|----------|---------|
| `opus` | `sonnet` | `opus` | `opus` |
| `sonnet` (judgment) | `haiku` | `sonnet` | `opus` |
| `haiku` | `haiku` | `haiku` | `sonnet` |

**Agent matrix assignments:**

| Agent | Old | New matrix |
|-------|-----|-----------|
| `refinement-agent` | opus | simple: sonnet, standard: opus, complex: opus |
| `adversarial-refinement-agent` | opus | simple: sonnet, standard: opus, complex: opus |
| `architect-agent` | opus | simple: sonnet, standard: opus, complex: opus |
| `adversarial-architect-agent` | opus | simple: sonnet, standard: opus, complex: opus |
| `specification-agent` | opus | simple: sonnet, standard: opus, complex: opus |
| `taskmaster-agent` | sonnet | simple: haiku, standard: sonnet, complex: opus |
| `task-review-agent` | haiku | simple: haiku, standard: haiku, complex: sonnet |
| `builder-agent` | haiku | simple: haiku, standard: haiku, complex: sonnet |
| `verify-spec-agent` | haiku | simple: haiku, standard: haiku, complex: sonnet |
| `verify-quality-agent` | haiku | simple: haiku, standard: haiku, complex: sonnet |
| `qa-agent` | haiku | simple: haiku, standard: haiku, complex: sonnet |
| `pr-agent` | (none) | (unchanged — uses Claude Code default) |

**Note:** This task was completed in the planning session (2026-03-09) before the model-resolver code supports the matrix syntax. Until Task 2 ships, the daemon will receive an unrecognized object form and fall back to its default model (graceful degradation). Once Task 2 ships, routing activates automatically.

**Step 1: Update workflow.schema.json to allow ComplexityModelMap**

In `apps/daemon/templates/workflows/workflow.schema.json`, find the `model` field definition and extend it to accept the object form:

```json
"model": {
  "oneOf": [
    { "type": "string" },
    {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "provider": { "type": "string" }
      },
      "required": ["id"]
    },
    {
      "type": "object",
      "properties": {
        "simple": { "type": "string" },
        "standard": { "type": "string" },
        "complex": { "type": "string" }
      },
      "additionalProperties": false
    }
  ]
}
```

**Step 2: Verify**
```bash
cd apps/daemon && node -e "
  const w = require('./templates/workflows/product-development/workflow.json');
  const agents = [];
  function walk(workers) { for (const w of workers) { if (w.type === 'agent') agents.push(w); if (w.workers) walk(w.workers); } }
  for (const p of w.phases) walk(p.workers || []);
  agents.forEach(a => console.log(a.id, '->', typeof a.model === 'object' ? JSON.stringify(a.model) : a.model ?? '(default)'));
"
```

**Step 3: Commit**
```bash
git add apps/daemon/templates/workflows/product-development/workflow.json apps/daemon/templates/workflows/workflow.schema.json
git commit -m "feat: apply complexity model matrix to product-development workflow template"
```

---

## End-to-End Verification

After all tasks complete:

1. Start daemon + frontend: `pnpm dev`
2. Create a ticket — verify complexity badge shows `standard`
3. Start a brainstorm — verify brainstorm agent calls `set_ticket_complexity`
4. Advance to Refinement — verify refinement agent re-evaluates and may update complexity
5. Advance to Build — verify taskmaster creates tasks with `complexity` field; dots appear
6. Check workflow.json: update `builder-agent` to use `{ "simple": "haiku", "standard": "sonnet", "complex": "opus" }` — verify build tasks use correct model based on complexity
7. Change ticket complexity via badge — verify next phase uses updated model

---

## Verification Record

**Overall status: WARN — all six passes returned WARN (no BLOCKED). Proceed with fixes noted below.**

| Pass | Verdict | Key Finding |
|------|---------|-------------|
| Plan Verification Checklist | WARN | 5 fixable issues: wrong type in Task 10, `this.patch()` doesn't exist in client.ts, `await` in Task 4 contradicts prose, skill dir needs mkdir, DetailsTab missing complexity source |
| Draft pass | WARN | `TemplateAgent` vs `TemplateWorker` naming conflict not resolved; Task 4 `await`/no-await contradiction; E2E missing AgentCard verification |
| Feasibility pass | WARN | Two architectural mismatches: (1) `ticket.tools.ts` MCP handler must use HTTP, not direct store import; (2) `client.ts` is a plain object—no `this.patch()` |
| Completeness pass | WARN | Gap C: `tasks.routes.ts` POST handler silently drops complexity—missing from Task 6 file list; Gap D: `workflow.json` not updated in any task; Gap E: daemon-local `Task` type needs `complexity` |
| Risk pass | WARN | HIGH risk: agent prompts call skill imperatively with no fallback if skill missing; MED: migration lacks idempotency guards from V8-V11 pattern |
| Optimality pass | WARN | Task 12 (dot) is MVP over-scope—cut; Task 10 (AgentCard) TemplateAgent type mismatch makes it harder than estimated; `getTask()` double-hit in session.service can be avoided via TaskContext |

---

### Required Fixes Before Implementation

**Fix 1 — Migration idempotency (Task 1)**
Split the two `ALTER TABLE` calls into separate `db.exec()` calls, each guarded by `PRAGMA table_info` check, matching V8-V11 pattern in `migrations.ts`.

**Fix 2 — Remove `await` from `getTask` (Task 4)**
The code snippet shows `await getTask(...)` but `getTask` is synchronous. Remove the `await`. Also note: pass `taskComplexity` directly—don't re-fetch if `TaskContext` is extended (see Fix 6).

**Fix 3 — `set_ticket_complexity` MCP tool uses HTTP (Task 5)**
`ticket.tools.ts` handlers call the daemon via `fetch()`, not direct store imports. The `set_ticket_complexity` handler must call the `PATCH /api/projects/:projectId/tickets/:ticketId/complexity` REST endpoint (Task 7's endpoint) rather than importing `updateTicket` directly.

**Fix 4 — `tasks.routes.ts` missing from Task 6**
Add to Task 6 file list: `apps/daemon/src/server/routes/tasks.routes.ts`. The POST task creation route must be updated to:
1. Read `complexity` from `req.body`
2. Pass it to `store.createTask(ticketId, phase, { description, body, complexity })`
Also update the `createTask()` helper inside `task.tools.ts` to serialize `complexity` in the fetch body.

**Fix 5 — `client.ts` pattern fix (Task 11)**
Replace `this.patch(...)` with the `request<T>()` pattern used throughout `client.ts`:
```typescript
setTicketComplexity: (projectId, ticketId, complexity) =>
  request<Ticket>(`/api/projects/${encodeURIComponent(projectId)}/tickets/${ticketId}/complexity`, {
    method: 'PATCH',
    body: JSON.stringify({ complexity })
  }),
```

**Fix 6 — Add `complexity` to `TaskContext` (optional, recommended)**
Rather than calling `getTask(taskContext.taskId)` again in `session.service.ts` (a second DB hit), extend `TaskContext` in `apps/daemon/src/types/orchestration.types.ts` with `complexity?: Complexity` and populate it in `buildTaskContext()` in `task-loop.ts`. Then Task 4 becomes: `const taskComplexity = taskContext?.complexity ?? ticket.complexity`.

**Fix 7 — Daemon-local `Task` type needs `complexity` (Task 1 or Task 3)**
Add `complexity: Complexity` to the daemon-local `Task` interface in `apps/daemon/src/types/task.types.ts` — not just to the shared package type. The task store imports from the daemon-local type.

**Fix 8 — `DetailsTab` needs complexity prop (Task 11)**
Add `complexity: Complexity` to `DetailsTabProps` and pass `ticket.complexity` from `TicketDetailPanel.tsx`. `Select` must also be imported in `DetailsTab.tsx`.

**Fix 9 — Agent prompt fallback (Task 9)**
Change imperative wording ("invoke the skill") to conditional: "If `potato:estimate-complexity` is available, invoke it. Otherwise, apply these heuristics directly: [table]." Include the full heuristics table inline in each prompt section so agents can act without the skill.

**Fix 10 — `workflow.json` update (Task 9)**
Add a step to update `apps/daemon/templates/workflows/product-development/workflow.json` to set at least `builder-agent`'s model to `{ "simple": "haiku", "standard": "sonnet", "complex": "opus" }` so the feature has a working demonstration in the default template.

---

### Recommended Scope Changes

- **Cut Task 12** (task complexity dot): Read-only cosmetic for MVP. Defer until there's a user request.
- **Consider deferring Task 10** (AgentCard model matrix): `AgentCard` works with `TemplateAgent` which has no `model` field; `model` is on the daemon-internal `AgentWorker`. Bridging this type mismatch is more work than estimated. Users can edit `workflow.json` directly for now.
- **Use positive key-presence check** in `isComplexityModelMap`: `'simple' in model || 'standard' in model || 'complex' in model` is more robust than `!('id' in model)`.

---

*Verification completed 2026-03-09. Passes: Checklist, Draft, Feasibility, Completeness, Risk, Optimality.*
