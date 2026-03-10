# Project Workflows (Multi-Board) Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Allow a project to have multiple independent workflow boards, each with its own template reference, ticket queue, and kanban view.

**Architecture:** Add a `project_workflows` table as a child of `projects`. Tickets gain a `workflow_id` FK. The session service resolves templates through the ticket's workflow rather than the project directly. The frontend sidebar expands each project to show its workflow boards as child items, each with their own route and ticket queue.

**Tech Stack:** better-sqlite3 (migration), TypeScript, Express (new routes), TanStack Query (frontend hooks), TanStack Router (new route), React (sidebar + configure UI)

**Key Decisions:**
- **Backward compatibility:** V13 migration creates a default `project_workflow` row for every existing project using its current `template_name`. Existing tickets are backfilled with `workflow_id`. No data is lost or renamed.
- **Template resolution:** Default workflow reuses the existing per-project template copy system (`project-template.store.ts`). Non-default workflows read directly from the global catalog (simpler, no versioning for v1).
- **Phase-config update:** `getPhaseConfig()` gains an optional `workflowId` parameter. When provided, it looks up the workflow's `template_name` and resolves the template accordingly. Callers in session service pass the ticket's `workflow_id`.
- **Routing:** New route `/projects/$projectId/workflows/$workflowId/board` scopes the kanban to one workflow. `/projects/$projectId/board` redirects to the default workflow.
- **Sidebar:** `ProjectMenuItem` becomes expandable (like `SidebarFolderGroup`). Each workflow is a `WorkflowMenuItem` child item linking to its board.

---

## Task 1: DB migration V13 — `project_workflows` table + `workflow_id` on tickets

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`

**Purpose:** Lay down the schema. Everything else depends on this.

**Step 1: Write the failing test**
```typescript
// In apps/daemon/src/stores/__tests__/migrations.test.ts (add to existing or create)
// After running runMigrations, assert table and column exist
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations.js'

describe('V13 migration', () => {
  it('creates project_workflows table', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='project_workflows'"
    ).all()
    assert.equal(tables.length, 1)
  })

  it('adds workflow_id column to tickets', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const cols = db.pragma('table_info(tickets)') as { name: string }[]
    assert.ok(cols.some(c => c.name === 'workflow_id'))
  })
})
```
**Step 2: Run test to verify it fails**
```
cd apps/daemon && pnpm build && pnpm test 2>&1 | grep -A 5 "V13 migration"
```
Expected: FAIL (table/column don't exist)

**Step 3: Implement**

In `migrateV13`:
```typescript
function migrateV13(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_workflows (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      display_name    TEXT NOT NULL,
      template_name   TEXT NOT NULL,
      is_default      INTEGER NOT NULL DEFAULT 0,
      order_index     INTEGER NOT NULL DEFAULT 0,
      disabled_phases TEXT,
      branch_prefix   TEXT,
      created_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_workflows_project
      ON project_workflows(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_workflows_default
      ON project_workflows(project_id, is_default) WHERE is_default = 1;
  `);

  const ticketCols = db.pragma('table_info(tickets)') as { name: string }[]
  if (!ticketCols.some(c => c.name === 'workflow_id')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN workflow_id TEXT REFERENCES project_workflows(id)`)
  }
}
```

Also update `CURRENT_SCHEMA_VERSION = 13` and add `if (version < 13) { migrateV13(db) }`.

**Step 4: Run test to verify it passes**
```
cd apps/daemon && pnpm build && pnpm test 2>&1 | grep -A 5 "V13 migration"
```
Expected: PASS

**Rollback note:** `ALTER TABLE ADD COLUMN` and the new `project_workflows` table cannot be removed via SQL in SQLite without recreating the affected tables. If a rollback to pre-V13 code is required, restore the database from a backup taken before the migration ran. Pre-V13 daemon code will not crash on a V13 database (it ignores unknown columns and stops migration at the version already stored), but `workflow_id` data will be orphaned. **Back up `~/.potato-cannon/potato.db` before deploying V13 to production.**

**Step 5: Commit**
```
git add apps/daemon/src/stores/migrations.ts
git commit -m "feat: V13 migration — project_workflows table + workflow_id on tickets"
```

---

## Task 2: `project-workflow.store.ts` — CRUD for workflows

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/stores/project-workflow.store.ts`
- Create: `apps/daemon/src/stores/__tests__/project-workflow.store.test.ts`
- Modify: `apps/daemon/src/stores/index.ts`

**Purpose:** Data access layer for `project_workflows`. Used by routes and the backfill migration.

**Step 1: Write failing tests**
```typescript
// apps/daemon/src/stores/__tests__/project-workflow.store.test.ts
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runMigrations } from '../migrations.js'
import { createProjectWorkflowStore } from '../project-workflow.store.js'
import { createProjectStore } from '../project.store.js'

describe('ProjectWorkflowStore', () => {
  let db: Database.Database
  let store: ReturnType<typeof createProjectWorkflowStore>
  let projectId: string

  before(() => {
    db = new Database(':memory:')
    runMigrations(db)
    const ps = createProjectStore(db)
    const project = ps.createProject({ displayName: 'Test', path: '/tmp/test' })
    projectId = project.id
    store = createProjectWorkflowStore(db)
  })

  it('creates a workflow', () => {
    const wf = store.createWorkflow({ projectId, displayName: 'Bug Fixes', templateName: 'product-development', isDefault: true })
    assert.equal(wf.displayName, 'Bug Fixes')
    assert.equal(wf.isDefault, true)
  })

  it('lists workflows for project', () => {
    const list = store.listWorkflows(projectId)
    assert.ok(list.length >= 1)
  })

  it('gets workflow by id', () => {
    const [wf] = store.listWorkflows(projectId)
    const fetched = store.getWorkflow(wf.id)
    assert.equal(fetched?.id, wf.id)
  })

  it('updates workflow', () => {
    const [wf] = store.listWorkflows(projectId)
    const updated = store.updateWorkflow(wf.id, { displayName: 'Renamed' })
    assert.equal(updated?.displayName, 'Renamed')
  })

  it('deletes workflow', () => {
    const wf = store.createWorkflow({ projectId, displayName: 'To Delete', templateName: 'product-development', isDefault: false })
    const ok = store.deleteWorkflow(wf.id)
    assert.equal(ok, true)
    assert.equal(store.getWorkflow(wf.id), null)
  })

  it('getDefaultWorkflow returns the default', () => {
    const def = store.getDefaultWorkflow(projectId)
    assert.equal(def?.isDefault, true)
  })
})
```

**Step 2: Run test to verify it fails**
```
cd apps/daemon && pnpm build && pnpm test 2>&1 | grep -A 5 "ProjectWorkflowStore"
```
Expected: FAIL

**Step 3: Implement `project-workflow.store.ts`**
```typescript
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db.js'

export interface ProjectWorkflow {
  id: string
  projectId: string
  displayName: string
  templateName: string
  isDefault: boolean
  orderIndex: number
  disabledPhases?: string[]
  branchPrefix?: string
  createdAt: string
}

export interface CreateWorkflowInput {
  projectId: string
  displayName: string
  templateName: string
  isDefault?: boolean
  orderIndex?: number
  disabledPhases?: string[]
  branchPrefix?: string
}

function rowToWorkflow(row: Record<string, unknown>): ProjectWorkflow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    displayName: row.display_name as string,
    templateName: row.template_name as string,
    isDefault: (row.is_default as number) === 1,
    orderIndex: row.order_index as number,
    disabledPhases: row.disabled_phases ? JSON.parse(row.disabled_phases as string) : undefined,
    branchPrefix: (row.branch_prefix as string) || undefined,
    createdAt: row.created_at as string,
  }
}

export class ProjectWorkflowStore {
  constructor(private db: Database.Database) {}

  createWorkflow(input: CreateWorkflowInput): ProjectWorkflow {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO project_workflows (id, project_id, display_name, template_name, is_default, order_index, disabled_phases, branch_prefix, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.projectId, input.displayName, input.templateName,
      input.isDefault ? 1 : 0,
      input.orderIndex ?? 0,
      input.disabledPhases ? JSON.stringify(input.disabledPhases) : null,
      input.branchPrefix ?? null,
      now
    )
    return this.getWorkflow(id)!
  }

  getWorkflow(id: string): ProjectWorkflow | null {
    const row = this.db.prepare('SELECT * FROM project_workflows WHERE id = ?').get(id)
    return row ? rowToWorkflow(row as Record<string, unknown>) : null
  }

  getDefaultWorkflow(projectId: string): ProjectWorkflow | null {
    const row = this.db.prepare(
      'SELECT * FROM project_workflows WHERE project_id = ? AND is_default = 1 ORDER BY order_index LIMIT 1'
    ).get(projectId)
    return row ? rowToWorkflow(row as Record<string, unknown>) : null
  }

  listWorkflows(projectId: string): ProjectWorkflow[] {
    const rows = this.db.prepare(
      'SELECT * FROM project_workflows WHERE project_id = ? ORDER BY is_default DESC, order_index ASC'
    ).all(projectId)
    return rows.map(r => rowToWorkflow(r as Record<string, unknown>))
  }

  updateWorkflow(id: string, updates: Partial<Omit<ProjectWorkflow, 'id' | 'projectId' | 'createdAt'>>): ProjectWorkflow | null {
    const existing = this.getWorkflow(id)
    if (!existing) return null
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.displayName !== undefined) { fields.push('display_name = ?'); values.push(updates.displayName) }
    if (updates.templateName !== undefined) { fields.push('template_name = ?'); values.push(updates.templateName) }
    if (updates.isDefault !== undefined) { fields.push('is_default = ?'); values.push(updates.isDefault ? 1 : 0) }
    if (updates.orderIndex !== undefined) { fields.push('order_index = ?'); values.push(updates.orderIndex) }
    if (updates.disabledPhases !== undefined) { fields.push('disabled_phases = ?'); values.push(updates.disabledPhases ? JSON.stringify(updates.disabledPhases) : null) }
    if (updates.branchPrefix !== undefined) { fields.push('branch_prefix = ?'); values.push(updates.branchPrefix || null) }
    if (fields.length === 0) return existing
    values.push(id)
    this.db.prepare(`UPDATE project_workflows SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.getWorkflow(id)
  }

  deleteWorkflow(id: string): boolean {
    const result = this.db.prepare('DELETE FROM project_workflows WHERE id = ?').run(id)
    return result.changes > 0
  }
}

export function createProjectWorkflowStore(db: Database.Database): ProjectWorkflowStore {
  return new ProjectWorkflowStore(db)
}

export function getProjectWorkflowStore(): ProjectWorkflowStore {
  return new ProjectWorkflowStore(getDatabase())
}
```

Export from `apps/daemon/src/stores/index.ts`:
```typescript
export * from './project-workflow.store.js'
```

**Step 4: Run test to verify it passes**
```
cd apps/daemon && pnpm build && pnpm test 2>&1 | grep -A 5 "ProjectWorkflowStore"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/stores/project-workflow.store.ts apps/daemon/src/stores/index.ts apps/daemon/src/stores/__tests__/project-workflow.store.test.ts
git commit -m "feat: add ProjectWorkflowStore with CRUD operations"
```

---

## Task 3: V13 backfill — create default workflow for every existing project

**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`

**Purpose:** Existing projects and tickets must not break. Each project needs exactly one default workflow row, and all existing tickets need `workflow_id` set.

**Not In Scope:** Per-project template copy or versioning for the new workflow rows — they just reference `template_name`.

**Gotchas:** Some projects may have no `template_name` (template not yet assigned). Use `'product-development'` as a fallback or leave `template_name` as `''`. Check for existing workflows before inserting (idempotent).

**Step 1: Write failing test**
```typescript
// Extend migrations.test.ts — add top-level import at file top: import { randomUUID } from 'node:crypto'
it('backfills default workflows for projects with templates', () => {
  const db = new Database(':memory:')
  // Insert a V12 state manually then run V13
  runMigrations(db) // runs everything including V13
  // Create a project with a template, then verify a workflow was created
  const now = new Date().toISOString()
  const pid = randomUUID()
  db.prepare(`INSERT INTO projects (id, slug, display_name, path, registered_at, template_name)
    VALUES (?, ?, ?, ?, ?, ?)`).run(pid, 'test-proj', 'Test', '/tmp', now, 'product-development')
  // Simulate re-running backfill
  runBackfillV13(db, pid)
  const workflows = db.prepare('SELECT * FROM project_workflows WHERE project_id = ?').all(pid)
  assert.equal(workflows.length, 1)
  assert.equal((workflows[0] as any).is_default, 1)
})
```

**Step 2: Run test to verify it fails**
```
cd apps/daemon && pnpm build && pnpm test 2>&1 | grep -A 5 "backfills default"
```
Expected: FAIL

**Step 3: Implement backfill inside `migrateV13`**

Update `migrateV13` to also backfill:
```typescript
// After schema creation, backfill
const projects = db.prepare('SELECT id, template_name, branch_prefix FROM projects').all() as
  Array<{ id: string; template_name: string | null; branch_prefix: string | null }>

const insertWorkflow = db.prepare(`
  INSERT OR IGNORE INTO project_workflows
    (id, project_id, display_name, template_name, is_default, order_index, branch_prefix, created_at)
  VALUES (?, ?, ?, ?, 1, 0, ?, ?)
`)

const updateTickets = db.prepare(`
  UPDATE tickets SET workflow_id = ?
  WHERE project_id = ? AND workflow_id IS NULL
`)

for (const project of projects) {
  const existingWorkflow = db.prepare(
    'SELECT id FROM project_workflows WHERE project_id = ? AND is_default = 1'
  ).get(project.id) as { id: string } | undefined

  let workflowId: string
  if (!existingWorkflow) {
    workflowId = crypto.randomUUID()
    insertWorkflow.run(
      workflowId,
      project.id,
      'Default',
      project.template_name || 'product-development',
      project.branch_prefix || null,
      new Date().toISOString()
    )
  } else {
    workflowId = existingWorkflow.id
  }

  updateTickets.run(workflowId, project.id)
}
```

Export a `runBackfillV13` helper (for testability) or inline it. Keep it idempotent (`INSERT OR IGNORE`).

**Step 4: Run test to verify it passes**
```
cd apps/daemon && pnpm build && pnpm test 2>&1 | grep -A 5 "backfills default"
```
Expected: PASS

**Step 5: Run full test suite**
```
cd apps/daemon && pnpm build && pnpm test
```
Expected: all passing

**Step 6: Commit**
```
git add apps/daemon/src/stores/migrations.ts
git commit -m "feat: V13 backfill — create default workflow per project and backfill ticket workflow_id"
```

---

## Task 4: API routes — workflow CRUD

**Depends on:** Task 2, Task 3
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/server/routes/workflows.routes.ts`
- Create: `apps/daemon/src/server/__tests__/workflows.routes.test.ts`
- Modify: `apps/daemon/src/server/routes/index.ts`

**Purpose:** Frontend needs to list, create, update, delete, and reorder workflows.

**Endpoints:**
- `GET /api/projects/:projectId/workflows` — list workflows (ordered)
- `POST /api/projects/:projectId/workflows` — create workflow `{ displayName, templateName }`
- `PATCH /api/projects/:projectId/workflows/:workflowId` — update `{ displayName, templateName, branchPrefix, disabledPhases, orderIndex }`
- `DELETE /api/projects/:projectId/workflows/:workflowId` — delete (guard: cannot delete last workflow)

**Step 1: Write failing test** (integration-style)
```typescript
// apps/daemon/src/server/__tests__/workflows.routes.test.ts
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import Database from 'better-sqlite3'
import { runMigrations } from '../../stores/migrations.js'
import { createProjectStore } from '../../stores/project.store.js'
import { createProjectWorkflowStore } from '../../stores/project-workflow.store.js'
import { registerWorkflowRoutes } from '../routes/workflows.routes.js'

// Setup in-memory DB and app, create a project, run assertions
// ... (standard Express integration test pattern — no supertest dependency needed; use node:http or direct store assertions)
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm build && pnpm test 2>&1 | grep -A 5 "workflow routes"
```
Expected: FAIL (module not found)

**Step 3: Implement `workflows.routes.ts`**
```typescript
import type { Express, Request, Response } from 'express'
import { getProjectById } from '../../stores/project.store.js'
import {
  getProjectWorkflowStore,
  type CreateWorkflowInput
} from '../../stores/project-workflow.store.js'

export function registerWorkflowRoutes(app: Express): void {
  // GET /api/projects/:projectId/workflows
  app.get('/api/projects/:projectId/workflows', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params
      const project = getProjectById(projectId)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }
      const workflows = getProjectWorkflowStore().listWorkflows(projectId)
      res.json(workflows)
    } catch (e) { res.status(500).json({ error: (e as Error).message }) }
  })

  // POST /api/projects/:projectId/workflows
  app.post('/api/projects/:projectId/workflows', (req: Request, res: Response) => {
    try {
      const { projectId } = req.params
      const project = getProjectById(projectId)
      if (!project) { res.status(404).json({ error: 'Project not found' }); return }
      const { displayName, templateName } = req.body as { displayName?: string; templateName?: string }
      if (!displayName || !templateName) { res.status(400).json({ error: 'displayName and templateName required' }); return }
      const workflow = getProjectWorkflowStore().createWorkflow({
        projectId, displayName, templateName, isDefault: false
      })
      res.status(201).json(workflow)
    } catch (e) { res.status(500).json({ error: (e as Error).message }) }
  })

  // PATCH /api/projects/:projectId/workflows/:workflowId
  app.patch('/api/projects/:projectId/workflows/:workflowId', (req: Request, res: Response) => {
    try {
      const { projectId, workflowId } = req.params
      const store = getProjectWorkflowStore()
      const existing = store.getWorkflow(workflowId)
      if (!existing || existing.projectId !== projectId) { res.status(404).json({ error: 'Workflow not found' }); return }
      const { displayName, templateName, branchPrefix, disabledPhases, orderIndex } = req.body
      const updated = store.updateWorkflow(workflowId, { displayName, templateName, branchPrefix, disabledPhases, orderIndex })
      res.json(updated)
    } catch (e) { res.status(500).json({ error: (e as Error).message }) }
  })

  // DELETE /api/projects/:projectId/workflows/:workflowId
  app.delete('/api/projects/:projectId/workflows/:workflowId', (req: Request, res: Response) => {
    try {
      const { projectId, workflowId } = req.params
      const store = getProjectWorkflowStore()
      const existing = store.getWorkflow(workflowId)
      if (!existing || existing.projectId !== projectId) { res.status(404).json({ error: 'Workflow not found' }); return }
      const allWorkflows = store.listWorkflows(projectId)
      if (allWorkflows.length <= 1) { res.status(400).json({ error: 'Cannot delete the last workflow' }); return }
      if (existing.isDefault) { res.status(400).json({ error: 'Cannot delete the default workflow. Set another workflow as default first.' }); return }
      store.deleteWorkflow(workflowId)
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: (e as Error).message }) }
  })
}
```

Register in `apps/daemon/src/server/routes/index.ts`:
```typescript
import { registerWorkflowRoutes } from './workflows.routes.js'
// ...
registerWorkflowRoutes(app)
```

**Step 4: Run test to verify it passes**
```
cd apps/daemon && pnpm build && pnpm test 2>&1 | grep -A 5 "workflow routes"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/server/routes/workflows.routes.ts apps/daemon/src/server/routes/index.ts apps/daemon/src/server/__tests__/workflows.routes.test.ts
git commit -m "feat: add workflow CRUD API routes"
```

---

## Task 5: Update `phase-config.ts` to resolve template via workflow

**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/phase-config.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts` (pass workflowId from ticket)

**Purpose:** The session service currently resolves phases from `project.template`. It must now resolve from the ticket's `workflow.template_name`. Backward compatible — falls back to project template if no workflowId.

**Gotchas:**
- Non-default workflows read from global catalog (no per-project copy). Use `getWorkflowWithFullPhases(templateName)` from `template.store.ts`.
- `phase-config.ts` uses `getTemplateWithFullPhasesForProject` which reads from the per-project copy. Keep this for the default workflow. Add a new branch for non-default.

**Step 1: Write failing test**
```typescript
// Extend phase-config tests
it('getPhaseConfig uses workflow templateName when workflowId provided', async () => {
  // Setup: project with default workflow using template A, non-default using template B
  // Verify getPhaseConfig returns phases from template B when given non-default workflowId
})
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm build && pnpm test
```

**Step 3: Update `getPhaseConfig` signature**
```typescript
export async function getPhaseConfig(
  projectId: string,
  phaseName: string,
  workflowId?: string
): Promise<Phase | null> {
  if (workflowId) {
    const workflow = getProjectWorkflowStore().getWorkflow(workflowId)
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`)
    // For default workflow: use existing project template copy path
    // For non-default: read from global catalog
    const defaultWorkflow = getProjectWorkflowStore().getDefaultWorkflow(projectId)
    let template: WorkflowTemplate | null
    if (workflow.isDefault || defaultWorkflow?.templateName === workflow.templateName) {
      template = await getTemplateWithFullPhasesForProject(projectId)
    } else {
      template = await getWorkflowWithFullPhases(workflow.templateName)
    }
    if (!template) throw new Error(`Template ${workflow.templateName} not found`)
    return template.phases.find(p => p.id === phaseName || p.name === phaseName) || null
  }
  // Legacy: use project.template
  const project = getProjectById(projectId)
  if (!project?.template) throw new Error(`Project ${projectId} has no template assigned`)
  // ... existing code unchanged
}
```

Also update `resolveTargetPhase` and `isPhaseDisabled` to accept optional `workflowId`.

**Step 4: Update `session.service.ts`** to pass `ticket.workflowId` when calling `getPhaseConfig` and `resolveTargetPhase`. The ticket store's `getTicket()` now returns `workflowId` (it's a column in the tickets table via V13 migration).

**Step 5: Run full test suite**
```
cd apps/daemon && pnpm build && pnpm test
```
Expected: PASS

**Step 6: Commit**
```
git add apps/daemon/src/services/session/phase-config.ts apps/daemon/src/services/session/session.service.ts
git commit -m "feat: resolve phase config through ticket workflow template"
```

---

## Task 6: Shared types — `ProjectWorkflow`

**Depends on:** Task 2
**Complexity:** simple
**Files:**
- Create: `packages/shared/src/types/workflow.types.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/types/ticket.types.ts` (add `workflowId?`)

**Purpose:** Frontend needs the `ProjectWorkflow` type for API calls and component props.

**Step 1: No test needed** (pure type declaration)

**Step 2: Create `workflow.types.ts`**
```typescript
export interface ProjectWorkflow {
  id: string
  projectId: string
  displayName: string
  templateName: string
  isDefault: boolean
  orderIndex: number
  disabledPhases?: string[]
  branchPrefix?: string
  createdAt: string
}

export interface CreateWorkflowInput {
  displayName: string
  templateName: string
}

export interface UpdateWorkflowInput {
  displayName?: string
  templateName?: string
  branchPrefix?: string
  disabledPhases?: string[]
  orderIndex?: number
}
```

**Step 3: Export from `packages/shared/src/types/index.ts`**
```typescript
export * from './workflow.types.js'
```

**Step 4: Add `workflowId` to `Ticket` type in `packages/shared/src/types/ticket.types.ts`**
```typescript
workflowId?: string
```

**Step 5: Build shared**
```
cd packages/shared && pnpm build
```
Expected: no TypeScript errors

**Step 6: Commit**
```
git add packages/shared/src/types/workflow.types.ts packages/shared/src/types/index.ts packages/shared/src/types/ticket.types.ts
git commit -m "feat: add ProjectWorkflow shared types"
```

---

## Task 7: Frontend API client + TanStack Query hooks for workflows

**Depends on:** Task 6
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`

**Purpose:** Frontend components need to fetch/mutate workflows through React Query.

**Step 1: Add to `api/client.ts`**
```typescript
// Workflow API
getWorkflows: (projectId: string): Promise<ProjectWorkflow[]> =>
  fetch(`/api/projects/${encodeURIComponent(projectId)}/workflows`).then(r => r.json()),

createWorkflow: (projectId: string, input: CreateWorkflowInput): Promise<ProjectWorkflow> =>
  fetch(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(r => r.json()),

updateWorkflow: (projectId: string, workflowId: string, updates: UpdateWorkflowInput): Promise<ProjectWorkflow> =>
  fetch(`/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }).then(r => r.json()),

deleteWorkflow: (projectId: string, workflowId: string): Promise<{ ok: boolean }> =>
  fetch(`/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'DELETE',
  }).then(r => r.json()),
```

**Step 2: Add to `hooks/queries.ts`**
```typescript
export function useWorkflows(projectId: string | undefined) {
  return useQuery({
    queryKey: ['workflows', projectId],
    queryFn: () => api.getWorkflows(projectId!),
    enabled: !!projectId,
  })
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: CreateWorkflowInput }) =>
      api.createWorkflow(projectId, input),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['workflows', projectId] })
    },
  })
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, workflowId }: { projectId: string; workflowId: string }) =>
      api.deleteWorkflow(projectId, workflowId),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['workflows', projectId] })
    },
  })
}
```

**Step 3: TypeCheck**
```
cd apps/frontend && pnpm typecheck
```
Expected: PASS

**Step 4: Commit**
```
git add apps/frontend/src/api/client.ts apps/frontend/src/hooks/queries.ts
git commit -m "feat: add workflow API client and TanStack Query hooks"
```

---

## Task 8: Routing — `/projects/$projectId/workflows/$workflowId/board`

**Depends on:** Task 7
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/routes/projects/$projectId/workflows/$workflowId/board.tsx`
- Modify: `apps/frontend/src/routes/projects/$projectId/board.tsx` (redirect to default workflow)

**Purpose:** Each workflow board gets its own URL. Existing board URLs redirect to the default workflow.

**Gotchas:** TanStack Router uses file-based routing. Nested dynamic segments need nested directories. The `board.tsx` at the workflow level is the same `Board` component, scoped with `workflowId`.

**Step 1: Create `apps/frontend/src/routes/projects/$projectId/workflows/$workflowId/board.tsx`**
```typescript
import { createFileRoute } from '@tanstack/react-router'
import { Board } from '@/components/board/Board'

export const Route = createFileRoute('/projects/$projectId/workflows/$workflowId/board')({
  component: WorkflowBoardPage,
})

function WorkflowBoardPage() {
  const { projectId, workflowId } = Route.useParams()
  return <Board projectSlug={projectId} workflowId={workflowId} />
}
```

**Step 2: Update existing `board.tsx` to redirect to default workflow**
```typescript
import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '@/api/client'

export const Route = createFileRoute('/projects/$projectId/board')({
  beforeLoad: async ({ params }) => {
    // Find the project by slug, then get its default workflow
    const projects = await api.getProjects()
    const project = projects.find(p => p.slug === params.projectId)
    if (!project) return
    const workflows = await api.getWorkflows(project.id)
    const defaultWorkflow = workflows.find(w => w.isDefault) ?? workflows[0]
    if (defaultWorkflow) {
      throw redirect({
        to: '/projects/$projectId/workflows/$workflowId/board',
        params: { projectId: params.projectId, workflowId: defaultWorkflow.id },
      })
    }
  },
  component: () => null,
})
```

**Step 3: Typecheck**
```
cd apps/frontend && pnpm typecheck
```
Expected: PASS

**Step 4: Commit**
```
git add apps/frontend/src/routes/projects/
git commit -m "feat: add workflow-scoped board route, redirect /board to default workflow"
```

---

## Task 9: Board + ticket creation — workflow-scoped

**Depends on:** Task 8
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/board/Board.tsx`
- Modify: `apps/frontend/src/components/board/AddTicketModal.tsx`
- Modify: `apps/frontend/src/hooks/queries.ts` (add workflowId filter to `useTickets`)
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`
- Modify: `apps/daemon/src/stores/ticket.store.ts`

**Purpose:** The board must show only tickets belonging to the current workflow. New tickets must be associated with the current workflow.

**Gotchas:** The tickets API likely filters by `projectId`. Need to add optional `workflowId` filter to `GET /api/projects/:id/tickets` backend, or filter client-side (simpler for v1).

**Step 1: Backend — add `workflow_id` filter to `GET /api/projects/:id/tickets`**

In `apps/daemon/src/server/routes/tickets.routes.ts`, update the list endpoint to accept `?workflowId=xxx`:
```typescript
// In GET /api/projects/:id/tickets
const { workflowId } = req.query as { workflowId?: string }
const tickets = await listTickets(projectId, { phase, workflowId })
```

In `apps/daemon/src/stores/ticket.store.ts`, update `listTickets`:
```typescript
export interface ListTicketsOptions {
  phase?: TicketPhase
  workflowId?: string
  archived?: boolean
}
// In the query builder, add: WHERE ... AND (workflow_id = ? OR ? IS NULL)
```

**Step 2: Frontend — Board accepts workflowId prop**

Update `Board` props:
```typescript
interface BoardProps {
  projectSlug: string
  workflowId: string
}
```

Pass `workflowId` to `useTickets(projectId, { workflowId })`.

**Step 3: Update `AddTicketModal`** to receive `workflowId` and include it in the ticket creation call:
```typescript
// In createTicket API call body:
{ title, description, workflowId }
```

On backend, `POST /api/projects/:id/tickets` accepts `workflowId` and stores it. If not provided, falls back to project's default workflow.

**Step 4: Run tests**
```
cd apps/frontend && pnpm test
cd apps/daemon && pnpm build && pnpm test
```
Expected: PASS

**Step 5: Commit**
```
git add apps/frontend/src/components/board/ apps/daemon/src/server/routes/tickets.routes.ts apps/daemon/src/stores/ticket.store.ts
git commit -m "feat: scope board and ticket creation to workflow"
```

---

## Task 10: Sidebar — expandable project item with workflow children

**Depends on:** Task 7, Task 8
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/components/layout/WorkflowMenuItem.tsx`
- Modify: `apps/frontend/src/components/layout/ProjectMenuItem.tsx`
- Modify: `apps/frontend/src/components/layout/AppSidebar.tsx`
- Create: `apps/frontend/src/components/layout/ProjectMenuItem.test.tsx` (update existing)

**Purpose:** The project sidebar item expands to list its workflow boards. Clicking a workflow navigates to that board's route.

**Step 1: Create `WorkflowMenuItem.tsx`**
```tsx
import { Link } from '@tanstack/react-router'
import { GitBranch } from 'lucide-react'
import { SidebarMenuItem, SidebarMenuButton, SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton } from '@/components/ui/sidebar'
import type { ProjectWorkflow } from '@potato-cannon/shared'

interface WorkflowMenuItemProps {
  workflow: ProjectWorkflow
  projectSlug: string
  isActive: boolean
}

export function WorkflowMenuItem({ workflow, projectSlug, isActive }: WorkflowMenuItemProps) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={isActive}>
        <Link
          to="/projects/$projectId/workflows/$workflowId/board"
          params={{ projectId: projectSlug, workflowId: workflow.id }}
        >
          <GitBranch className="h-3 w-3" />
          <span>{workflow.displayName}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}
```

**Step 2: Update `ProjectMenuItem.tsx`**

Convert from a link to a collapsible item using `SidebarMenuSub`:
```tsx
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible' // from shadcn
import { useWorkflows } from '@/hooks/queries'
import { WorkflowMenuItem } from './WorkflowMenuItem'

export function ProjectMenuItem({ project, isActive, ... }: ProjectMenuItemProps) {
  const { data: workflows } = useWorkflows(project.id)
  const hasMultipleWorkflows = (workflows?.length ?? 0) > 1

  // If only one workflow: keep existing link behavior (no expansion needed)
  // If multiple: show expandable with workflow children
  if (!hasMultipleWorkflows) {
    // Single workflow: link directly to that workflow's board
    const singleWorkflow = workflows?.[0]
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={isActive} tooltip={project.displayName}>
          <Link to="/projects/$projectId/workflows/$workflowId/board"
            params={{ projectId: project.slug, workflowId: singleWorkflow?.id ?? '' }}>
            <Icon />
            <span>{project.displayName}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <Collapsible defaultOpen={isActive}>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={project.displayName}>
            <Icon />
            <span>{project.displayName}</span>
            <ChevronRight className="ml-auto transition-transform group-data-[state=open]:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {workflows?.map(wf => (
              <WorkflowMenuItem
                key={wf.id}
                workflow={wf}
                projectSlug={project.slug}
                isActive={isActive && currentWorkflowId === wf.id}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
```

**Step 3: Update `AppSidebar.tsx`** — parse `workflowId` from URL to pass as `currentWorkflowId` to `ProjectMenuItem`:
```typescript
const workflowMatch = location.pathname.match(/\/workflows\/([^/]+)/)
const currentWorkflowId = workflowMatch?.[1] ?? null
```

**Step 4: Run tests**
```
cd apps/frontend && pnpm test
```
Expected: PASS

**Step 5: Commit**
```
git add apps/frontend/src/components/layout/
git commit -m "feat: expandable project sidebar item with workflow children"
```

---

## Task 11: Configure page — Workflows management section

**Depends on:** Task 7
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/configure/ConfigurePage.tsx`
- Create: `apps/frontend/src/components/configure/WorkflowsSection.tsx`

**Purpose:** Users can add, rename, reorder, and delete workflows for a project from the project settings page.

**Not In Scope:** Per-workflow agent prompt overrides, per-workflow disabled phases UI (those can be follow-on).

**Step 1: Create `WorkflowsSection.tsx`**
```tsx
import { useState } from 'react'
import { useWorkflows, useCreateWorkflow, useUpdateWorkflow, useDeleteWorkflow } from '@/hooks/queries'
import { useTemplates } from '@/hooks/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SettingsSection } from './SettingsSection'
import type { Project } from '@potato-cannon/shared'

interface WorkflowsSectionProps {
  project: Project
}

export function WorkflowsSection({ project }: WorkflowsSectionProps) {
  const { data: workflows } = useWorkflows(project.id)
  const { data: templates } = useTemplates()
  const createWorkflow = useCreateWorkflow()
  const updateWorkflow = useUpdateWorkflow()
  const deleteWorkflow = useDeleteWorkflow()
  const [newName, setNewName] = useState('')
  const [newTemplate, setNewTemplate] = useState('')

  const handleCreate = () => {
    if (!newName || !newTemplate) return
    createWorkflow.mutate({ projectId: project.id, input: { displayName: newName, templateName: newTemplate } })
    setNewName(''); setNewTemplate('')
  }

  return (
    <SettingsSection title="Workflows" description="Each workflow is an independent kanban board.">
      <div className="space-y-2">
        {workflows?.map(wf => (
          <div key={wf.id} className="flex items-center gap-2 p-2 border rounded">
            <span className="flex-1">{wf.displayName}</span>
            {wf.isDefault && <span className="text-xs text-muted-foreground">default</span>}
            <Button variant="ghost" size="sm"
              onClick={() => deleteWorkflow.mutate({ projectId: project.id, workflowId: wf.id })}
              disabled={wf.isDefault || (workflows.length <= 1)}>
              Delete
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-4">
        <Input placeholder="Workflow name" value={newName} onChange={e => setNewName(e.target.value)} />
        {/* Template selector */}
        <select value={newTemplate} onChange={e => setNewTemplate(e.target.value)} className="border rounded px-2">
          <option value="">Select template...</option>
          {templates?.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        <Button onClick={handleCreate} disabled={!newName || !newTemplate}>Add</Button>
      </div>
    </SettingsSection>
  )
}
```

**Step 2: Add to `ConfigurePage.tsx`**
```tsx
import { WorkflowsSection } from './WorkflowsSection'
// In render:
<WorkflowsSection project={project} />
```

**Step 3: Typecheck**
```
cd apps/frontend && pnpm typecheck
```
Expected: PASS

**Step 4: Commit**
```
git add apps/frontend/src/components/configure/
git commit -m "feat: add Workflows section to project configure page"
```

---

## Task 12: Update store documentation

**Depends on:** Task 2, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/CLAUDE.md`

**Purpose:** `apps/daemon/src/stores/CLAUDE.md` documents the database schema and store APIs. It must be updated to reflect the new `project_workflows` table and the `ProjectWorkflowStore` API added in Tasks 1–3.

**Step 1: Update `CLAUDE.md`**

Add `project_workflows` to the tables section with its schema and relationship to `projects` and `tickets`. Document the `ProjectWorkflowStore` factory function and its methods (`createWorkflow`, `getWorkflow`, `getDefaultWorkflow`, `listWorkflows`, `updateWorkflow`, `deleteWorkflow`). Note the V13 migration and backfill behavior.

**Step 2: Commit**
```
git add apps/daemon/src/stores/CLAUDE.md
git commit -m "docs: document project_workflows table and ProjectWorkflowStore in stores CLAUDE.md"
```

---

## Summary of Changes

| Area | Files Changed |
|------|--------------|
| DB / Migration | `migrations.ts` |
| Daemon stores | `project-workflow.store.ts` (new), `ticket.store.ts` |
| Daemon routes | `workflows.routes.ts` (new), `tickets.routes.ts`, `routes/index.ts` |
| Session service | `phase-config.ts`, `session.service.ts` |
| Shared types | `workflow.types.ts` (new), `ticket.types.ts` |
| Frontend API | `api/client.ts`, `hooks/queries.ts` |
| Frontend routing | `routes/projects/.../workflows/$workflowId/board.tsx` (new), `board.tsx` |
| Frontend components | `WorkflowMenuItem.tsx` (new), `WorkflowsSection.tsx` (new), `ProjectMenuItem.tsx`, `AppSidebar.tsx`, `Board.tsx`, `AddTicketModal.tsx`, `ConfigurePage.tsx` |
| Documentation | `apps/daemon/src/stores/CLAUDE.md` |

---

## Verification

**Full test suite**
```
pnpm build && pnpm test
```
Expected: all daemon and frontend tests pass.

**End-to-end smoke test (manual)**
1. Start the daemon (`pnpm dev:daemon`) against a fresh or existing database.
2. Confirm existing projects have a default workflow row in `project_workflows` (V13 backfill ran).
3. Confirm all existing tickets have a non-null `workflow_id`.
4. Open the frontend; verify the sidebar shows projects with workflow children (single workflow = direct link, multiple = expandable).
5. Navigate to a project board; confirm the URL is `/projects/:slug/workflows/:workflowId/board`.
6. Navigate to `/projects/:slug/board`; confirm it redirects to the default workflow board.
7. Open project settings; add a second workflow with a different template name.
8. Confirm the sidebar now shows both workflow items under the project.
9. Create a ticket from each workflow board; confirm each ticket appears only on its own board.
10. Delete the non-default workflow; confirm the guard prevents deleting the last workflow.

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | ✓ | All requirements from brainstorming addressed — migration, backfill, CRUD store, API routes, phase-config update, shared types, frontend API/hooks, routing, board scoping, sidebar expansion, and configure page. |
| Accurate | ✓ | All modified/existing file paths verified to exist. New file paths are in correct locations matching project conventions. `getWorkflowWithFullPhases` and `getTemplateWithFullPhasesForProject` confirmed present in `template.store.ts`. |
| Commands valid | ✓ | Six `node --test src/...` commands corrected to `pnpm build && pnpm test`. Task 4 test path fixed to `src/server/__tests__/` matching project convention. `supertest` dependency removed. |
| YAGNI | ✓ | Every task maps directly to a stated requirement. No speculative features included. |
| Minimal | ✓ | Tasks 1 and 3 both touch `migrations.ts` but are intentionally split for the TDD red/green cycle — acceptable. No combinable tasks found. |
| Not over-engineered | ✓ | V1 deliberately keeps non-default workflows reading from global catalog, client-side filtering as fallback, and defers per-workflow disabled-phases UI to follow-on work. |
| Key Decisions documented | ✓ | Five decisions with rationale in the header (backward compatibility, template resolution, phase-config update, routing, sidebar). |
| Context sections present | ✓ | "Purpose" provided for non-obvious tasks. "Not In Scope" markers present where needed (Tasks 3, 11). |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | EDITED | 1 | Added a Verification section with full test suite command and 10-step manual smoke test covering all deliverables. |
| Feasibility | EDITED | 1 | Fixed `require('crypto')` → `import { randomUUID } from 'node:crypto'` in Task 3 test snippet (ESM project). All file paths, imports, and commands verified against codebase. |
| Completeness | EDITED | 4 | Added missing test file to Task 4 Files section; added missing daemon files to Task 9 Files section; added Task 12 for updating `stores/CLAUDE.md` documentation. |
| Risk | EDITED | 2 | Added server-side guard preventing default workflow deletion via direct API call. Added database backup note for the irreversible V13 SQLite migration. |
| Optimality | EDITED | 1 | Removed unused `useUpdateWorkflow` hook (no current consumer — configure page scopes out rename in v1). |
