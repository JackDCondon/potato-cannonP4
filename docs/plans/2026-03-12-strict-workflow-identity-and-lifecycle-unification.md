# Strict Workflow Identity And Lifecycle Unification Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Remove project-level template coupling, enforce workflow identity as mandatory, and standardize destructive ticket lifecycle cleanup across all deletion paths.
**Architecture:** Move from mixed project-template plus workflow-template behavior to a workflow-first model where every ticket always belongs to a workflow. Destructive operations route through one canonical ticket deletion service that handles session shutdown, chat queue cleanup, provider thread cleanup, and data/file removal. Template versioning, changelog, and upgrades become workflow-scoped instead of project-scoped.
**Tech Stack:** TypeScript, Node.js, Express, better-sqlite3, React, TanStack Query, Vitest, Node test runner.
**Key Decisions:**
- **Workflow Identity:** Every ticket must have a non-null `workflow_id`, no implicit fallback to project template, because wrong-workflow fallback is treated as critical failure.
- **Workflow Delete Policy:** Deleting a workflow with tickets requires explicit destructive confirmation and then hard-deletes all tickets via canonical lifecycle cleanup.
- **Deletion Orchestration:** All ticket deletions use one service-layer path to guarantee session, queue, provider-thread, and file cleanup consistency.
- **Upgrade Scope:** Template status/changelog/upgrade move to per-workflow endpoints, because project-level single-template semantics are deprecated.
- **Agent Resolution Chain:** Agent content resolves by workflow template chain (`workflow -> parentTemplate`) with optional workflow-scoped override support, removing project-template coupling.
---

## Scope And Constraints

- No production data compatibility is required beyond deterministic migration in this environment.
- Tickets with `workflow_id IS NULL` will be hard-deleted during migration as requested.
- Silent fallback to project template for workflow resolution is removed and replaced by explicit error paths.
- Existing workflow `parentTemplate` inheritance remains supported and becomes the primary inheritance model.

## Preconditions

- Ensure a full database backup exists before running migration in shared dev environments.
- Ensure `bd` CLI is available if converting this plan to beads.

## Implementation Guardrails

- Treat `projects.template_name` and `projects.template_version` as backward-compatibility shadow fields until the workflow-scoped replacement is complete. New runtime resolution must use workflow state as the source of truth.
- Introduce an explicit workflow-local template storage helper/path before implementing per-workflow upgrades. Do not reuse one shared project template directory for multiple workflows.
- Any destructive operation that removes tickets in bulk must iterate tickets through the canonical ticket deletion service. Do not rely on FK cascade or raw `DELETE FROM tickets` for workflow delete, project delete, or future bulk-purge paths.
- Any API that accepts `workflowId` must verify that the workflow belongs to the supplied project and return a structured explicit error when invalid. Do not silently fall back to project template behavior.
- When a file listed below does not already exist, create it intentionally and update the file list from `Modify` to `Create` in the implementation, rather than assuming the path is wrong.

## Task 1: Introduce Strict Workflow Schema Migration (V18)
**Depends on:** None
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/CLAUDE.md`
- Test: `apps/daemon/src/stores/__tests__/migrations.test.ts`

**Purpose:** Enforce non-null workflow identity at schema level and remove null-workflow tickets before constraints become strict.

**Not In Scope:** UI behavior, route changes, or service orchestration.

**Gotchas:** SQLite requires table rebuild for foreign key action changes and strict NOT NULL adoption. `ON DELETE RESTRICT` is intentional and means later tasks must stop relying on workflow/project cascade for destructive deletes.

**Step 1: Write failing migration tests**
- Add test coverage for:
  - V18 hard-deletes tickets with `workflow_id IS NULL`.
  - New `tickets.workflow_id` is `NOT NULL`.
  - FK behavior on workflow delete becomes restrictive (no `ON DELETE SET NULL`).
- Verify migration idempotence in repeated runs.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL on new V18 expectations.

**Step 3: Implement V18 migration**
- Add `CURRENT_SCHEMA_VERSION = 18` and `migrateV18`.
- In V18:
  - Delete rows from `tickets` where `workflow_id IS NULL`.
  - Rebuild `tickets` table with `workflow_id TEXT NOT NULL REFERENCES project_workflows(id) ON DELETE RESTRICT`.
  - Preserve all existing columns, indexes, constraints, and data for non-deleted tickets.
- Add explicit migration logs for deleted-ticket count.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS for migration tests and no regression in existing suite.

**Step 5: Commit**
`git add apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/__tests__/migrations.test.ts apps/daemon/src/stores/CLAUDE.md`
`git commit -m "feat: enforce strict workflow identity in schema v18"`

### Task 2: Guarantee Workflow Bootstrap For Projects And Tickets
**Depends on:** Task 1
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/server/routes/projects.routes.ts`
- Modify: `apps/daemon/src/stores/project-workflow.store.ts`
- Modify: `apps/daemon/src/stores/ticket.store.ts`
- Create: `apps/daemon/src/server/__tests__/projects.routes.test.ts`
- Modify: `apps/daemon/src/stores/__tests__/ticket.store.test.ts`

**Purpose:** Ensure the strict `workflow_id` invariant is maintained for new data, not just migrated data.

**Not In Scope:** Per-workflow upgrade APIs or deletion orchestration.

**Gotchas:** The current project-create path does not guarantee that a default workflow exists, and `createTicket()` still has a nullable fallback path. Both must be closed before weaker models start relying on the new schema invariant.

**Step 1: Write failing tests**
- Add test coverage for:
  - Creating a project creates exactly one default workflow using the chosen template, or the catalog default when no explicit template was supplied.
  - Loading/repairing a legacy project with zero workflows creates one default workflow before board/configure flows depend on it.
  - Creating a ticket without `workflowId` attaches the project's default workflow.
  - Creating a ticket for a project with no resolvable default workflow fails with an explicit error before any DB insert is attempted.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL because project bootstrap and ticket creation still allow the no-workflow edge case.

**Step 3: Implement workflow bootstrap and ticket guards**
- Add a shared helper in the project/workflow layer that guarantees a default workflow exists for a project and returns it.
- Call that helper from project creation and any legacy repair path that can currently return a project with zero workflows.
- Update ticket creation so `workflowId` resolution is:
  1. explicit request `workflowId` when valid for the project
  2. project's default workflow
  3. explicit thrown error with actionable message if neither exists
- Do not silently coerce a workflow from another project.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS for project bootstrap and ticket store invariants.

**Step 5: Commit**
`git add apps/daemon/src/server/routes/projects.routes.ts apps/daemon/src/stores/project-workflow.store.ts apps/daemon/src/stores/ticket.store.ts apps/daemon/src/server/__tests__/projects.routes.test.ts apps/daemon/src/stores/__tests__/ticket.store.test.ts`
`git commit -m "feat: guarantee default workflow bootstrap for projects and tickets"`

### Task 3: Add Canonical Ticket Deletion Service
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/services/ticket-deletion.service.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/services/chat.service.ts`
- Modify: `apps/daemon/src/services/session/index.ts`
- Create: `apps/daemon/src/services/__tests__/ticket-deletion.service.test.ts`

**Purpose:** Ensure all ticket deletion paths execute identical lifecycle cleanup sequence.

**Not In Scope:** Workflow-route integration and UI prompts.

**Gotchas:** Service must remain safe when partial cleanup operations fail; DB delete should not run before shutdown and queue/provider cleanup are attempted. Later workflow/project destructive paths must call this service instead of reimplementing cleanup inline.

**Step 1: Write failing unit tests**
- Validate service sequence:
  1. terminate active session
  2. cleanup chat lifecycle queue/routes/threads
  3. delete ticket record and files
  4. emit deletion event metadata return
- Validate behavior when provider thread deletion throws warning-level errors.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL because service does not yet exist.

**Step 3: Implement deletion service**
- Add `deleteTicketWithLifecycle(projectId, ticketId, options?)` service.
- Centralize calls currently spread across `tickets.routes.ts` delete path.
- Export the service from a stable service-layer entry point or use a direct file import consistently; do not create a second deletion helper.
- Return structured cleanup report (`sessionStopped`, `queueCancelled`, `routesRemoved`, `threadDeletesAttempted`, `threadDeleteErrors`).

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS for new service tests and existing chat/session tests.

**Step 5: Commit**
`git add apps/daemon/src/services/ticket-deletion.service.ts apps/daemon/src/services/session/index.ts apps/daemon/src/services/session/session.service.ts apps/daemon/src/services/chat.service.ts apps/daemon/src/services/__tests__/ticket-deletion.service.test.ts`
`git commit -m "feat: add canonical ticket deletion lifecycle service"`

### Task 4: Wire Workflow Delete To Canonical Destructive Path
**Depends on:** Task 3
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/server/routes/workflows.routes.ts`
- Modify: `apps/daemon/src/stores/ticket.store.ts`
- Modify: `apps/daemon/src/stores/project-workflow.store.ts`
- Modify: `apps/daemon/src/server/__tests__/workflows.routes.test.ts`
- Create: `apps/daemon/src/server/__tests__/tickets.routes.test.ts`

**Purpose:** Replace direct/implicit deletion behavior with explicit preview plus forced destructive confirmation for workflow deletion.

**Not In Scope:** Frontend modal UX.

**Gotchas:** Avoid raw SQL ticket deletes during workflow deletion; always use canonical service.

**Step 1: Write failing route tests**
- Add test for preflight endpoint returning ticket count/sample IDs for workflow.
- Add test that workflow delete without explicit force+confirm fails when tickets exist.
- Add test that workflow delete with valid force+confirm deletes tickets via service and then deletes workflow.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL on missing preflight/confirmation enforcement.

**Step 3: Implement route changes**
- Add `GET /api/projects/:projectId/workflows/:workflowId/delete-preview`.
- Extend delete endpoint to require explicit destructive flags when ticket count > 0.
- Use one explicit request contract for destructive delete (for example JSON body containing `force` plus a typed confirmation string) and document the exact field names in the test first.
- Iterate workflow tickets and call canonical ticket deletion service.
- Keep default-workflow and last-workflow safety guard behavior unless explicit product decision changes.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS with updated workflow deletion behavior.

**Step 5: Commit**
`git add apps/daemon/src/server/routes/workflows.routes.ts apps/daemon/src/stores/ticket.store.ts apps/daemon/src/stores/project-workflow.store.ts apps/daemon/src/server/__tests__/workflows.routes.test.ts apps/daemon/src/server/__tests__/tickets.routes.test.ts`
`git commit -m "feat: enforce explicit destructive workflow deletion path"`

### Task 5: Wire Project Delete To Canonical Destructive Path
**Depends on:** Task 3
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/server/routes/projects.routes.ts`
- Modify: `apps/daemon/src/stores/project.store.ts`
- Modify: `apps/daemon/src/stores/project-workflow.store.ts`
- Modify: `apps/daemon/src/server/__tests__/projects.routes.test.ts`

**Purpose:** Ensure project deletion does not bypass ticket lifecycle cleanup and does not break after `tickets.workflow_id` switches to `ON DELETE RESTRICT`.

**Not In Scope:** New frontend confirmation UX for project delete.

**Gotchas:** The current project delete route relies on raw store deletion and FK cascade. That is incompatible with the stricter workflow FK and bypasses session/chat/provider/file cleanup.

**Step 1: Write failing route tests**
- Add test for deleting a project with tickets:
  - calls canonical ticket deletion for each ticket before deleting workflows/project rows
  - succeeds even when the project still has a default workflow and multiple boards
  - returns a cleanup summary or at minimum `{ ok: true }` only after all ticket cleanup completes
- Add test that a failure inside ticket lifecycle cleanup aborts project deletion and leaves the project row intact.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL because project delete still bypasses canonical cleanup.

**Step 3: Implement project delete orchestration**
- In project delete flow, list every ticket for the project (archived and non-archived) and delete each through the canonical ticket deletion service.
- Delete workflows only after all tickets are gone, then delete the project row and any project-scoped filesystem data.
- Do not reuse the public workflow-delete guard for this internal path; default/last-workflow restrictions apply to user-facing workflow delete, not whole-project teardown.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS for project deletion under strict workflow FK semantics.

**Step 5: Commit**
`git add apps/daemon/src/server/routes/projects.routes.ts apps/daemon/src/stores/project.store.ts apps/daemon/src/stores/project-workflow.store.ts apps/daemon/src/server/__tests__/projects.routes.test.ts`
`git commit -m "feat: route project deletion through canonical ticket cleanup"`

### Task 6: Implement Aggressive Workflow Delete Warning UX
**Depends on:** Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Modify: `apps/frontend/src/components/configure/WorkflowsSection.tsx`
- Create: `apps/frontend/src/components/configure/DeleteWorkflowDialog.tsx`
- Create: `apps/frontend/src/components/configure/WorkflowsSection.test.tsx`

**Purpose:** Surface destructive workflow deletion risk clearly and block accidental actions.

**Not In Scope:** Backend enforcement logic.

**Gotchas:** Do not rely on client-only checks; backend enforcement remains authoritative.

**Step 1: Write failing frontend tests**
- Modal appears when deleting workflow with tickets.
- Modal displays ticket count and warning copy.
- Confirmation requires typed phrase before submit.
- Cancel path leaves workflow unchanged.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/frontend test -- --run WorkflowsSection.test.tsx`
Expected: FAIL for missing modal behavior.

**Step 3: Implement UI flow**
- Fetch delete preview before final delete request.
- For count > 0, require typed confirm string and explicit destructive button.
- On success, invalidate workflow and ticket queries.
- If the deleted workflow is currently selected anywhere in the UI state, ensure the app redirects or refetches to a surviving workflow instead of leaving a dead route selected.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/frontend test -- --run WorkflowsSection.test.tsx`
Expected: PASS for destructive modal behavior.

**Step 5: Commit**
`git add apps/frontend/src/api/client.ts apps/frontend/src/hooks/queries.ts apps/frontend/src/components/configure/WorkflowsSection.tsx apps/frontend/src/components/configure/DeleteWorkflowDialog.tsx apps/frontend/src/components/configure/WorkflowsSection.test.tsx`
`git commit -m "feat: add aggressive workflow delete warning and confirmation"`

### Task 7: Remove Project Template Setting From Configure Surface
**Depends on:** Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/configure/ConfigurePage.tsx`
- Modify: `apps/frontend/src/hooks/useTemplateStatus.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Create: `apps/frontend/src/components/configure/ConfigurePage.test.tsx`

**Purpose:** Eliminate conceptual single-template UI now that workflow is the primary identity.

**Not In Scope:** Workflow-level upgrade UI (covered later).

**Gotchas:** Remove project-template controls while preserving unrelated configure settings.

**Step 1: Write failing tests**
- Assert Configure page no longer shows project Template selector section.
- Assert workflow controls remain visible.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/frontend test -- --run ConfigurePage.test.tsx`
Expected: FAIL before template section removal.

**Step 3: Implement UI removal and query cleanup**
- Remove `api.setProjectTemplate` usage from Configure page.
- Remove/replace project-template specific status banner references.
- Remove the old template-change confirmation modal state from Configure page so there is no dead code path still mutating project-level template state.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/frontend test -- --run ConfigurePage.test.tsx`
Expected: PASS with updated configure UX.

**Step 5: Commit**
`git add apps/frontend/src/components/configure/ConfigurePage.tsx apps/frontend/src/hooks/useTemplateStatus.ts apps/frontend/src/hooks/queries.ts apps/frontend/src/components/configure/ConfigurePage.test.tsx`
`git commit -m "refactor: remove project-level template configuration UI"`

### Task 8: Introduce Workflow Template State Migration And Storage Model
**Depends on:** Task 7
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/config/paths.ts`
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/project-workflow.store.ts`
- Modify: `packages/shared/src/types/workflow.types.ts`
- Modify: `apps/daemon/src/stores/__tests__/migrations.test.ts`
- Modify: `apps/daemon/src/stores/__tests__/project-workflow.store.test.ts`

**Purpose:** Add the data model and filesystem conventions required for workflow-scoped template versioning before any status/changelog/upgrade endpoint depends on them.

**Not In Scope:** Frontend rendering of upgrade state.

**Gotchas:** `project_workflows` currently stores only `template_name`, and project-level template storage uses one shared directory. Per-workflow upgrade/status work will be brittle until those foundations exist.

**Step 1: Write failing migration/store tests**
- Add test coverage for:
  - new workflow template metadata columns (at minimum current template version) are added and backfilled
  - workflow store exposes the new metadata
  - a workflow-local template directory helper/path is deterministic and unique per workflow

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL because workflow template state does not yet exist.

**Step 3: Implement workflow template state**
- Add a new schema migration (next version after V18) for workflow-scoped template metadata.
- Backfill each workflow's current template version from the best available source:
  - workflow-local copy if one exists
  - otherwise the project's recorded template version when the workflow uses that same template name
  - otherwise the global catalog template version
- Add a dedicated helper such as `getWorkflowTemplateDir(projectId, workflowId)` and use it as the canonical location for workflow-local template files.
- Extend the workflow store and shared workflow types to expose the workflow template version metadata needed by later tasks.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS for workflow template metadata and storage helpers.

**Step 5: Commit**
`git add apps/daemon/src/config/paths.ts apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/project-workflow.store.ts packages/shared/src/types/workflow.types.ts apps/daemon/src/stores/__tests__/migrations.test.ts apps/daemon/src/stores/__tests__/project-workflow.store.test.ts`
`git commit -m "feat: add workflow template state and storage foundations"`

### Task 9: Introduce Per-Workflow Template Status Changelog Upgrade APIs
**Depends on:** Task 7, Task 8
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/server/routes/workflows.routes.ts`
- Modify: `apps/daemon/src/server/routes/projects.routes.ts`
- Modify: `apps/daemon/src/stores/project-workflow.store.ts`
- Modify: `apps/daemon/src/stores/template.store.ts`
- Modify: `apps/daemon/src/stores/project-template.store.ts`
- Modify: `apps/daemon/src/server/__tests__/workflows.routes.test.ts`

**Purpose:** Shift upgrade/status/changelog behavior from project-level template state to workflow-level template identity.

**Not In Scope:** Frontend rendering of upgrade controls.

**Gotchas:** Clarify version source for workflow-specific local copies versus global catalog version. New workflows and template switches must initialize workflow-scoped metadata immediately, not lazily after the first upgrade call.

**Step 1: Write failing API tests**
- `GET /workflows/:id/template-status` returns current and available versions.
- `GET /workflows/:id/template-changelog` returns correct template changelog.
- `POST /workflows/:id/upgrade-template` updates workflow template version state and local files per selected strategy.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL for missing workflow-level template endpoints.

**Step 3: Implement endpoints and backing data model**
- Add workflow-scoped template version metadata if missing.
- Move current project-template status logic to workflow-based equivalents.
- On workflow create/update, initialize or switch workflow-local template state so newly created workflows already have valid status/changelog data.
- Keep compatibility endpoint behavior temporarily with explicit deprecation notes by mapping project-level template endpoints to the project's default workflow only. Return an explicit 409 if the compatibility route cannot determine a single workflow target safely.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS for new workflow template endpoints.

**Step 5: Commit**
`git add apps/daemon/src/server/routes/workflows.routes.ts apps/daemon/src/stores/project-workflow.store.ts apps/daemon/src/stores/template.store.ts apps/daemon/src/stores/project-template.store.ts apps/daemon/src/server/__tests__/workflows.routes.test.ts`
`git commit -m "feat: add per-workflow template status and upgrade APIs"`

### Task 10: Add Workflow-Scoped Upgrade UX
**Depends on:** Task 9
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/board/Board.tsx`
- Modify: `apps/frontend/src/components/ChangelogModal.tsx`
- Modify: `apps/frontend/src/components/TemplateUpgradeBanner.tsx`
- Modify: `apps/frontend/src/components/configure/WorkflowsSection.tsx`
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Modify: `apps/frontend/src/hooks/useTemplateStatus.ts`
- Create: `apps/frontend/src/components/configure/WorkflowTemplateUpgradePanel.tsx`
- Create: `apps/frontend/src/components/configure/WorkflowTemplateUpgradePanel.test.tsx`

**Purpose:** Make template updates visible and actionable per workflow board.

**Not In Scope:** Project-level upgrade banner.

**Gotchas:** Avoid introducing noisy upgrade UI for workflows with no available update.

**Step 1: Write failing tests**
- Panel shows per-workflow current/available version.
- Upgrade action appears only when upgrade is available.
- Changelog opens for the selected workflow.
- Board-level upgrade banner uses the active workflow, not project-wide status.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/frontend test -- --run WorkflowTemplateUpgradePanel.test.tsx`
Expected: FAIL before panel implementation.

**Step 3: Implement workflow upgrade UI**
- Add hooks and API calls for workflow status/changelog/upgrade.
- Render per-row upgrade state in Workflows section.
- Replace or repurpose the existing project-level board banner so it takes `workflowId` and never calls project-scoped template status endpoints.
- Update changelog modal wiring so it can load changelog content for the selected workflow.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/frontend test -- --run WorkflowTemplateUpgradePanel.test.tsx`
Expected: PASS for workflow upgrade behavior.

**Step 5: Commit**
`git add apps/frontend/src/components/board/Board.tsx apps/frontend/src/components/ChangelogModal.tsx apps/frontend/src/components/TemplateUpgradeBanner.tsx apps/frontend/src/components/configure/WorkflowsSection.tsx apps/frontend/src/components/configure/WorkflowTemplateUpgradePanel.tsx apps/frontend/src/api/client.ts apps/frontend/src/hooks/queries.ts apps/frontend/src/hooks/useTemplateStatus.ts apps/frontend/src/components/configure/WorkflowTemplateUpgradePanel.test.tsx`
`git commit -m "feat: add per-workflow template upgrade UX"`

### Task 11: Enforce Workflow-Scoped Agent Resolution With Parent Template Chain
**Depends on:** Task 9
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/stores/template.store.ts`
- Modify: `apps/daemon/src/stores/project-template.store.ts`
- Modify: `apps/daemon/src/server/routes/projects.routes.ts`
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/api/client.test.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Modify: `apps/frontend/src/components/board/AgentPromptEditor.tsx`
- Modify: `apps/daemon/src/stores/__tests__/template.store.test.ts`
- Modify: `apps/daemon/src/server/__tests__/projects-agents.routes.test.ts`

**Purpose:** Ensure agent defaults and overrides resolve from workflow template chain and `parentTemplate`, not project-template fallback.

**Not In Scope:** Brand-new agent editing surfaces. Existing prompt editor behavior must still be updated to send the correct workflow-scoped API contract.

**Gotchas:** Prevent cross-workflow override leakage. The current frontend fetches/deletes overrides without `workflowId`, so "reset to default" can target the wrong scope unless the API contract is fixed end-to-end.

**Step 1: Write failing tests**
- Workflow A override does not affect Workflow B.
- Missing agent in workflow template resolves from `parentTemplate` when present.
- Missing in chain returns explicit error.
- Frontend client/editor passes `workflowId` for get/save/delete override operations when a workflow-scoped board is active.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL on new workflow-chain resolution requirements.

**Step 3: Implement resolution chain and storage model**
- Add workflow-aware override lookup key strategy and store workflow-scoped overrides under the workflow-local template path, not the shared project template directory.
- Update GET/PUT/DELETE agent override routes plus frontend client methods so `workflowId` is handled consistently for read, save, and reset.
- Keep existing global template fallback only through parent chain, not project fallback.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS for template store and route behavior.

**Step 5: Commit**
`git add apps/daemon/src/stores/template.store.ts apps/daemon/src/stores/project-template.store.ts apps/daemon/src/server/routes/projects.routes.ts apps/frontend/src/api/client.ts apps/frontend/src/api/client.test.ts apps/frontend/src/hooks/queries.ts apps/frontend/src/components/board/AgentPromptEditor.tsx apps/daemon/src/stores/__tests__/template.store.test.ts apps/daemon/src/server/__tests__/projects-agents.routes.test.ts`
`git commit -m "refactor: resolve agents via workflow template parent chain"`

### Task 12: Remove Workflow Resolution Fallbacks And Return Critical Errors
**Depends on:** Task 11
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/phase-config.ts`
- Modify: `apps/daemon/src/stores/template.store.ts`
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`
- Modify: `apps/daemon/src/server/routes/dependencies.routes.ts`
- Modify: `apps/daemon/src/services/session/__tests__/phase-config.test.ts`
- Modify: `apps/daemon/src/stores/__tests__/template.store.workflow-context.test.ts`
- Modify: `apps/daemon/src/server/__tests__/ticket-input.routes.test.ts`

**Purpose:** Replace fallback behavior with explicit hard failures when workflow context is invalid or missing.

**Not In Scope:** Relaxed compatibility paths.

**Gotchas:** Error messages must be actionable for operators and UI.

**Step 1: Write failing tests**
- Invalid/missing workflow context returns 4xx/5xx with explicit code and message.
- No implicit fallback to project template when workflow resolution fails.
- Template resolution helpers used by routes/services also stop falling back silently when `workflowId` is missing, mismatched, or deleted.

**Step 2: Run tests to verify failure**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: FAIL where fallback is still active.

**Step 3: Implement strict behavior**
- In `phase-config`, reject unresolved workflow contexts.
- In `template.store`, remove helper-level fallback behavior that masks invalid workflow context.
- In ticket/dependency routes, require resolvable workflow identity for relevant operations.
- Add structured error codes for frontend handling.

**Step 4: Run tests to verify pass**
Run: `pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/daemon test`
Expected: PASS for strict no-fallback semantics.

**Step 5: Commit**
`git add apps/daemon/src/services/session/phase-config.ts apps/daemon/src/stores/template.store.ts apps/daemon/src/server/routes/tickets.routes.ts apps/daemon/src/server/routes/dependencies.routes.ts apps/daemon/src/services/session/__tests__/phase-config.test.ts apps/daemon/src/stores/__tests__/template.store.workflow-context.test.ts apps/daemon/src/server/__tests__/ticket-input.routes.test.ts`
`git commit -m "refactor: remove workflow fallback and enforce explicit errors"`

### Task 13: Documentation And End-To-End Verification
**Depends on:** Task 6, Task 10, Task 12, Task 5
**Complexity:** standard
**Files:**
- Modify: `README.md`
- Modify: `apps/daemon/src/stores/CLAUDE.md`
- Modify: `docs/session-lifecycle-rollout-runbook.md`
- Create: `docs/plans/strict-workflow-identity-test-matrix.md`

**Purpose:** Document the new conceptual model and provide reproducible manual verification checklist.

**Not In Scope:** Further feature additions.

**Gotchas:** Documentation must explicitly state destructive workflow delete semantics, project delete lifecycle cleanup semantics, and no-fallback policy.

**Step 1: Write docs verification checklist**
- Include migration safety notes, destructive warning behavior, project-delete cleanup behavior, and per-workflow upgrade flow.
- Include explicit API contract snippets.

**Step 2: Run quality checks**
Run: `pnpm --filter @potato-cannon/shared build && pnpm --filter @potato-cannon/daemon build && pnpm --filter @potato-cannon/frontend build`
Expected: PASS.

**Step 3: Run targeted test suites**
Run: `pnpm --filter @potato-cannon/daemon test && pnpm --filter @potato-cannon/frontend test -- --run api/client.test.ts WorkflowsSection.test.tsx ConfigurePage.test.tsx WorkflowTemplateUpgradePanel.test.tsx`
Expected: PASS.

**Step 4: Commit**
`git add README.md apps/daemon/src/stores/CLAUDE.md docs/session-lifecycle-rollout-runbook.md docs/plans/strict-workflow-identity-test-matrix.md`
`git commit -m "docs: describe strict workflow model and destructive deletion flow"`

## Rollout Notes

- Run migration in local environment with backup first.
- Validate delete-preview and destructive confirmation UX before broad team usage.
- Validate project deletion against a project that has active sessions, chat threads, archived tickets, and multiple workflows before broad team usage.
- Communicate project-template endpoint deprecation to internal consumers.

## Acceptance Criteria Summary

- Tickets cannot exist without workflow identity after migration.
- New projects and newly created tickets always resolve a valid workflow identity.
- Deleting workflows with tickets requires explicit destructive confirmation and performs canonical cleanup.
- Project deletion also routes ticket teardown through the canonical lifecycle cleanup implementation.
- All ticket deletion paths use one service-level lifecycle cleanup implementation.
- Upgrade/changelog/status are workflow-scoped.
- Agent resolution follows workflow template and parent template chain.
- Invalid workflow context yields critical errors, not fallback behavior.

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | PASS | Plan covers schema, workflow bootstrap, destructive delete paths, API, service, UI, migration, tests, docs, and rollout constraints from requirements. |
| Accurate | PASS | Existing module paths were verified against the repository; newly introduced test files are called out explicitly as `Create` work. |
| Commands valid | PASS | Uses repo-supported `pnpm --filter` build and test commands from package scripts, including shared package build when shared types change. |
| YAGNI | PASS | Scope focuses on strict workflow identity, deletion lifecycle, and workflow-scoped template behavior only. |
| Minimal | PASS | Tasks are separated by risk boundary and dependency, no redundant feature tracks. |
| Not over-engineered | PASS | Reuses existing chat/session cleanup paths and workflow model instead of introducing parallel systems. |
| Key Decisions documented | PASS | Header includes five explicit decisions with rationale aligned to requested direction. |
| Context sections present | PASS | Each task includes Purpose and most boundary-sensitive tasks include Not In Scope and Gotchas. |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | PASS | 2 | Added implementation guardrails and explicit new tasks for workflow bootstrap plus project-delete cleanup. |
| Feasibility | PASS | 3 | Corrected non-existent test targets, added shared build coverage, and introduced workflow template state migration before workflow upgrade APIs. |
| Completeness | PASS | 4 | Closed gaps around project deletion, default-workflow bootstrapping, board-level upgrade UI, and workflow-scoped override/reset flows. |
| Risk | PASS | 3 | Made `ON DELETE RESTRICT` implications explicit and required canonical deletion service reuse for all bulk-destructive paths. |
| Optimality | PASS | 2 | Kept project-level template endpoints as temporary compatibility wrappers targeting the default workflow instead of maintaining two runtime sources of truth. |
