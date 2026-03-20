# Brainstorm Workflow Normalization Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Normalize brainstorms as workflow-owned records, enforce workflow consistency between tickets and brainstorms, and replace the current project-wide brainstorm model with workflow-scoped behavior across daemon and frontend.

**Architecture:** `workflow` remains the owner of both tickets and brainstorms. Tickets continue to require `workflowId` and may optionally link to a brainstorm; brainstorms always require `workflowId` and may later become epics through status changes. PM configuration resolves through inheritance: system defaults, then workflow defaults, then brainstorm overrides, with backend invariants preventing any cross-workflow ticket/brainstorm relationship.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Express, React 19, TanStack Query, Vitest, Node test runner

**Key Decisions:**
- **Workflow-owned brainstorms:** Brainstorms always belong to exactly one workflow and can never be moved, because board ownership is a core invariant rather than UI convenience.
- **Tickets stay workflow-owned first:** Tickets continue to store `workflowId` directly and may optionally point to a brainstorm, which keeps standalone tickets simple and preserves the current board model.
- **Hard backend invariants over UI trust:** Store and route code will reject missing brainstorm workflow ownership and reject ticket/brainstorm workflow mismatches rather than trying to heal them silently at write time.
- **Workflow defaults plus brainstorm overrides:** Workflow PM settings remain useful defaults, but epics store their own overrides so PM controls no longer disappear when a brainstorm row is malformed.
- **Destructive cleanup of ambiguous brainstorm state:** Existing invalid brainstorm rows will be backfilled only when ownership can be resolved unambiguously; otherwise brainstorm links or brainstorm rows will be removed to restore integrity.

---

## Task 1: Normalize Shared Types And Brainstorm Persistence
**Depends on:** None
**Complexity:** complex
**Files:**
- Modify: `packages/shared/src/types/brainstorm.types.ts`
- Modify: `packages/shared/src/types/api.types.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/daemon/src/stores/brainstorm.store.ts`
- Modify: `apps/daemon/src/stores/__tests__/brainstorm.store.test.ts`
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/__tests__/migrations.test.ts`

**Purpose:** Make workflow ownership explicit in the data model and persist brainstorm-local PM overrides so downstream work has a correct source of truth.

**Not In Scope:** Frontend filtering, ticket creation rules, or PM config resolution logic.

**Gotchas:** Current brainstorm rows allow `workflow_id` to be null and store only `pm_enabled` plus `pm_config`. The migration must preserve readable legacy rows long enough for backfill while making new writes reject null ownership.

**Step 1: Write failing tests**
- Add store tests covering:
  - brainstorm creation without `workflowId` rejects
  - brainstorm creation with `workflowId` persists ownership
  - brainstorm updates can persist PM override state without depending on board settings
  - brainstorms remain readable after migration backfill logic is introduced
- Add migration tests covering:
  - brainstorm schema contains required ownership and PM override columns/shape
  - legacy rows with null workflow IDs are detectable for repair

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/brainstorm.store.test.ts
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/migrations.test.ts
```
Expected: FAIL because brainstorm creation still accepts missing workflow ownership and the schema/backfill support does not exist.

**Step 3: Implement shared type and store changes**
- In `packages/shared/src/types/brainstorm.types.ts`:
  - make `workflowId` required for normalized brainstorms returned by the main API
  - introduce a brainstorm-level PM override shape if the current `pmConfig` field semantics need to distinguish defaults from overrides
- In `apps/daemon/src/stores/brainstorm.store.ts`:
  - require `workflowId` in `CreateBrainstormInput`
  - reject creates without workflow ownership
  - add update helpers for brainstorm-local PM overrides
  - add a workflow-scoped list helper such as `listBrainstormsForWorkflow(projectId, workflowId)`
- In `apps/daemon/src/stores/migrations.ts`:
  - add a migration that prepares brainstorm rows for normalization and records/repairs legacy ownership where possible

**Step 4: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/brainstorm.store.test.ts
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/migrations.test.ts
```
Expected: PASS

**Step 5: Commit**
```bash
git add packages/shared/src/types/brainstorm.types.ts packages/shared/src/types/api.types.ts packages/shared/src/types/index.ts apps/daemon/src/stores/brainstorm.store.ts apps/daemon/src/stores/__tests__/brainstorm.store.test.ts apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/__tests__/migrations.test.ts
git commit -m "refactor(brainstorms): normalize workflow-owned brainstorm persistence"
```

---

## Task 2: Enforce Ticket-Brainstorm Workflow Invariants
**Depends on:** Task 1
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/stores/ticket.store.ts`
- Modify: `apps/daemon/src/stores/__tests__/ticket.store.test.ts`
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`
- Modify: `apps/daemon/src/server/routes/__tests__/workflows.routes.test.ts`
- Modify: `apps/daemon/src/server/routes/__tests__/projects.routes.test.ts`

**Purpose:** Ensure ticket creation and mutation can never create cross-workflow or ownership-less brainstorm relationships.

**Not In Scope:** Workflow-scoped brainstorm listing or frontend changes.

**Gotchas:** `ticket.store.ts` currently falls back to the project's default workflow when no workflow is supplied. Ticket creation from brainstorm context must stop trusting caller-supplied workflow and instead derive ownership from the brainstorm row.

**Step 1: Write failing tests**
- Add tests for:
  - creating a ticket with `brainstormId` and no explicit workflow inherits the brainstorm workflow
  - creating a ticket with both `brainstormId` and a mismatched `workflowId` rejects
  - standalone ticket creation still works as before with explicit or default workflow resolution
  - auto-promotion from brainstorm to epic does not alter workflow ownership

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/ticket.store.test.ts
pnpm --filter @potato-cannon/daemon test -- src/server/routes/__tests__/projects.routes.test.ts
pnpm --filter @potato-cannon/daemon test -- src/server/routes/__tests__/workflows.routes.test.ts
```
Expected: FAIL because ticket creation still treats brainstorm ownership and workflow resolution independently.

**Step 3: Implement invariant enforcement**
- In `apps/daemon/src/stores/ticket.store.ts`:
  - when `brainstormId` is provided, look up the brainstorm row first
  - derive `resolvedWorkflowId` from the brainstorm
  - reject mismatched explicit workflow input
  - block future ticket workflow changes when linked to a brainstorm unless the brainstorm link is removed first
- In `apps/daemon/src/server/routes/tickets.routes.ts`:
  - keep the existing epic transition, but stop relying on nullable brainstorm workflow ownership

**Step 4: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/ticket.store.test.ts
pnpm --filter @potato-cannon/daemon test -- src/server/routes/__tests__/projects.routes.test.ts
pnpm --filter @potato-cannon/daemon test -- src/server/routes/__tests__/workflows.routes.test.ts
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/stores/ticket.store.ts apps/daemon/src/stores/__tests__/ticket.store.test.ts apps/daemon/src/server/routes/tickets.routes.ts apps/daemon/src/server/routes/__tests__/projects.routes.test.ts apps/daemon/src/server/routes/__tests__/workflows.routes.test.ts
git commit -m "refactor(tickets): enforce workflow ownership for brainstorm-linked tickets"
```

---

## Task 3: Replace Project-Wide Brainstorm APIs With Workflow-Scoped APIs
**Depends on:** Tasks 1, 2
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/server/routes/brainstorms.routes.ts`
- Create: `apps/daemon/src/server/routes/__tests__/brainstorms.routes.test.ts`
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Modify: `apps/frontend/src/components/board/BrainstormColumn.tsx`
- Modify: `apps/frontend/src/components/board/Board.tsx`
- Modify: `apps/frontend/src/components/board/Board.test.tsx`

**Purpose:** Align board UI and brainstorm APIs so each workflow board only sees its own brainstorms.

**Not In Scope:** Brainstorm detail panel behavior or PM settings UI.

**Gotchas:** The frontend currently calls `useBrainstorms(projectId)` and shows all brainstorms on every board. Some non-board surfaces may still need a project-wide overview later, but that is out of scope for this cutover and should be removed or explicitly redesigned.

**Step 1: Write failing tests**
- Add route tests for:
  - listing brainstorms for a workflow only returns records owned by that workflow
  - creating a brainstorm without `workflowId` returns `400`
  - fetching a brainstorm through the workflow route rejects mismatched ownership
- Add frontend tests for:
  - `BrainstormColumn` requests workflow-scoped brainstorms
  - a board only renders brainstorms for its active workflow

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon test -- src/server/routes/__tests__/brainstorms.routes.test.ts
pnpm --filter @potato-cannon/frontend test -- run src/components/board/Board.test.tsx
```
Expected: FAIL because the APIs and UI are still project-wide.

**Step 3: Implement workflow-scoped APIs**
- In `apps/daemon/src/server/routes/brainstorms.routes.ts`:
  - add workflow-scoped list/create/get routes, or update existing routes to require workflow context
  - reject missing workflow ownership in create requests
  - ensure detail/update/delete paths validate ownership against both project and workflow
- In frontend client/hooks:
  - add `getBrainstorms(projectId, workflowId)` or dedicated workflow brainstorm methods
  - thread `workflowId` through `useBrainstorms`
- In `BrainstormColumn.tsx` and board consumers:
  - require a workflow-aware brainstorm query
  - remove project-wide board leakage

**Step 4: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon test -- src/server/routes/__tests__/brainstorms.routes.test.ts
pnpm --filter @potato-cannon/frontend test -- run src/components/board/Board.test.tsx
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/server/routes/brainstorms.routes.ts apps/daemon/src/server/routes/__tests__/brainstorms.routes.test.ts apps/frontend/src/api/client.ts apps/frontend/src/hooks/queries.ts apps/frontend/src/components/board/BrainstormColumn.tsx apps/frontend/src/components/board/Board.tsx apps/frontend/src/components/board/Board.test.tsx
git commit -m "refactor(brainstorms): scope brainstorm APIs and board UI to workflows"
```

---

## Task 4: Move Epic PM Resolution To Workflow Defaults Plus Brainstorm Overrides
**Depends on:** Tasks 1, 3
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/stores/board-settings.store.ts`
- Modify: `apps/daemon/src/stores/__tests__/board-settings.store.test.ts`
- Modify: `apps/daemon/src/mcp/tools/epic.tools.ts`
- Modify: `apps/daemon/src/mcp/tools/epic.tools.test.ts`
- Modify: `apps/frontend/src/components/brainstorm/EpicSettingsTab.tsx`
- Modify: `apps/frontend/src/components/brainstorm/EpicSettingsTab.test.tsx`
- Modify: `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.tsx`
- Modify: `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.test.tsx`

**Purpose:** Preserve workflow PM defaults while making epic PM settings render and persist correctly at the brainstorm level.

**Not In Scope:** General board settings page redesign or PM polling behavior changes.

**Gotchas:** `EpicSettingsTab.tsx` currently hides PM controls entirely when `brainstorm.workflowId` is missing and reads/writes board settings directly. After normalization, workflow ownership is guaranteed, but the UI still needs to read effective config from workflow defaults plus brainstorm overrides rather than treating board settings as the epic record.

**Step 1: Write failing tests**
- Add tests covering:
  - epic settings render when workflow ownership exists, even without brainstorm-local overrides
  - workflow PM defaults seed the initial epic PM state
  - saving epic PM settings persists brainstorm overrides and keeps workflow defaults intact
  - header badges show the effective mode, not only raw board settings mode
- Extend daemon epic tool tests so `set_epic_pm_mode` updates brainstorm override state instead of mutating only the brainstorm flag.

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon test -- src/mcp/tools/epic.tools.test.ts
pnpm --filter @potato-cannon/frontend test -- run src/components/brainstorm/EpicSettingsTab.test.tsx
pnpm --filter @potato-cannon/frontend test -- run src/components/brainstorm/BrainstormDetailPanel.test.tsx
```
Expected: FAIL because epic PM configuration is still board-settings-only.

**Step 3: Implement inheritance and override persistence**
- In daemon code:
  - add a helper that resolves effective brainstorm PM config from workflow defaults plus brainstorm overrides
  - update epic MCP tools to write brainstorm override state
- In frontend code:
  - fetch workflow defaults and brainstorm overrides, compose the effective config, and save brainstorm overrides through the appropriate API
  - keep workflow defaults available as the inherited baseline

**Step 4: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon test -- src/mcp/tools/epic.tools.test.ts
pnpm --filter @potato-cannon/frontend test -- run src/components/brainstorm/EpicSettingsTab.test.tsx
pnpm --filter @potato-cannon/frontend test -- run src/components/brainstorm/BrainstormDetailPanel.test.tsx
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/stores/board-settings.store.ts apps/daemon/src/stores/__tests__/board-settings.store.test.ts apps/daemon/src/mcp/tools/epic.tools.ts apps/daemon/src/mcp/tools/epic.tools.test.ts apps/frontend/src/components/brainstorm/EpicSettingsTab.tsx apps/frontend/src/components/brainstorm/EpicSettingsTab.test.tsx apps/frontend/src/components/brainstorm/BrainstormDetailPanel.tsx apps/frontend/src/components/brainstorm/BrainstormDetailPanel.test.tsx
git commit -m "refactor(epics): resolve PM settings from workflow defaults and brainstorm overrides"
```

---

## Task 5: Migrate Existing Data And Remove Ambiguous Ownership
**Depends on:** Tasks 1-4
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/__tests__/migrations.test.ts`
- Modify: `apps/daemon/src/stores/brainstorm.store.ts`
- Modify: `apps/daemon/src/stores/ticket.store.ts`

**Purpose:** Repair or discard invalid legacy brainstorm state so the normalized model starts from a clean database.

**Not In Scope:** Preserving every malformed brainstorm row at all costs.

**Gotchas:** The user has explicitly accepted destructive cleanup if necessary. Preserve tickets whenever possible; destroy ambiguous brainstorm ownership rather than carrying it forward.

**Step 1: Write failing migration tests**
- Add migration scenarios for:
  - null-workflow brainstorm with all linked tickets in one workflow -> backfill workflow
  - null-workflow brainstorm with no tickets -> delete brainstorm
  - null-workflow brainstorm with mixed ticket workflows -> remove brainstorm links from tickets and delete or archive brainstorm
  - valid brainstorm rows remain untouched

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/migrations.test.ts
```
Expected: FAIL because the destructive normalization logic does not exist yet.

**Step 3: Implement normalization migration**
- In `apps/daemon/src/stores/migrations.ts`:
  - inspect legacy brainstorm rows with null ownership
  - backfill when all linked tickets agree
  - detach or delete on ambiguous ownership
  - remove now-invalid PM data dependencies as needed
- Add any store helpers needed to support this deterministically in tests.

**Step 4: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/migrations.test.ts
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/__tests__/migrations.test.ts apps/daemon/src/stores/brainstorm.store.ts apps/daemon/src/stores/ticket.store.ts
git commit -m "feat(migrations): normalize legacy brainstorm workflow ownership"
```

---

## Task 6: Verify End-To-End Behavior And Remove Stale Project-Wide Assumptions
**Depends on:** Tasks 1-5
**Complexity:** standard
**Files:**
- Modify: relevant docs only if implementation diverges materially

**Purpose:** Confirm the cutover works end to end and remove any stale assumptions that survived the refactor.

**Not In Scope:** New brainstorm product features beyond the normalization.

**Step 1: Run targeted package verification**
```bash
pnpm --filter @potato-cannon/daemon test
pnpm --filter @potato-cannon/frontend test
pnpm typecheck
```
Expected: PASS

**Step 2: Run full repository verification**
```bash
pnpm build
pnpm test
```
Expected: PASS

**Step 3: Manual smoke test**
1. Start daemon and frontend.
2. Open two different workflow boards in the same project.
3. Create a brainstorm on board A.
4. Verify board B does not show that brainstorm.
5. Create tickets from the brainstorm and verify they land on board A only.
6. Promote the brainstorm to epic and confirm PM settings render.
7. Change epic PM mode and verify workflow defaults remain available as inherited baseline.

**Step 4: Cleanup**
- Remove dead project-wide brainstorm assumptions left in helpers or comments.
- Remove temporary debug logging or migration diagnostics added during development.

**Step 5: Commit**
```bash
git add -A
git commit -m "test(brainstorms): verify workflow normalization cutover"
```

---

## Implementation Order

```text
Task 1 -> Task 2 -> Task 3 -> Task 4 -> Task 5 -> Task 6
```

Parallelism guidance:
- Keep this as a single coordinated branch cutover.
- Do not split Tasks 1-5 across parallel workers because the schema, route, and UI assumptions all change together.

---

## Focused Test Commands

During implementation:
```bash
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/brainstorm.store.test.ts
pnpm --filter @potato-cannon/daemon test -- src/stores/__tests__/ticket.store.test.ts
pnpm --filter @potato-cannon/daemon test -- src/server/routes/__tests__/brainstorms.routes.test.ts
pnpm --filter @potato-cannon/daemon test -- src/mcp/tools/epic.tools.test.ts
pnpm --filter @potato-cannon/frontend test -- run src/components/board/Board.test.tsx
pnpm --filter @potato-cannon/frontend test -- run src/components/brainstorm/EpicSettingsTab.test.tsx
pnpm --filter @potato-cannon/frontend test -- run src/components/brainstorm/BrainstormDetailPanel.test.tsx
```

Final verification:
```bash
pnpm build
pnpm typecheck
pnpm test
```

---

## Risk Notes

### R1: Hidden Project-Wide Call Sites
**Risk:** Some UI or session code may still assume brainstorms are project-scoped and silently reintroduce leakage.
**Mitigation:** Replace `useBrainstorms(projectId)` with a workflow-scoped contract in board surfaces and grep for all brainstorm list call sites during Task 3.

### R2: Legacy Data Ambiguity
**Risk:** Existing brainstorm rows with null ownership and mixed-workflow tickets cannot be repaired safely.
**Mitigation:** Preserve tickets, detach invalid brainstorm links, and delete ambiguous brainstorm rows during migration.

### R3: PM Settings Regression
**Risk:** Moving from board-settings-only PM state to inherited workflow defaults plus brainstorm overrides could break current epic PM mode rendering.
**Mitigation:** Add daemon and frontend tests before implementation and keep effective-config resolution in a dedicated helper path.

### R4: Ticket Workflow Drift During Create Or Update
**Risk:** Older code paths may still supply a workflow independently from brainstorm linkage, causing subtle mismatches.
**Mitigation:** Make ticket creation derive workflow from brainstorm ownership and reject mismatched explicit workflow input.

### R5: Scope Blowout During Cutover
**Risk:** Because this is a core concept, it is easy to drift into redesigning unrelated project or board systems.
**Mitigation:** Keep the cutover strictly focused on ownership, API scope, PM inheritance, and legacy data repair. No brainstorm moving, no new overview UX, no extra PM features.
