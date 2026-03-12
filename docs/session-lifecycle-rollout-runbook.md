# Session Lifecycle Hardening Rollout Runbook

Date: 2026-03-11
Owner: Daemon Session Orchestration

## Rollout Flags

Configure in global daemon config:

```json
{
  "daemon": {
    "port": 8443,
    "lifecycleHardening": {
      "strictStaleDrop": false,
      "strictStaleResume409": false
    },
    "lifecycleContinuity": {
      "enabled": true,
      "allowResumeSameSwimlane": true
    }
  }
}
```

- `strictStaleDrop`
  - `true`: stale completion callbacks (generation mismatch) are dropped.
  - `false`: callback is allowed and logged as legacy mode.
- `strictStaleResume409`
  - `true`: stale/missing ticket input identity returns `409 STALE_TICKET_INPUT`.
  - `false`: legacy acceptance path writes response and avoids strict 409 rejection.
- `lifecycleContinuity.enabled`
  - `true`: decision policy can choose `resume`, `handoff`, or `fresh`.
  - `false`: continuity always resolves to `fresh` with reason `disabled` (legacy prompt path).
- `lifecycleContinuity.allowResumeSameSwimlane`
  - `true`: same-lifecycle resume remains eligible when compatibility checks pass.
  - `false`: same-lifecycle resume is skipped and handoff/fresh is selected.

## Recommended Rollout Sequence

1. Enable `lifecycleContinuity.enabled=true` while keeping `allowResumeSameSwimlane=true`.
2. Enable `strictStaleResume409=true`, keep `strictStaleDrop=false`.
3. Observe continuity decision distribution and stale-input rejection rate.
4. Enable `strictStaleDrop=true`.
5. Keep all three flags enabled after one release window with stable metrics.

## Expected Log Signatures

- `Dropping stale completion callback`
- `Strict stale-drop disabled; allowing callback despite generation mismatch`
- `Dropped stale ticket input for <ticketId>`
- `Strict stale-resume enforcement disabled; allowing legacy recovery`
- `Ticket lifecycle changed concurrently` (`TICKET_LIFECYCLE_CONFLICT`)
- `Continuity decision for ticket spawn`
- `Continuity decision for suspended resume`
- Structured continuity keys on decision logs:
  - `continuity_mode=resume|handoff|fresh`
  - `continuity_reason=<enum>`
  - `continuity_scope=<enum|none>`
  - `continuity_source_session_id=<id|none>`
  - `continuity_resume_rejected=true|false`

## Telemetry/Alert Thresholds

- `STALE_TICKET_INPUT` responses:
  - warn if > 5% of ticket input POSTs over 15m
  - page if > 15% over 15m
- stale callback drops:
  - warn if > 20/hour per project
- lifecycle conflicts:
  - warn if > 10/hour per project
  - investigate drag/restart burst behavior if sustained

## Scenario Matrix Checklist

- Architecture active -> move to Backlog -> no stale continuation.
- Build mid-task -> move away -> move back -> entry worker sees re-entry task summary.
- Crash/restart -> only generation-matching recovery resumes.
- Stale input after move -> `409 STALE_TICKET_INPUT` when strict mode enabled.
- Concurrent move/restart -> one committed lifecycle path (`409` conflict on loser).
- Stale callback after replacement spawn -> dropped when strict stale-drop enabled.
- Spawn failure leaves `spawn_pending` and startup recovery respawns once.
- Startup with both pending response + worker-state -> pending response precedence path wins.
- Continuity disabled (`lifecycleContinuity.enabled=false`) -> no handoff/resume injection, decision reason is `disabled`.
- Startup recovery respawn emits the same continuity decision log keys as normal ticket spawn.
- Restart-to-earlier-phase emits continuity decision logs before new session spawn.

## Strict Workflow Identity Checks

- Ticket and dependency reads fail with explicit workflow context errors when workflow identity is missing/invalid.
- No project-template fallback is used for phase resolution when workflow context is required.
- Workflow-template upgrade/status/changelog is invoked per workflow.

Status mapping:

- `WORKFLOW_ID_REQUIRED` -> `400`
- `WORKFLOW_NOT_FOUND` -> `404`
- `WORKFLOW_SCOPE_MISMATCH` -> `409`
- `WORKFLOW_TEMPLATE_NOT_FOUND` -> `404`

Example response:

```json
{
  "code": "WORKFLOW_ID_REQUIRED",
  "error": "workflowId is required for project <projectId>",
  "message": "workflowId is required for project <projectId>",
  "retryable": false
}
```

## Destructive Delete Verification

Workflow delete (with tickets):

1. `GET /api/projects/:projectId/workflows/:workflowId/delete-preview`
2. Confirm `requiresForce=true`, `expectedConfirmation=delete-workflow:{workflowId}`
3. `DELETE /api/projects/:projectId/workflows/:workflowId` with:

```json
{
  "force": true,
  "confirmation": "delete-workflow:<workflowId>"
}
```

4. Verify response includes `deletedTickets > 0` and that ticket lifecycle cleanup occurred.

Project delete:

1. `DELETE /api/projects/:id`
2. Verify response includes `cleanup.deletedTickets` and `cleanup.deletedWorkflows`
3. Verify project-scoped files are removed and no orphan ticket sessions/routes remain.

Example project delete response:

```json
{
  "ok": true,
  "cleanup": {
    "deletedTickets": 4,
    "deletedWorkflows": 2
  }
}
```

## Per-Workflow Template Upgrade Flow

Use workflow-scoped APIs only:

1. `GET /api/projects/:projectId/workflows/:workflowId/template-status`
2. `GET /api/projects/:projectId/workflows/:workflowId/template-changelog`
3. `POST /api/projects/:projectId/workflows/:workflowId/upgrade-template`

Example upgrade response:

```json
{
  "upgraded": true,
  "previousVersion": "1.2.0",
  "newVersion": "1.3.0",
  "upgradeType": "minor"
}
```

## Rollback

1. Set both flags to `false`.
2. Restart daemon.
3. Verify logs now show legacy-mode messages and no strict-drop enforcement.
4. Keep generation-aware invalidation/move logic intact; only strict fencing is relaxed.
