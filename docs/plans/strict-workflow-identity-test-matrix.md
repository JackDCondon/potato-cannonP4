# Strict Workflow Identity Test Matrix

Date: 2026-03-12
Owner: Daemon + Frontend
Scope: Manual end-to-end verification for strict workflow identity, destructive deletes, and workflow-scoped template upgrades.

## Preconditions

- Daemon and frontend are running from current branch.
- A test project exists with at least two workflows:
  - one default workflow
  - one non-default workflow
- Non-default workflow has at least one ticket.
- Capture a backup of `~/.potato-cannon/potato.db` before migration testing.

## Migration Safety

1. Start from a database snapshot that contains legacy `tickets.workflow_id IS NULL` rows.
2. Start daemon so migrations run.
3. Verify schema version is `19`.
4. Verify `tickets.workflow_id` is `NOT NULL` and FK is `ON DELETE RESTRICT`.
5. Verify legacy null-workflow tickets are removed.

Expected:

- Migration logs include V18 strict rebuild messaging.
- No runtime fallback path recreates null-workflow tickets.

## Workflow Context Enforcement (No Fallback)

### Case A: Missing workflow context

1. Request an endpoint that resolves phases via ticket workflow where ticket/workflow context is missing.
2. Observe response payload.

Expected:

- HTTP `400`
- `code=WORKFLOW_ID_REQUIRED`
- `retryable=false`

### Case B: Unknown workflow

1. Use a non-existent workflow ID in a workflow-scoped call.

Expected:

- HTTP `404`
- `code=WORKFLOW_NOT_FOUND`

### Case C: Cross-project workflow misuse

1. Use a real workflow from project B against project A route.

Expected:

- HTTP `409`
- `code=WORKFLOW_SCOPE_MISMATCH`

### Case D: Missing workflow template payload

1. Configure workflow to reference a missing template.
2. Trigger phase resolution.

Expected:

- HTTP `404`
- `code=WORKFLOW_TEMPLATE_NOT_FOUND`

## Workflow Delete (Destructive) Matrix

### Case A: Delete default workflow

1. `DELETE /api/projects/:projectId/workflows/:workflowId` on default workflow.

Expected:

- HTTP `400`
- error states default workflow cannot be deleted.

### Case B: Delete last workflow

1. Ensure project has one remaining workflow.
2. Attempt delete.

Expected:

- HTTP `400`
- error states last workflow cannot be deleted.

### Case C: Delete non-default workflow with tickets, no force token

1. Call delete without `{ force: true, confirmation }`.

Expected:

- HTTP `400`
- payload includes `expectedConfirmation` and `ticketCount`.

### Case D: Delete non-default workflow with correct force token

1. `GET /api/projects/:projectId/workflows/:workflowId/delete-preview`
2. Capture `expectedConfirmation`.
3. `DELETE /api/projects/:projectId/workflows/:workflowId` with:

```json
{
  "force": true,
  "confirmation": "delete-workflow:<workflowId>"
}
```

Expected:

- HTTP `200`
- `{ ok: true, deletedTickets: <n> }`
- each ticket deleted through canonical lifecycle cleanup (session termination + queue/route/thread cleanup + store delete).

## Project Delete Lifecycle Cleanup

1. Create project with multiple workflows and tickets.
2. Call `DELETE /api/projects/:id`.
3. Inspect response and datastore/filesystem.

Expected:

- HTTP `200`
- response includes:

```json
{
  "ok": true,
  "cleanup": {
    "deletedTickets": "<number>",
    "deletedWorkflows": "<number>"
  }
}
```

- No tickets remain for project.
- No workflows remain for project.
- Project-scoped data directory is removed.
- No active ticket sessions remain for deleted tickets.

## Per-Workflow Upgrade Flow

1. Open Configure page and inspect each workflow panel.
2. For a workflow with available upgrade:
  - open changelog
  - run upgrade
3. For major upgrade:
  - verify confirmation dialog appears before mutation.

Expected:

- UI calls workflow-scoped endpoints:
  - `GET /api/projects/:projectId/workflows/:workflowId/template-status`
  - `GET /api/projects/:projectId/workflows/:workflowId/template-changelog`
  - `POST /api/projects/:projectId/workflows/:workflowId/upgrade-template`
- Version display updates for only the targeted workflow.
- Non-target workflows remain unchanged.

## Agent Override Scope

1. Save override for workflow A.
2. Query same agent override for workflow B.
3. Reset override in workflow A.

Expected:

- Workflow A override does not leak into workflow B.
- Delete/reset honors `workflowId` query scoping.

## Verification Command Checklist

Run:

```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/frontend build
pnpm --filter @potato-cannon/daemon test
pnpm --filter @potato-cannon/frontend test -- --run api/client.test.ts WorkflowsSection.test.tsx ConfigurePage.test.tsx WorkflowTemplateUpgradePanel.test.tsx
```

Expected:

- All commands pass.
- No failing tests in strict workflow identity or destructive deletion paths.
