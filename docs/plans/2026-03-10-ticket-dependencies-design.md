# Ticket Dependencies Design

**Date:** 2026-03-10
**Status:** Design Complete

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
    { "name": "Done",         "unblocksTier": "code-ready" }
  ]
}
```

`unblocksTier` is an **optional field** in the workflow template phase schema. Phases that do not carry it are not considered tier-satisfying milestones.

**Bundled template updates required:** The `product-development/workflow.json` template (and any other bundled templates) must be updated to add `"unblocksTier": "artifact-ready"` to the `Specification` phase and `"unblocksTier": "code-ready"` to the final `Done`/`Pull Requests` phase.

**Fallback behaviour:** When no phase in the loaded template carries `unblocksTier`, `isSatisfied` must return `false` (safe default — treat the dependency as unsatisfied) and log a warning indicating that the template has no tier markers configured. This prevents silently unblocking tickets on templates that have not been updated.

**No cross-template dependencies are allowed.** Both tickets in a dependency relationship must belong to the same board (same `workflowId`). This is enforced at the store layer.

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
  FOREIGN KEY (ticket_id)  REFERENCES tickets(id),
  FOREIGN KEY (depends_on) REFERENCES tickets(id),
  UNIQUE(ticket_id, depends_on)
);

CREATE INDEX idx_ticket_dependencies_depends_on ON ticket_dependencies(depends_on);
```

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

A corresponding migration must add a `metadata TEXT` column to the `ticket_history` table (JSON-encoded). The migration must check for column existence before altering to remain idempotent:

```sql
ALTER TABLE ticket_history ADD COLUMN metadata TEXT;
```

This column stores the serialised `Record<string, unknown>` payload. When a phase move overrides unsatisfied dependencies, the `metadata` field records which dependencies were unsatisfied and that the user explicitly overrode.

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

Populated when fetching tickets with `includeDependencies: true`. The board query always uses this flag so dependency state arrives in a single call.

### Satisfaction evaluation

Evaluation is **direct only** — not transitive. If C depends on B and B depends on A, C only checks whether B has satisfied its tier. B is responsible for checking A. This keeps evaluation simple and correct: if B is done, A was necessarily resolved first.

### Cycle detection

Before writing any new dependency edge, the store traverses the existing graph to detect cycles. A new edge `(ticket_id → depends_on)` is rejected if `depends_on` already transitively depends on `ticket_id`.

**The cycle check and the insert must be wrapped in a single `db.transaction()` call.** Without this, two concurrent inserts can both observe a cycle-free graph and both commit, creating a cycle. The transaction serialises the read-then-write so only one can succeed.

---

## Store Layer

**New store:** `apps/daemon/src/stores/ticket-dependency.store.ts`

```typescript
createDependency(ticketId, dependsOn, tier)   // validates same workflowId, runs cycle check, wrapped in db.transaction()
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
GET    /api/tickets/:id/dependencies        # list deps with satisfaction status
POST   /api/tickets/:id/dependencies        # add dependency { dependsOn, tier }
DELETE /api/tickets/:id/dependencies/:depId # remove dependency
```

### Phase move endpoint change

`PATCH /api/tickets/:id/phase` accepts an optional `overrideDependencies: true` flag. When present and dependencies are unsatisfied, the move proceeds and a `TicketHistoryEntry` is appended. The entry uses the new `metadata` field to record which dependencies were unsatisfied and that the user explicitly overrode.

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

### `create_ticket` MCP tool extension

```typescript
{
  title: string
  description?: string
  dependsOn?: { ticketId: string; tier: 'artifact-ready' | 'code-ready' }[]
}
```

**Workflow scoping:** `create_ticket` called from a brainstorm context scoped to a workflow passes the `workflowId` through to the created ticket. If the brainstorm has no `workflowId`, the `dependsOn` parameter is ignored and a warning is returned — dependency creation requires both tickets to have a workflow assigned.

**Commit strategy:** Dependencies are written **eagerly** as each ticket is created (not deferred). If the user later chooses "Skip" or "Edit", the agent issues explicit `deleteDependency` calls — there is no rollback.

After all tickets are created, the agent sends a `chat_ask` summarising the dependency graph and awaiting user confirmation:

```
Created 4 tickets with the following dependencies:
• "Build dashboard" → "Auth system" (artifact-ready)
• "Build dashboard" → "User Profile API" (code-ready)
• "Analytics pipeline" → "Build dashboard" (code-ready)

Confirm these dependencies? (Yes / Edit / Skip)
```

- **Yes** — dependencies remain as already committed
- **Edit** — agent lists all current dependencies numbered (e.g., "1. Build dashboard → Auth system") and asks the user which to remove. User replies "remove 2". Agent calls `deleteDependency` for that entry. The agent then re-confirms the remaining list.
- **Skip** — agent calls `deleteDependency` for every dependency it created during this session

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

**Parameter semantics:** When called with no argument, or with the current session ticket's own ID, `get_dependencies` returns the current session ticket's dependencies. This is the expected usage for agents working on their own ticket. When called with a different `ticketId` (to traverse dependency chains), the same cross-project authorization check applies: the requested ticket must belong to the same project as the current session's ticket. Requests for tickets from a different project are rejected.

Returns lightweight metadata only — no artifact content. Agents call `get_artifact` separately if they need content. The `hasFurtherDependencies` flag signals that a dependency ticket has its own dependencies. Agents should only traverse further if the direct dependency is **unsatisfied** and the agent has a specific gap that requires understanding it — not merely because the flag is true.

### `get_artifact` extension

Gains an optional `ticketId` parameter so agents can fetch artifacts from dependency tickets:

```typescript
get_artifact(filename: string, ticketId?: string)
```

**Cross-ticket authorization:** When `ticketId` is provided and differs from the current session's ticket, the handler must:

1. Resolve the dependency ticket's `projectId` via the ticket store.
2. Assert that `projectId` matches the current session's `projectId`.
3. Only if the assertion passes, construct the artifact file path using the dependency ticket's project/ticket IDs.

If the assertion fails (the requested ticket belongs to a different project), the call is rejected with a clear error. This prevents agents from reading artifacts across unrelated projects through the dependency parameter.

---

## Agent Education

### Session-start hint (injected per session)

When a ticket session starts and the ticket has dependencies, a single line is injected into context:

> "This ticket has N dependencies. If you encounter a gap — an interface, contract, or system design you need to understand before proceeding — use `get_dependencies(ticketId)` to see what's available. Do not call it preemptively."

### Shared workflow preamble

A `shared.md` file at `templates/workflows/{name}/agents/shared.md` is prepended to every agent prompt in that template:

> "Your ticket may depend on other tickets. Dependencies represent prior design decisions that may be relevant to your work.
>
> The rule: only reach for dependency context when you have a **specific question** it would answer. If you can complete your task with what you currently have, do so. If you hit a decision point that requires understanding another system's interface or design — that is when to explore.
>
> Use `get_dependencies(ticketId)` to discover what artifacts exist. Use `get_artifact` to load only what answers your specific question. Each artifact loaded costs context — be deliberate."

### Pull model

Agents do not receive artifact content automatically. The pattern is:

1. Session hint signals dependencies exist
2. Agent works normally
3. Agent hits a specific gap it cannot resolve with current context
4. Agent calls `get_dependencies(ticketId)` — sees available artifacts
5. Agent calls `get_artifact` for the one file that answers the gap
6. Agent continues — goes deeper only if another gap emerges

This protects context window while ensuring dependency context is available when genuinely needed.

---

## Nested Dependencies

The graph model naturally supports chains (A → B → C). Key rules:

- **Cycle detection** at write time prevents infinite chains
- **Evaluation is direct only** — C checks B, B checks A; C does not independently check A
- **`get_dependencies`** shows direct dependencies plus a `hasFurtherDependencies: boolean` flag, letting agents decide whether to traverse deeper
- No automatic flattening or full-tree injection
