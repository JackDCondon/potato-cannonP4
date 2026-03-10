# Ticket Dependencies Design

**Date:** 2026-03-10
**Status:** Design Complete
**Revision:** 3

## Overview

Tickets within a project board can have dependencies on other tickets. Dependencies represent prior design decisions or code that must exist before a dependent ticket can meaningfully proceed. This feature provides UI visibility, soft warnings on premature phase advancement, automated dependency declaration during brainstorm sessions, and agent-aware context loading via MCP tooling.

---

## Dependency Tiers

Dependencies are not binary — the level of "doneness" required depends on what the dependent ticket needs:

| Tier | Meaning | Typical use |
|------|---------|-------------|
| `artifact-ready` | Dependency has reached the phase tagged as artifact-ready in the workflow template | Planning phases need design docs, not code |
| `code-ready` | Dependency has reached the final Done phase (merged) | Build phases need the code to exist |

These tiers are **template-defined**, not hardcoded. Each workflow template phase can carry an optional `unblocksTier` marker:

```json
{
  "phases": [
    { "name": "Refinement",   "unblocksTier": null },
    { "name": "Architecture", "unblocksTier": null },
    { "name": "Specification","unblocksTier": "artifact-ready" },
    { "name": "Build",        "unblocksTier": null },
    { "name": "Pull Requests","unblocksTier": null }
  ]
}
```

`unblocksTier` is an **optional field** in the workflow template phase schema. Phases that do not carry it are not considered tier-satisfying milestones.

### Workflow schema update required

The `workflow.schema.json` phase definition must add `unblocksTier` as an optional string property:

```json
{
  "unblocksTier": {
    "type": ["string", "null"],
    "enum": ["artifact-ready", "code-ready", null],
    "description": "When a ticket reaches this phase, dependencies with this tier are considered satisfied"
  }
}
```

### Synthetic phase handling

`Done` is a **synthetic phase** injected at runtime by `getWorkflowWithFullPhases()` in `template.store.ts` — it does not exist in `workflow.json`. The `code-ready` tier is **hardcoded onto the synthetic `Done` phase** in `getWorkflowWithFullPhases()`, not configured in the template file:

```typescript
const donePhase = {
  id: "Done",
  name: "Done",
  description: "Ticket completed",
  workers: [],
  transitions: { next: null },
  unblocksTier: "code-ready"   // hardcoded — Done always satisfies code-ready
}
```

This means template authors only configure `artifact-ready` on their phases. `code-ready` is always resolved by reaching `Done`.

### Bundled template updates

The `product-development/workflow.json` template must add `"unblocksTier": "artifact-ready"` to the `Specification` phase. Other bundled templates should add `unblocksTier` to whichever phase represents "planning complete."

### Fallback behaviour and upgrade path

When no phase in the loaded template carries `unblocksTier`:

- `isSatisfied` returns `true` for `artifact-ready` tier dependencies (treat as satisfied — no template-level gate defined)
- `isSatisfied` returns the standard check for `code-ready` (only the `Done` synthetic phase, which always has `unblocksTier: "code-ready"`)
- A warning is logged indicating the template has no `artifact-ready` tier markers configured

This avoids breaking existing installations on upgrade. Users with project-level template copies (`~/.potato-cannon/project-data/{projectId}/template/`) will see `code-ready` dependencies work correctly (via synthetic `Done` phase) and `artifact-ready` dependencies permissively satisfied (with a logged warning) until they update their templates.

### Constraint: same board only

Both tickets in a dependency relationship must belong to the same board (same `workflowId`). This is enforced at the store layer. The term "no cross-template dependencies" is imprecise — the actual constraint is same `workflowId`, which is more restrictive (same board, not just same template type).

---

## Data Model

### New table: `ticket_dependencies`

```sql
CREATE TABLE ticket_dependencies (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL,   -- the dependent (blocked) ticket
  depends_on  TEXT NOT NULL,   -- the ticket it is waiting for
  tier        TEXT NOT NULL CHECK(tier IN ('artifact-ready', 'code-ready')),
  created_at  TEXT NOT NULL,
  FOREIGN KEY (ticket_id)  REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, depends_on),
  CHECK(ticket_id != depends_on)
);

CREATE INDEX idx_ticket_dependencies_depends_on ON ticket_dependencies(depends_on);
```

Both foreign keys use `ON DELETE CASCADE` — when a ticket is deleted, all dependency edges involving it are removed. When a ticket is archived (not deleted), dependency rows remain but may reference tickets no longer visible on the board; the UI should filter these from the badge count.

### `TicketHistoryEntry` extension

The existing `TicketHistoryEntry` interface (`packages/shared/src/types/ticket.types.ts`) must be extended with an optional metadata field:

```typescript
export interface TicketHistoryEntry {
  phase: string
  at: string
  sessionId?: string
  sessions?: HistorySessionRecord[]
  endedAt?: string
  metadata?: Record<string, unknown>   // added for dependency override logging
}
```

### Migration: v14

Both schema changes go in a **single new migration** (v14), following the existing pattern in `migrations.ts`:

```typescript
function migrateV14(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_dependencies (
      id          TEXT PRIMARY KEY,
      ticket_id   TEXT NOT NULL,
      depends_on  TEXT NOT NULL,
      tier        TEXT NOT NULL CHECK(tier IN ('artifact-ready', 'code-ready')),
      created_at  TEXT NOT NULL,
      FOREIGN KEY (ticket_id)  REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on) REFERENCES tickets(id) ON DELETE CASCADE,
      UNIQUE(ticket_id, depends_on),
      CHECK(ticket_id != depends_on)
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_dependencies_depends_on
      ON ticket_dependencies(depends_on);
  `)

  // Add metadata column to ticket history (idempotent check)
  const columns = db.pragma('table_info(tickets)') as { name: string }[]
  const hasMetadata = columns.some(c => c.name === 'metadata')
  if (!hasMetadata) {
    // ticket_history is stored as JSON in the tickets table's history column,
    // so the metadata field is part of the JSON — no ALTER TABLE needed.
    // The TicketHistoryEntry type change is sufficient.
  }
}
```

Note: If ticket history is stored as a JSON column on the `tickets` table (not a separate `ticket_history` table), the `metadata` field is added to the JSON structure via the type change only — no DDL migration needed for it. Verify the actual storage mechanism during implementation.

`CURRENT_SCHEMA_VERSION` is bumped to `14`.

### Ticket type extension

The `Ticket` interface gains an optional computed field:

```typescript
blockedBy?: {
  ticketId: string
  title: string
  currentPhase: string
  tier: 'artifact-ready' | 'code-ready'
  satisfied: boolean
}[]
```

Populated when fetching tickets with `includeDependencies: true`. The board query always uses this flag so dependency state arrives in a single call. This field is **never persisted** — it is computed at query time. Callers that fetch without `includeDependencies` receive `blockedBy: undefined`.

### Satisfaction evaluation

Evaluation is **direct only** — not transitive. If C depends on B and B depends on A, C only checks whether B has satisfied its tier. B is responsible for checking A. This keeps evaluation simple and correct: if B is done, A was necessarily resolved first.

### Cycle detection

Before writing any new dependency edge, the store traverses the existing graph to detect cycles. A new edge `(ticket_id → depends_on)` is rejected if `depends_on` already transitively depends on `ticket_id`. Self-referential dependencies are also blocked by the `CHECK(ticket_id != depends_on)` constraint at the database level.

**The cycle check and the insert must use `BEGIN IMMEDIATE` to serialise concurrent writes.** The default `db.transaction()` in better-sqlite3 uses deferred transactions, which do not acquire a write lock until the first write statement. Two concurrent `createDependency` calls could both read a cycle-free graph inside deferred transactions and both write, creating a cycle. Use `db.prepare('BEGIN IMMEDIATE').run()` / `COMMIT` / `ROLLBACK` to acquire the write lock at transaction start:

```typescript
function createDependency(ticketId: string, dependsOn: string, tier: string) {
  db.prepare('BEGIN IMMEDIATE').run()
  try {
    // 1. Validate same workflowId, NULL checks
    // 2. Traverse graph from dependsOn to check reachability of ticketId
    // 3. Insert edge
    db.prepare('COMMIT').run()
  } catch (e) {
    db.prepare('ROLLBACK').run()
    throw e
  }
}
```

---

## Store Layer

**New store:** `apps/daemon/src/stores/ticket-dependency.store.ts`

```typescript
createDependency(ticketId, dependsOn, tier)   // validates same workflowId, NULL check, cycle check, BEGIN IMMEDIATE
deleteDependency(ticketId, dependsOnId)
getDependenciesForTicket(ticketId)            // what this ticket needs
getDependentsOfTicket(ticketId)              // what tickets need this one
isSatisfied(dependency, workflowTemplate)    // checks phase thresholds from template config
```

**`createDependency` NULL workflow_id guard:** If either `ticketId` or `dependsOnId` has a `NULL workflow_id`, `createDependency` must reject the call immediately with a clear error: `"Cannot create dependency: ticket {id} has no workflow assigned"`. Dependencies across unscoped tickets are not supported.

**Existing ticket store:** `listTickets` and `getTicket` gain an `includeDependencies` flag that calls `isSatisfied` per dependency and populates `blockedBy`.

---

## REST API

### New endpoints

```
GET    /api/tickets/:id/dependencies                      # list deps with satisfaction status
POST   /api/tickets/:id/dependencies                      # add dependency { dependsOn, tier }
DELETE /api/tickets/:id/dependencies?dependsOn=<ticketId>  # remove dependency by target ticket ID
```

The DELETE endpoint uses `?dependsOn=<ticketId>` (the target ticket ID) rather than the internal dependency row UUID. This is more ergonomic for both the frontend and MCP agents, which know the target ticket ID but not the internal row ID.

### Phase move endpoint change

`PATCH /api/tickets/:id/phase` accepts an optional `overrideDependencies: true` flag. When present and dependencies are unsatisfied, the move proceeds and a `TicketHistoryEntry` is appended. The entry uses the `metadata` field to record which dependencies were unsatisfied and that the user explicitly overrode.

No server-side enforcement — the soft warning is client-side only.

---

## Board UI

### Ticket card badge

When a ticket has one or more unsatisfied dependencies, a badge appears on the card:

```
⊘ 2
```

No badge is shown when all dependencies are satisfied.

**Hover popout** on the badge displays a small card:

```
Blocked by:
• Auth system     [Refinement → needs Specification]  artifact-ready
• User Profile API [Build → needs Done]               code-ready
```

Shows: title, current phase, phase needed, tier.

### Drag behaviour

When dragging a ticket, each board column is evaluated against the ticket's unsatisfied dependencies. Columns the ticket cannot legitimately enter receive a **red overlay/border** treatment. This is visual only — it does not prevent the drop.

### Drop warning

When a ticket is dropped into a column flagged red, a confirmation dialog fires:

> **Dependency warning**
> This ticket depends on "Auth system" which hasn't reached Specification yet.
> Proceed anyway?
> `[ Cancel ]  [ Move Anyway ]`

Choosing "Move Anyway" moves the ticket and appends a history entry with the override details.

### Manual dependency management

The ticket detail panel gains a **Dependencies** section:

- Searchable picker scoped to the same board's tickets
- Tier selector (`artifact-ready` / `code-ready`)
- List of current dependencies with remove buttons

---

## Brainstorm Flow (Hybrid Approach)

The brainstorm agent creates tickets **sequentially**, capturing each returned ID before creating the next. With full conversational context available, it declares dependencies inline as it goes.

### Brainstorm workflow scoping

The `brainstorms` table currently has no `workflow_id` column. A new column must be added in the v14 migration:

```sql
ALTER TABLE brainstorms ADD COLUMN workflow_id TEXT REFERENCES project_workflows(id) ON DELETE SET NULL;
```

When a brainstorm is started from a workflow-scoped context (e.g., from a specific board), the `workflow_id` is set on the brainstorm record and surfaced in `McpContext` as `ctx.workflowId`. This allows `create_ticket` to inherit the workflow scope.

If a brainstorm has no `workflowId` (e.g., started from a project-level context), the `dependsOn` parameter on `create_ticket` is ignored and a warning is returned — dependency creation requires both tickets to have a workflow assigned.

### `create_ticket` MCP tool extension

```typescript
{
  title: string
  description?: string
  dependsOn?: { ticketId: string; tier: 'artifact-ready' | 'code-ready' }[]
}
```

**Commit strategy:** Dependencies are written **eagerly** as each ticket is created (not deferred). If the user later chooses "Skip" or "Edit", the agent issues explicit `delete_dependency` MCP tool calls — there is no rollback.

After all tickets are created, the agent sends a `chat_ask` summarising the dependency graph and awaiting user confirmation:

```
Created 4 tickets with the following dependencies:
• "Build dashboard" → "Auth system" (artifact-ready)
• "Build dashboard" → "User Profile API" (code-ready)
• "Analytics pipeline" → "Build dashboard" (code-ready)

Confirm these dependencies? (Yes / Edit / Skip)
```

- **Yes** — dependencies remain as already committed
- **Edit** — agent lists all current dependencies numbered (e.g., "1. Build dashboard → Auth system") and asks the user which to remove. User replies "remove 2". Agent calls `delete_dependency` for that entry. On invalid input, agent re-lists and re-prompts. The agent then re-confirms the remaining list.
- **Skip** — agent calls `delete_dependency` for every dependency it created during this session

The brainstorm agent system prompt gets a section explaining the two tiers and when to use each.

Same-board validation runs in the MCP tool before writing — both tickets must share the same `workflowId`.

---

## MCP Tooling

### New tool: `get_dependencies`

```typescript
get_dependencies(ticketId?: string): {
  ticket: { id: string; title: string; phase: string }
  dependencies: {
    ticketId: string
    title: string
    currentPhase: string
    tier: 'artifact-ready' | 'code-ready'
    satisfied: boolean
    artifacts: string[]          // filenames available, not content
    hasFurtherDependencies: boolean
  }[]
}
```

**Parameter semantics:** When called with no argument, or with the current session ticket's own ID, `get_dependencies` returns the current session ticket's dependencies. This is the expected usage for agents working on their own ticket. When called with a different `ticketId` (to traverse dependency chains), the handler verifies a dependency edge exists between the current session's ticket and the requested ticket (directly or transitively). Requests for tickets with no dependency relationship to the current session are rejected.

Returns lightweight metadata only — no artifact content. Agents call `get_artifact` separately if they need content. The `hasFurtherDependencies` flag signals that a dependency ticket has its own dependencies. Agents should only traverse further if the direct dependency is **unsatisfied** and the agent has a specific gap that requires understanding it — not merely because the flag is true.

**Artifact listing implementation:** To populate the `artifacts` array, the handler resolves the dependency ticket's `projectId` via `ticketStore.getTicket()`, then reads the artifact `manifest.json` from disk at `~/.potato-cannon/tasks/{projectId}/{ticketId}/artifacts/manifest.json`. This is consistent with the existing artifact system which reads from disk, not SQLite.

### New tool: `delete_dependency`

```typescript
delete_dependency(ticketId: string, dependsOnId: string): { success: boolean }
```

Removes a dependency edge. Used by the brainstorm agent during the "Edit" and "Skip" confirmation flows. The `ticketId` must match the current session's ticket or a ticket created by the current session (for brainstorm contexts). Calls `ticketDependencyStore.deleteDependency()`.

### `get_artifact` extension

Gains an optional `ticketId` parameter so agents can fetch artifacts from dependency tickets:

```typescript
get_artifact(filename: string, ticketId?: string)
```

**Cross-ticket authorization:** When `ticketId` is provided and differs from the current session's ticket, the handler must verify that a dependency edge exists between the current session's ticket and the requested `ticketId`. Since same-workflowId is enforced at dependency creation time (guaranteeing same project), the projectId check is redundant but may be included as defense-in-depth. The dependency-edge check is the primary authorization gate — it prevents agents from reading artifacts of arbitrary tickets they have no declared relationship with.

---

## Agent Education

### Session-start hint (injected per session)

When a ticket session starts and the ticket has dependencies, a single line is injected into context:

> "This ticket has N dependencies. If you encounter a gap — an interface, contract, or system design you need to understand before proceeding — use `get_dependencies()` to see what's available. Do not call it preemptively."

### Shared workflow preamble

A `shared.md` file at `templates/workflows/{name}/agents/shared.md` is prepended to every agent prompt in that template.

**Implementation:** The prepend happens in `agent-loader.ts` during `loadAgentDefinition()`. After resolving the agent prompt file via the existing priority chain (project override > project copy > global), the loader checks for `shared.md` using the same priority chain. If found, it is prepended to the agent prompt content before returning. This is a single code change in `loadAgentDefinition()`:

```typescript
async function loadAgentDefinition(projectId: string, agentPath: string) {
  const sharedPrompt = await getAgentPromptForProject(projectId, 'shared')  // may return null
  const agentPrompt = await getAgentPromptForProject(projectId, agentPath)
  const fullPrompt = sharedPrompt ? `${sharedPrompt}\n\n---\n\n${agentPrompt}` : agentPrompt
  // ... continue with frontmatter extraction on fullPrompt
}
```

The `shared.md` file follows the same override resolution: project override > project copy > global template. This means a project can customise the shared preamble independently.

**Shared preamble content:**

> "Your ticket may depend on other tickets. Dependencies represent prior design decisions that may be relevant to your work.
>
> The rule: only reach for dependency context when you have a **specific question** it would answer. If you can complete your task with what you currently have, do so. If you hit a decision point that requires understanding another system's interface or design — that is when to explore.
>
> Use `get_dependencies()` to discover what artifacts exist. Use `get_artifact` to load only what answers your specific question. Each artifact loaded costs context — be deliberate."

### Pull model

Agents do not receive artifact content automatically. The pattern is:

1. Session hint signals dependencies exist
2. Agent works normally
3. Agent hits a specific gap it cannot resolve with current context
4. Agent calls `get_dependencies()` — sees available artifacts
5. Agent calls `get_artifact` for the one file that answers the gap
6. Agent continues — goes deeper only if another gap emerges

This protects context window while ensuring dependency context is available when genuinely needed.

---

## Nested Dependencies

The graph model naturally supports chains (A → B → C). Key rules:

- **Cycle detection** at write time prevents infinite chains (including self-referential via `CHECK` constraint)
- **Evaluation is direct only** — C checks B, B checks A; C does not independently check A
- **`get_dependencies`** shows direct dependencies plus a `hasFurtherDependencies: boolean` flag, letting agents decide whether to traverse deeper
- No automatic flattening or full-tree injection
