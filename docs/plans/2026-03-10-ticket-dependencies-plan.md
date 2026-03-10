# Ticket Dependencies Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Enable ticket-to-ticket dependencies within a workflow board, with tier-based satisfaction evaluation, UI visibility (badges, drag overlays, detail panel), MCP tooling for agents, and brainstorm flow integration.

**Architecture:** New `ticket_dependencies` SQLite table (v14 migration), new `TicketDependencyStore` class, REST endpoints under `/api/tickets/:id/dependencies`, two new MCP tools (`get_dependencies`, `delete_dependency`), extensions to `get_artifact` and `create_ticket` MCP tools, `shared.md` agent preamble via `agent-loader.ts`, and frontend components for dependency badges, drag warnings, and detail panel management.

**Tech Stack:** better-sqlite3 (synchronous store), Express routes, MCP tool definitions, React 19 + TanStack Query + dnd-kit (frontend), Vitest + RTL (tests).

**Key Decisions:**
- **Same-board only:** Dependencies enforced by same `workflowId` at store layer — not just same template, same board instance
- **Cycle detection:** BFS in `BEGIN IMMEDIATE` transaction (not default deferred) to prevent concurrent race
- **Direct evaluation only:** C checks B, B checks A — no transitive flattening, keeps logic simple
- **Soft warnings:** No server-side enforcement of blocked moves — client-side dialogs only, override logged to history
- **Pull model for agents:** Hint at session start (count + titles), agents fetch on demand via `get_dependencies()` — protects context window

---

## Phase 1: Shared Types & Data Model

### Task 1.1: Add dependency types to shared package
**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `packages/shared/src/types/ticket.types.ts`

**Purpose:** All daemon/frontend code depends on these types. Must exist first.

Add `DependencyTier` type alias, `TicketDependency` interface, `BlockedByEntry` interface, optional `blockedBy` on `Ticket`, optional `metadata` on `TicketHistoryEntry`:

```typescript
// After Complexity type
export type DependencyTier = 'artifact-ready' | 'code-ready'

export interface TicketDependency {
  id: string
  ticketId: string
  dependsOn: string
  tier: DependencyTier
  createdAt: string
}

export interface BlockedByEntry {
  ticketId: string
  title: string
  currentPhase: string
  tier: DependencyTier
  satisfied: boolean
}
```

Add to `Ticket`: `blockedBy?: BlockedByEntry[]`
Add to `TicketHistoryEntry`: `metadata?: Record<string, unknown>`

**Commit:** `feat(shared): add ticket dependency types`

### Task 1.2: Add unblocksTier to TemplatePhase type
**Depends on:** 1.1
**Complexity:** simple
**Files:**
- Modify: `packages/shared/src/types/template.types.ts`

Add optional `unblocksTier?: DependencyTier | null` to `TemplatePhase` interface. Import `DependencyTier` from `./ticket.types.js`.

**Commit:** `feat(shared): add unblocksTier to TemplatePhase`

### Task 1.3: Add workflowId to Brainstorm type
**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `packages/shared/src/types/brainstorm.types.ts`

Add optional `workflowId?: string | null` to `Brainstorm` interface.

**Commit:** `feat(shared): add workflowId to Brainstorm type`

### Task 1.4: Write v14 migration
**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`

**Purpose:** Creates the `ticket_dependencies` table and adds `workflow_id` to brainstorms.

Bump `CURRENT_SCHEMA_VERSION` to `14`. Add `if (version < 14) { migrateV14(db); }` in `runMigrations`.

```typescript
function migrateV14(db: Database.Database): void {
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

  // Add workflow_id to brainstorms (idempotent)
  const columns = db.pragma('table_info(brainstorms)') as { name: string }[]
  if (!columns.some(c => c.name === 'workflow_id')) {
    db.exec(`ALTER TABLE brainstorms ADD COLUMN workflow_id TEXT REFERENCES project_workflows(id) ON DELETE SET NULL`)
  }
}
```

**Commit:** `feat(daemon): add v14 migration for ticket dependencies`

### Task 1.5: Add unblocksTier to workflow schema JSON
**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/workflow.schema.json`

Add to the phase properties in the schema `$defs/phase` or equivalent:

```json
"unblocksTier": {
  "type": ["string", "null"],
  "enum": ["artifact-ready", "code-ready", null],
  "description": "When a ticket reaches this phase, dependencies with this tier are considered satisfied"
}
```

**Commit:** `feat(templates): add unblocksTier to workflow schema`

### Task 1.6: Add unblocksTier to product-development template
**Depends on:** 1.5
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/workflow.json`

Add `"unblocksTier": "artifact-ready"` to the Specification phase object.

**Commit:** `feat(templates): set artifact-ready tier on Specification phase`

### Task 1.7: Hardcode unblocksTier on synthetic Done phase
**Depends on:** 1.2
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/template.store.ts`
- Modify: `apps/daemon/src/types/template.types.ts` (add `unblocksTier?: DependencyTier | null` to daemon's `Phase` interface)

In `getWorkflowWithFullPhases()`, add `unblocksTier: 'code-ready' as const` to the `donePhase` object literal. Also add `unblocksTier?: DependencyTier | null` to the daemon's internal `Phase` interface in `apps/daemon/src/types/template.types.ts` so TypeScript accepts the property.

**Commit:** `feat(daemon): hardcode code-ready tier on synthetic Done phase`

---

## Phase 2: Dependency Store

### Task 2.1: Create ticket-dependency store with createDependency
**Depends on:** 1.1, 1.4
**Complexity:** complex
**Files:**
- Create: `apps/daemon/src/stores/ticket-dependency.store.ts`
- Create: `apps/daemon/src/stores/__tests__/ticket-dependency.store.test.ts`

**Purpose:** Core business logic for dependency management. Most complex task — cycle detection + BEGIN IMMEDIATE.

**Not In Scope:** isSatisfied (separate task), integration with ticket listing.

**Gotchas:** Must use `db.prepare('BEGIN IMMEDIATE').run()` not `db.transaction()` for concurrent safety.

Class-based `TicketDependencyStore` with `constructor(private db: Database.Database)`. Factory `createTicketDependencyStore(db)`. Singleton via `getDatabase()`.

`createDependency(ticketId, dependsOn, tier)`:
1. BEGIN IMMEDIATE
2. Validate both tickets exist, have non-null `workflow_id`, same `workflow_id`
3. BFS from `dependsOn` following `depends_on` edges — if `ticketId` is reachable, reject (cycle)
4. INSERT with `crypto.randomUUID()` and ISO timestamp
5. COMMIT (or ROLLBACK on error)

Tests: happy path, self-ref rejected (CHECK constraint), cycle A→B→A rejected, 3-node cycle rejected, different workflow rejected, null workflow rejected, duplicate UNIQUE rejected.

**Commit:** `feat(daemon): add ticket-dependency store with cycle detection`

### Task 2.2: Add deleteDependency, getDependenciesForTicket, getDependentsOfTicket
**Depends on:** 2.1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/ticket-dependency.store.ts`
- Modify: `apps/daemon/src/stores/__tests__/ticket-dependency.store.test.ts`

`deleteDependency(ticketId, dependsOnId)`: DELETE WHERE ticket_id=? AND depends_on=?.
`getDependenciesForTicket(ticketId)`: SELECT joined with tickets (title, phase).
`getDependentsOfTicket(ticketId)`: SELECT WHERE depends_on=? joined with tickets.

Tests: create deps, verify lists, delete, verify removal.

**Commit:** `feat(daemon): add dependency CRUD operations`

### Task 2.3: Add isSatisfied evaluation
**Depends on:** 2.2, 1.7
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/ticket-dependency.store.ts`
- Modify: `apps/daemon/src/stores/__tests__/ticket-dependency.store.test.ts`

`isSatisfied(depTicketPhase, tier, templatePhases)`:
- For given tier, find the first phase in `templatePhases` with matching `unblocksTier`
- Check if `depTicketPhase` index >= that phase's index in the phases array
- **Fallback:** If no phase has the tier marker and tier is `artifact-ready`, return `true` (permissive) + log warning. `code-ready` always has Done (synthetic).

`getDependenciesWithSatisfaction(ticketId, templatePhases)`: Calls getDependenciesForTicket, maps each through isSatisfied, returns `BlockedByEntry[]`.

Tests: ticket at Specification satisfies `artifact-ready`, ticket at Build does NOT satisfy `code-ready`, ticket at Done satisfies `code-ready`, fallback returns true when no marker.

**Commit:** `feat(daemon): add dependency satisfaction evaluation`

---

## Phase 3: REST API & SSE Events

### Task 3.1: Add dependency REST endpoints
**Depends on:** 2.3
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/server/routes/dependencies.routes.ts`
- Modify: `apps/daemon/src/server/routes/index.ts`
- Modify: `apps/daemon/src/server/server.ts` (register routes)

**Purpose:** Exposes dependency CRUD to frontend and MCP tools.

`registerDependencyRoutes(app)`:
- `GET /api/tickets/:id/dependencies` — resolve ticket's workflowId → template → phases, call `getDependenciesWithSatisfaction`
- `POST /api/tickets/:id/dependencies` — body `{ dependsOn, tier }`, call `createDependency`, emit `ticket:updated` for both tickets
- `DELETE /api/tickets/:id/dependencies` — query param `?dependsOn=<ticketId>`, call `deleteDependency`, emit `ticket:updated` for both tickets

**Error handling:** Wrap store calls in try/catch. Map errors to HTTP status codes: cycle detection → 409, same-board/NULL workflow validation → 400, duplicate (UNIQUE constraint) → 409, not found → 404.

Add export to `routes/index.ts`. Register in `server.ts`.

**Commit:** `feat(daemon): add dependency REST endpoints`

### Task 3.2: Extend ticket list/get to include blockedBy
**Depends on:** 2.3
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/ticket.store.ts`
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`

Add `includeDependencies?: boolean` to `ListTicketsOptions`. When true, for each ticket call `getDependenciesWithSatisfaction()` and set `blockedBy`. The ticket list route always passes this flag for board queries. Cache template lookup per-workflowId within a request.

**Gotchas:** Need to resolve workflowId → template_name → `getWorkflowWithFullPhases()` for each unique workflowId in the result set.

**Commit:** `feat(daemon): include blockedBy in ticket queries`

### Task 3.3: Emit SSE for dependents on phase change
**Depends on:** 2.2
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`

In the ticket update handler (where phase changes), after updating, call `getDependentsOfTicket(ticketId)` and emit `ticket:updated` for each dependent ticket.

**Commit:** `feat(daemon): emit SSE events for dependent tickets on phase change`

### Task 3.4: Support overrideDependencies flag on phase move
**Depends on:** 1.1
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`

Accept optional `overrideDependencies: true` in phase move request body. When present, append a `TicketHistoryEntry` with `metadata: { overriddenDependencies: [...unsatisfied dep info...] }`.

**Commit:** `feat(daemon): log dependency override in ticket history`

---

## Phase 4: MCP Tools

### Task 4.1: Add get_dependencies MCP tool
**Depends on:** 2.3
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/mcp/tools/dependency.tools.ts`
- Modify: `apps/daemon/src/mcp/tools/index.ts`

**Purpose:** Enables agents to discover dependency artifacts on demand.

Tool def: `get_dependencies`, optional `ticketId` param. Handler:
- Default: use `ctx.ticketId`
- If different ticketId: verify dependency edge exists from ctx.ticketId → requested (BFS reachability check)
- Call REST endpoint `GET /api/tickets/:id/dependencies` via `ctx.daemonUrl`
- For each dep, read `manifest.json` from disk (`~/.potato-cannon/tasks/{projectId}/{depTicketId}/artifacts/manifest.json`) to get artifact filenames
- Check if dep has its own deps → `hasFurtherDependencies: boolean`

Add to `allTools`/`allHandlers` in `index.ts`.

**Commit:** `feat(mcp): add get_dependencies tool`

### Task 4.2: Add delete_dependency MCP tool
**Depends on:** 3.1
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/mcp/tools/dependency.tools.ts`
- Modify: `apps/daemon/src/mcp/tools/index.ts`

Tool def: `delete_dependency` with `ticketId` and `dependsOnId` required params. Handler: call `DELETE /api/tickets/:ticketId/dependencies?dependsOn=:dependsOnId` via `ctx.daemonUrl`.

**Commit:** `feat(mcp): add delete_dependency tool`

### Task 4.3: Extend create_ticket with dependsOn
**Depends on:** 3.1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/mcp/tools/ticket.tools.ts`

Add `dependsOn` optional param to create_ticket input schema (array of `{ ticketId, tier }`). In handler, after creating ticket, iterate and call `POST /api/tickets/:newTicketId/dependencies` for each. If any fail (no workflowId), log warning and continue.

**Commit:** `feat(mcp): extend create_ticket with dependency declaration`

### Task 4.4: Extend get_artifact with cross-ticket ticketId
**Depends on:** 2.2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/mcp/tools/artifact.tools.ts`

Add optional `ticketId` param to `get_artifact` and `list_artifacts` input schemas. When provided and different from `ctx.ticketId`: call `GET /api/tickets/:ctxTicketId/dependencies` to verify a dependency edge exists to the requested ticketId. If authorized, construct a modified context `{ ...ctx, ticketId: requestedTicketId }` and call existing artifact functions.

**Commit:** `feat(mcp): allow cross-ticket artifact access via dependency edge`

---

## Phase 5: Agent Education

### Task 5.1: Create shared.md and update agent-loader
**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/templates/workflows/product-development/agents/shared.md`
- Modify: `apps/daemon/src/services/session/agent-loader.ts`

**Purpose:** Global agent education about dependencies, prepended to all agent prompts.

Create `shared.md` with dependency preamble from design doc (the "pull model" education text).

In `loadAgentDefinition()`:
1. After resolving agent prompt, also call `getAgentPromptForProject(projectId, 'agents/shared')` (try/catch → null)
2. If found, strip frontmatter from shared independently
3. Prepend: `${sharedContent}\n\n---\n\n${agentPrompt}`
4. Frontmatter/description extracted from agent file only, not shared

**Commit:** `feat(daemon): add shared.md agent preamble mechanism`

### Task 5.2: Inject dependency hint into session prompt
**Depends on:** 2.2
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/session/prompts.ts`

In `buildAgentPrompt()`, after ticket description section, call `getDependenciesForTicket(ticketId)`. If deps exist, inject:

```
This ticket has N dependencies (e.g., 'Title1', 'Title2'). If you encounter a gap — an interface, contract, or system design you need to understand before proceeding — use get_dependencies() to see what's available. Do not call it preemptively.
```

**Commit:** `feat(daemon): inject dependency hint into agent session context`

---

## Phase 6: Frontend API & Hooks

### Task 6.1: Add dependency API functions
**Depends on:** 1.1
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/api/client.ts`

Add three functions:
- `getTicketDependencies(ticketId: string)` → GET `/api/tickets/${ticketId}/dependencies`
- `addTicketDependency(ticketId: string, dependsOn: string, tier: DependencyTier)` → POST
- `removeTicketDependency(ticketId: string, dependsOn: string)` → DELETE with `?dependsOn=`

**Commit:** `feat(frontend): add dependency API client functions`

### Task 6.2: Add dependency query and mutation hooks
**Depends on:** 6.1
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/hooks/queries.ts`

- `useTicketDependencies(ticketId)` — queryKey `['ticket-dependencies', ticketId]`
- `useAddDependency()` — invalidates `['ticket-dependencies']` + `['tickets']`
- `useRemoveDependency()` — invalidates `['ticket-dependencies']` + `['tickets']`

Follow existing mutation pattern (useQueryClient + invalidateQueries in onSuccess).

**Commit:** `feat(frontend): add dependency React Query hooks`

---

## Phase 7: Board UI

### Task 7.1: Add dependency badge to TicketCard
**Depends on:** 1.1
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/components/board/DependencyBadge.tsx`
- Modify: `apps/frontend/src/components/board/TicketCard.tsx`

**Purpose:** Visual indicator of unsatisfied dependencies on ticket cards.

`DependencyBadge` component:
- Props: `blockedBy: BlockedByEntry[]`
- Filters to unsatisfied entries only
- If count > 0: render small badge with `CircleSlash` icon + count
- Hover: Radix `HoverCard` popout listing each unsatisfied dep (title, current phase → needed phase, tier)
- If count === 0: render nothing

In `TicketCard`, add `<DependencyBadge blockedBy={ticket.blockedBy ?? []} />` in the card metadata area.

**Commit:** `feat(frontend): add dependency badge to ticket cards`

### Task 7.2: Add red overlay on blocked columns during drag
**Depends on:** 7.1
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/board/Board.tsx`
- Modify: `apps/frontend/src/components/board/BoardColumn.tsx`

**Gotchas:** Need access to template phases with `unblocksTier` to determine which columns are blocked. Fetch template phases or compute blocked columns from `blockedBy` data on the active ticket.

In `Board.tsx`: when `activeTicket` is set (drag in progress), compute blocked column IDs by checking which phases the unsatisfied deps haven't reached yet. Pass `isBlockedForDrag?: boolean` prop to each `BoardColumn`.

In `BoardColumn.tsx`: when `isBlockedForDrag`, add visual treatment (`ring-2 ring-red-500/40 bg-red-500/5`).

**Commit:** `feat(frontend): show red overlay on blocked columns during drag`

### Task 7.3: Add dependency warning dialog on drop
**Depends on:** 7.2, 3.4
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/board/Board.tsx`

Extend `handleDragEnd`: if target column is blocked for dragged ticket, show confirmation dialog:

> "Dependency warning — This ticket depends on 'X' which hasn't reached Y yet. Proceed anyway?"
> [Cancel] [Move Anyway]

"Move Anyway" calls `updateTicket` with `overrideDependencies: true`. Cancel snaps back.

Can reuse the existing automation confirmation dialog pattern — add a `dialogType` state to distinguish.

**Commit:** `feat(frontend): add dependency warning dialog on blocked column drop`

---

## Phase 8: Ticket Detail Panel

### Task 8.1: Add Dependencies section to DetailsTab
**Depends on:** 6.2
**Complexity:** complex
**Files:**
- Create: `apps/frontend/src/components/ticket-detail/DependenciesSection.tsx`
- Modify: `apps/frontend/src/components/ticket-detail/DetailsTab.tsx`

**Purpose:** Manual dependency management in ticket detail panel.

`DependenciesSection` component:
- Props: `projectId, ticketId, workflowId`
- Uses `useTicketDependencies(ticketId)` to list current deps
- Each row: title, current phase badge, tier badge, satisfied (green/red), remove button (X)
- "Add dependency" row: searchable combobox of tickets from same workflowId (filter out self + existing deps), tier selector dropdown, Add button
- Uses `useAddDependency()` and `useRemoveDependency()` mutations

In `DetailsTab.tsx`, render `<DependenciesSection>` between description and history sections.

**Commit:** `feat(frontend): add dependency management to ticket detail panel`

---

## Phase 9: Brainstorm Flow

### Task 9.1: Add workflowId to brainstorm store and routes
**Depends on:** 1.3, 1.4
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/brainstorm.store.ts`
- Modify: `apps/daemon/src/server/routes/brainstorms.routes.ts`

Add `workflow_id` to `BrainstormRow` and `rowToBrainstorm` mapper. Accept optional `workflowId` in create input. Return in responses. In routes, pass `workflowId` from request body.

**Commit:** `feat(daemon): add workflowId to brainstorm store`

### Task 9.2: Surface workflowId in McpContext
**Depends on:** 9.1
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/types/mcp.types.ts`
- Modify: `apps/daemon/src/mcp/proxy.ts`
- Modify: `apps/daemon/src/server/routes/mcp.routes.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`

Add `workflowId: string` to `McpContext`. Add `POTATO_WORKFLOW_ID` env var to proxy spawn. Read in proxy.ts, forward in context. In session.service.ts, resolve workflowId from ticket or brainstorm record when spawning.

**Commit:** `feat(daemon): surface workflowId in MCP context`

### Task 9.3: Update brainstorm agent prompt
**Depends on:** 4.3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/agents/brainstorm.md`

Add a section explaining:
- The two dependency tiers and when to use each
- Create tickets sequentially, capture IDs
- Use `dependsOn` param on `create_ticket`
- After all tickets created, use `chat_ask` with "Confirm these dependencies? (Yes / Edit / Skip)"
- Handle each response (Yes = keep, Edit = ask which to remove via `delete_dependency`, Skip = remove all)

**Commit:** `feat(templates): educate brainstorm agent about dependencies`

---

## Phase 10: Tests

### Task 10.1: Dependency store integration test
**Depends on:** 2.3
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/stores/__tests__/ticket-dependency.store.integration.test.ts`

Full lifecycle test with in-memory DB: create project, workflow, two tickets, add dependency, verify blockedBy, move dep ticket through phases, verify satisfaction changes. Test explicit dependency cleanup on ticket deletion (note: `ON DELETE CASCADE` requires `PRAGMA foreign_keys = ON` which may not be enabled — test both explicit cleanup and the cascade behavior). Test 3-node cycle detection.

**Commit:** `test(daemon): add dependency store integration tests`

### Task 10.2: Board dependency warning test
**Depends on:** 7.3
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/board/Board.test.tsx`

Test: ticket with unsatisfied `blockedBy` dragged to blocked column → dialog appears. "Move Anyway" dispatches update with `overrideDependencies`. Cancel does not move. Mock ticket data with `blockedBy` entries.

**Commit:** `test(frontend): add board dependency warning tests`

---

## Verification

**How to test end-to-end:**

1. `pnpm build && pnpm dev` — start daemon + frontend
2. Create a project with a workflow
3. Create two tickets on the same board
4. In ticket detail → Dependencies section, add a dependency (ticket B depends on ticket A, tier: artifact-ready)
5. Verify: badge appears on ticket B's card
6. Drag ticket B to Architecture column → red overlay on Architecture, dialog fires
7. Move ticket A to Specification → badge disappears on ticket B (artifact-ready satisfied)
8. Move ticket A back to Refinement → badge reappears on ticket B

**Automated tests:**
- `cd apps/daemon && pnpm test` — migration, store, integration tests
- `cd apps/frontend && pnpm test` — board drag-drop, dependency badge tests
- `pnpm typecheck` — verify no type errors across monorepo

---

## Verification Record

| Pass | Verdict | Key Findings |
|------|---------|--------------|
| Plan Verification Checklist | **PASS** | All 8 checklist items pass |
| Rule-of-five: Draft | **PASS** | Clean 10-phase structure, correct dependency graph, conventional commits |
| Rule-of-five: Feasibility | **PASS** | All file paths verified; 2 fixes applied: (1) added daemon `Phase` type update to Task 1.7, (2) noted CASCADE/foreign_keys caveat in Task 10.1 |
| Rule-of-five: Completeness | **PASS** | All design doc requirements traced to tasks; added error-to-HTTP-status mapping to Task 3.1 |
| Rule-of-five: Risk | **PASS** | Low-severity: manual txn error handling (implementation detail), N+1 negligible for SQLite, transitive MCP access intentional |
| Rule-of-five: Optimality | **PASS** | Could combine small tasks (1.1+1.2, 1.5+1.6) and defer 5.1/4.4/3.4 — kept for completeness, parallelizable via beads |

**Fixes applied during verification:**
1. Task 1.7: Added `apps/daemon/src/types/template.types.ts` to file list (daemon's `Phase` interface needs `unblocksTier`)
2. Task 3.1: Added error-to-HTTP-status mapping guidance
3. Task 10.1: Added CASCADE/foreign_keys caveat for integration test

**Overall: PASS — Plan ready for execution.**
