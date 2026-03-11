# Ticket Session Lifecycle Hardening Design

> **For Claude:** After human approval, use plan2beads to convert this design/plan into a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Date:** 2026-03-11
**Status:** Proposed
**Owner:** Daemon Session Orchestration

## Goal

Make ticket automation robust across phase moves, daemon restarts, and crashes by enforcing a single, uniform lifecycle policy:

1. moving phases always invalidates prior session execution state
2. stale sessions cannot mutate current ticket progress
3. phase entry workers (including task-master-like workers) are idempotent and can self-skip using durable state

## Problem Statement

Observed failure modes:

1. ticket moves can leave old active sessions alive while the ticket is now in a different phase
2. restart/crash recovery may re-run from the wrong point if stale callbacks race with newer intent
3. users moving Build -> Backlog -> Build can see duplicated orchestration work unless entry workers are idempotent

Relevant current code paths:

- move/update route spawns for new phase but does not consistently terminate old context first:
  - `apps/daemon/src/server/routes/tickets.routes.ts`
- phase restart is destructive and separate:
  - `apps/daemon/src/services/ticket-restart.service.ts`
- worker state + recovery exists and is strong, but needs stale fencing:
  - `apps/daemon/src/services/session/worker-state.ts`
  - `apps/daemon/src/services/session/worker-executor.ts`
  - `apps/daemon/src/server/server.ts`

## Design Principles

1. uniform semantics across all phases and swimlanes (no Build-specific branch logic)
2. separate durable progress from ephemeral execution cursor
3. enforce monotonic intent with generation fencing
4. preserve explicit restart/rollback semantics as a separate destructive operation

## Key Decisions

1. **Execution Generation Fence**
- Add a monotonic `execution_generation` integer per ticket.
- Increment generation whenever phase change invalidates current execution intent.
- Stamp sessions and worker-state with generation.
- Any completion/recovery/resume path with stale generation is ignored.

2. **Move Semantics Are Non-Destructive but Invalidating**
- Phase move must:
  - terminate existing ticket session (if active)
  - cancel pending question wait path
  - clear ephemeral worker cursor for that ticket
  - increment generation
  - optionally spawn for target phase if automation exists
- Must not delete durable artifacts/tasks/history. That remains restart-only behavior.

3. **Restart Semantics Remain Destructive**
- Existing restart endpoint keeps cleanup behavior.
- It also increments `execution_generation` and follows same termination primitive.

4. **Entry Workers Must Be Idempotent**
- Worker 0 (task master / planner) always runs by policy.
- It self-skips if durable task state indicates planning is already complete and actionable tasks exist.
- No phase-specific bypass logic in orchestrator.

5. **Recovery and Resume Must Validate Current Intent**
- Startup recovery only resumes if worker-state generation == ticket generation and phase still has automation.
- Input/resume endpoint validates same generation/phase constraints before resume.

6. **Generation Tagging for Pending Prompt/Response Is Mandatory**
- Every pending question/response written for ticket automation must include generation.
- Resume/recovery paths must reject mismatched generation as stale.
- No fallback path may resume or spawn from an untagged pending response for tickets.

7. **Lifecycle Invalidation Uses Transactional + CAS Semantics**
- Move/restart invalidation writes occur inside a single DB transaction.
- Generation bump is atomic (`execution_generation = execution_generation + 1`) and returns the authoritative new value.
- Mutations that depend on prior phase/generation use compare-and-swap preconditions to prevent concurrent move/restart races.
- Session spawn happens post-commit and is stamped with committed generation.

8. **CAS Conflicts Use Explicit Retryable API Contract**
- If move/restart CAS preconditions fail, API returns `409` with:
  - `code: "TICKET_LIFECYCLE_CONFLICT"`
  - `currentPhase`
  - `currentGeneration`
  - `retryable: true`
- Server may perform one internal read-refresh retry; if conflict remains, return the same `409` contract.
- Conflict is never surfaced as generic `500`.

9. **Durable Spawn Intent Marker Prevents Lost Post-Commit Spawns**
- In the same transaction that bumps generation and updates phase, write a durable worker-state root marker:
  - `executionGeneration`
  - `phaseId`
  - `pendingSpawn: true`
  - `spawnRequestedAt`
- Post-commit spawn attempt clears `pendingSpawn` only after a session record is successfully created.
- Recovery loop treats `pendingSpawn: true` + no active session + generation match as authoritative resume intent.

10. **Worker-State Root Must Be a Discriminated Union**
- Worker-state root is not a free-form object; it must be one of:
  - `kind: "active"` with full orchestration fields (`phaseId`, `executionGeneration`, `workerIndex`, `activeWorker`, `updatedAt`)
  - `kind: "spawn_pending"` with spawn marker fields (`phaseId`, `executionGeneration`, `pendingSpawn: true`, `spawnRequestedAt`, `updatedAt`)
- Generic execution/recovery paths must branch on `kind` before reading worker-executor fields.
- `spawn_pending` is never passed into normal worker traversal logic.

## Data Model Changes

1. tickets table
- add `execution_generation INTEGER NOT NULL DEFAULT 0`

2. sessions table
- add `execution_generation INTEGER` (nullable for legacy rows)
- add partial unique index:
  - `UNIQUE(ticket_id, execution_generation) WHERE ended_at IS NULL AND ticket_id IS NOT NULL AND execution_generation IS NOT NULL`

3. worker_state payload
- replace ad-hoc root with a discriminated union:
  - active root:
    - `kind: "active"`
    - `phaseId`
    - `executionGeneration`
    - `workerIndex`
    - `activeWorker`
    - `updatedAt`
  - spawn-pending root:
    - `kind: "spawn_pending"`
    - `phaseId`
    - `executionGeneration`
    - `pendingSpawn: true`
    - `spawnRequestedAt`
    - `updatedAt`
- helper guards are mandatory:
  - `isActiveWorkerStateRoot`
  - `isSpawnPendingWorkerStateRoot`

4. pending question/response metadata (required)
- question payload requires:
  - `questionId` (canonical)
  - `conversationId` (compat alias, equal to `questionId` for one release window)
  - `ticketGeneration`
  - `phaseAtAsk`
- response payload requires:
  - `questionId` (canonical)
  - `ticketGeneration`
- resume only accepted when both ids/generation match current pending question + ticket generation
- transition rules:
  - new writes must include `questionId`, `ticketGeneration`, and `phaseAtAsk`
  - during migration, readers accept `conversationId` as alias only when `questionId` is absent
  - untagged legacy ticket payloads (no generation) are stale and must be rejected + deleted
- shared/frontend contracts must be updated in lockstep with backend payload schema

5. index/constraint guard for active-session dedupe
- add a durable dedupe guard for active ticket sessions per ticket generation (index/lock strategy)

## Runtime Contract

### Ticket move (phase changed)

1. read ticket and old phase
2. if phase changed, run one DB transaction:
- atomically bump `execution_generation` with CAS-safe update semantics
- write phase update
- replace worker-state with generation-stamped root (`pendingSpawn: true`)
- logically end existing active ticket session row (if any) as part of invalidation
3. after commit, run logical teardown side effects before replacement spawn:
- cancel wait-for-response path for ticket
- clear pending question/response files
- request PTY/process termination best-effort (idempotent)
4. after logical teardown, if target phase has workers, spawn new session bound to committed generation
5. if spawn fails, do not roll back generation/phase; keep `pendingSpawn: true`, emit structured error, and rely on recovery loop
6. if CAS precondition fails, return explicit retryable `409` conflict payload (never `500`)

### Session completion callback

1. resolve current ticket generation
2. compare with session generation
3. if stale:
- no-op completion state transitions
- no phase transition
- no task status writes
- no ralph feedback writes
- no ticket blocked/unblocked writes
- no worker-state mutation
- no spawn/resume side effects

### Recovery loop

1. for ticket with worker-state and no active session:
- resume only when state generation matches current ticket generation
- if `pendingSpawn: true` and generation matches, spawn/retry and keep marker until session record exists
- otherwise clear stale worker-state and do not respawn stale path

### Resume suspended session

1. validate ticket currently automation-enabled
2. validate pending response/question generation matches ticket generation
3. if mismatch: reject stale resume with `409` and clear stale pending files
4. if pending response is untagged legacy ticket data, reject as stale and clear files

### Transaction and Side-Effect Boundaries

1. DB transaction includes only DB writes:
- phase mutation
- generation bump
- worker-state root replacement with `pendingSpawn`
 - logical close of prior active ticket session row (if present)
2. Non-DB actions are outside transaction and must be idempotent/retry-safe:
- PTY/process termination
- in-memory wait cancellation
- filesystem pending question/response cleanup
3. Replacement spawn must run only after logical teardown actions execute.
4. Correctness depends on generation fence + `pendingSpawn`, not on PTY kill timing.

## UX and Product Behavior

1. User drags ticket away from active phase:
- session is cancelled quickly
- ticket reflects new phase immediately
- no hidden background execution from old phase

2. User returns ticket later:
- fresh phase entry begins
- entry worker can skip itself by inspecting durable tasks/history

3. User wants destructive rewind:
- use existing restart phase action (explicit, warning-heavy)

## Risks and Mitigations

1. **Race between kill and process exit callback**
- Mitigation: keep/use `forceKilled` marking and generation fence checks in callback path.

2. **Stale resume answers accidentally resurrect old phase execution**
- Mitigation: generation-tag pending prompts and validate on resume.

3. **Excessive respawn churn during rapid drag/drop**
- Mitigation: durable spawn dedupe guard per ticket + generation; optional short debounce in move handler.

4. **Migration compatibility with old rows/state**
- Mitigation:
  - tickets keep default `0`
  - legacy `sessions.execution_generation IS NULL` is always treated as stale in completion/recovery (never coerced to current generation)
  - missing worker-state generation is treated as stale legacy state and cleared before any resume
  - untagged pending ticket question/response is rejected as stale and deleted

5. **Concurrent move/restart races**
- Mitigation: CAS preconditions on generation/phase updates plus transactional invalidation helper.

6. **Rollout regression risk from strict stale fencing**
- Mitigation: rollout with feature flags for strict stale-drop enforcement and stale-resume `409`, plus fast rollback toggles.

## Non-Goals

1. not introducing per-phase orchestration branching
2. not changing destructive restart semantics beyond fencing integration
3. not introducing new UI complexity for phase move beyond existing confirmations

## Success Criteria

1. no stale session can mutate ticket after phase move
2. daemon restart does not restart obsolete phase work after intentional move-back
3. Build -> Backlog -> Build does not duplicate planned tasks when planner can infer existing durable task state
4. no Build-only code path in orchestrator

## Rollout Strategy

1. ship generation field and stale-fence guards first (safe, mostly no behavior change)
2. add transactional invalidation + CAS generation bump in move/restart paths
3. enable recovery/resume generation validation with explicit `409` stale responses
4. enforce durable spawn dedupe guard per ticket generation
5. make entry worker idempotency explicit and tested
6. monitor logs/metrics for stale-drop counts, spawn churn, and `409` mismatch rates
7. keep feature flags for strict stale-drop and stale-resume `409` until one release window passes cleanly
8. monitor lifecycle conflict rate (`TICKET_LIFECYCLE_CONFLICT`) and retry success ratio

## Open Questions

1. Should drag/drop move use small debounce for rapid lane crossing?
2. Should we expose generation/debug status in session viewer for supportability?

## AI Implementation Contract

Use this ordering and do not deviate:

1. invalidate intent transactionally (phase + generation + worker-state + logical session-row close)
2. perform logical teardown side effects (cancel wait, clear pending files)
3. attempt replacement spawn
4. keep `spawn_pending` durable marker until session row exists

Mandatory precedence for ticket response/recovery entry points:

1. stale generation/question mismatch => reject and cleanup
2. valid suspended response => resume suspended session path
3. `spawn_pending` marker => spawn/retry path
4. active worker-state recovery => resume executor path
