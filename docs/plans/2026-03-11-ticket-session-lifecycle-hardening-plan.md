# Ticket Session Lifecycle Hardening Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Implement uniform ticket session lifecycle hardening so phase moves cancel obsolete execution, crash recovery is generation-safe, and re-entry workers self-skip via durable state.

**Architecture:** Add a monotonic ticket `execution_generation` fence, propagate generation into session + worker state, centralize terminate-and-reconcile lifecycle logic for move/restart/recovery paths, and make entry worker behavior idempotent without phase-specific orchestrator branches.

**Tech Stack:** Node/TypeScript daemon, SQLite migrations/stores, Express routes, worker executor/session service, Vitest integration/unit tests.

**Key Decisions:**
- **Generation fence:** authoritative stale-execution guard across move/restart/recovery
- **Uniform move semantics:** phase change always invalidates ephemeral execution and cancels active session
- **Non-destructive moves:** durable tasks/artifacts/history preserved on normal moves
- **Destructive restart remains explicit:** restart endpoint keeps cleanup behavior
- **Worker idempotency over orchestrator branching:** entry worker decides skip/continue from durable state
- **Mandatory prompt/response generation tags:** no optional stale fencing paths for tickets
- **Transactional + CAS invalidation:** generation bump and lifecycle invalidation happen atomically
- **Explicit stale resume contract:** stale user input is rejected with `409` and actionable payload
- **Explicit lifecycle conflict contract:** CAS conflicts return retryable `409 TICKET_LIFECYCLE_CONFLICT`, never generic `500`
- **Durable spawn intent marker:** post-commit spawn reliability is enforced with `pendingSpawn` in worker-state root

---

## Scope Summary

In scope:
1. DB migration for generation metadata
2. session + worker state generation propagation
3. phase-move lifecycle refactor (terminate, invalidate, respawn)
4. recovery/resume stale-generation guards
5. idempotent entry-worker contract and tests
6. race/concurrency hardening for move/restart/callback interleavings
7. rollout flags and rollback guardrails for strict stale enforcement
8. startup recovery dedupe + lost-spawn recovery guarantees

Out of scope:
1. changing UI flow significantly beyond current move/restart behaviors
2. build-only special handling in orchestrator
3. deleting durable data on normal moves

---

## Task 1: Add Execution Generation Schema Support
**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/ticket.store.ts`
- Modify: `apps/daemon/src/stores/session.store.ts`
- Modify: `apps/daemon/src/types/session.types.ts`
- Modify: `apps/daemon/src/services/session/types.ts`
- Modify: `packages/shared/src/types/ticket.types.ts`
- Modify: `packages/shared/src/types/session.types.ts`
- Modify: `packages/shared/src/types/conversation.types.ts`
- Test: `apps/daemon/src/stores/__tests__/migrations.test.ts` (or nearest migration test file)

**Purpose:** Add durable, queryable generation data used for stale fencing.

### Step 1: Write failing migration + store tests
- Add tests that expect:
  - tickets include `execution_generation` default `0`
  - sessions can persist generation metadata

### Step 2: Implement migration
- Add next schema version migration:
  - `tickets.execution_generation INTEGER NOT NULL DEFAULT 0`
  - `sessions.execution_generation INTEGER` (nullable for back-compat)
  - add explicit partial unique index:
    - `UNIQUE(ticket_id, execution_generation) WHERE ended_at IS NULL AND ticket_id IS NOT NULL AND execution_generation IS NOT NULL`

### Step 3: Plumb types and store projections
- Include generation fields in ticket/session read/write DTOs.
- Ensure session create/read APIs always carry non-null generation when `ticket_id` is present for new rows.
- Define legacy behavior explicitly:
  - `sessions.execution_generation IS NULL` is read as legacy-only and treated as stale for callback/recovery gating.
- Thread generation through daemon callback surfaces:
  - `CreateSessionInput`
  - `StoredSession`
  - `SessionMeta`
  - in-memory `ActiveSession`
- Ensure PTY exit callback has enough identity to enforce stale fencing deterministically:
  - either pass `executionGeneration` directly
  - or pass `sessionId` with required lookup contract

### Step 4: Run tests
Run:
- `pnpm --filter @potato-cannon/daemon test -- migrations`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): add execution generation schema for ticket/session lifecycle"`

---

## Task 2: Add Generation to Worker State Root and Helpers
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/types/orchestration.types.ts`
- Modify: `apps/daemon/src/services/session/worker-state.ts`
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Test: `apps/daemon/src/services/session/__tests__/worker-state.test.ts`

**Purpose:** Ensure worker-state recovery/continuation is tied to current ticket intent generation.

### Step 1: Write failing worker-state tests
- Add tests for:
  - state includes generation at init
  - prepare/recovery preserves generation
  - mismatch detection helper returns stale indication
  - legacy worker-state without generation is treated as stale/legacy-safe (cleared or re-init)

### Step 2: Implement model updates
- Replace ad-hoc root with discriminated union:
  - `kind: "active"`
  - `kind: "spawn_pending"`
- Add `executionGeneration` to both root variants.
- Initialize from ticket generation when phase starts.
- Add strict parser/default handling for legacy state payloads with missing generation.

### Step 3: Add helper API
- Add helper(s) to compare ticket generation and stored worker-state generation.
- Add mandatory root-kind guards:
  - `isActiveWorkerStateRoot`
  - `isSpawnPendingWorkerStateRoot`
- Enforce that generic executor traversal only accepts `kind: "active"`.

### Step 4: Run tests
Run:
- `pnpm --filter @potato-cannon/daemon test -- worker-state`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): add generation-aware worker state model"`

---

## Task 3: Centralize Ticket Lifecycle Invalidations
**Depends on:** Task 1, Task 2
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`
- Modify: `apps/daemon/src/services/ticket-restart.service.ts`
- Modify: `apps/daemon/src/stores/chat.store.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`
- Test: `apps/daemon/src/server/__tests__/tickets-lifecycle.routes.test.ts` (new file if needed)

**Purpose:** Enforce one shared termination + invalidation behavior across move/restart flows.

**Not In Scope:** deleting durable artifacts/tasks on normal move.

### Step 1: Add failing integration tests
- Moving ticket from automated phase to non-automated phase:
  - active session terminated
  - generation incremented
  - worker-state cleared/invalidated
- Moving to another automated phase:
  - old session terminated
  - new session spawned under new generation
- Concurrent move/move and move/restart requests do not create split-brain generation/phase outcomes.
- CAS conflicts return explicit retryable `409` payload with current phase/generation.

### Step 2: Implement shared lifecycle helper
- Add internal helper in session service (or dedicated module):
  - DB transaction (DB writes only):
    - CAS-check phase/generation precondition
    - write new phase
    - bump generation atomically
    - replace worker-state root with `executionGeneration`, `phaseId`, `pendingSpawn: true`, `spawnRequestedAt`
    - logically close prior active ticket session row (if present)
  - non-DB idempotent side effects (outside transaction):
    - cancel waits/pending chat state
    - clear pending question/response files
    - terminate active PTY/process (`forceKilled` path)
  - return committed generation value and conflict status

### Step 3: Enforce transaction boundary
- Ensure phase update + generation bump + invalidation writes execute in one DB transaction.
- Ensure logical teardown side effects run before replacement spawn.
- Ensure spawn is post-commit and uses committed generation.
- On spawn failure, leave committed state intact with `pendingSpawn: true` and rely on recovery.
- On successful session creation, clear `pendingSpawn`.

### Step 4: Wire move route
- In `PUT /api/tickets/:project/:id`, when `phase` changes:
  - call invalidation helper before spawn decision
  - ensure spawn uses current generation
  - map CAS conflicts to `409`:
    - `code: "TICKET_LIFECYCLE_CONFLICT"`
    - `currentPhase`
    - `currentGeneration`
    - `retryable: true`

### Step 5: Wire restart service
- Restart should also bump generation and use same terminate/invalidate helper while retaining destructive cleanup.
- Restart conflict semantics must match move route (`409 TICKET_LIFECYCLE_CONFLICT`).

### Step 6: Run tests
Run:
- `pnpm --filter @potato-cannon/daemon test -- session.service`
- `pnpm --filter @potato-cannon/daemon test -- tickets-lifecycle`
Expected:
- PASS

### Step 7: Commit
- `git commit -m "feat(daemon): unify phase-change session invalidation with generation fencing"`

---

## Task 4: Stale Callback, Recovery, and Resume Guards
**Depends on:** Task 3
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Modify: `apps/daemon/src/server/server.ts`
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`
- Modify: `apps/daemon/src/stores/chat.store.ts`
- Modify: `apps/daemon/src/providers/telegram/telegram.provider.ts` (if callback remains local)
- Modify: `apps/daemon/src/providers/slack/slack.provider.ts` (if callback remains local)
- Modify: `apps/daemon/src/types/session.types.ts`
- Modify: `apps/daemon/src/services/session/types.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/worker-executor*.test.ts`
- Test: `apps/daemon/src/server/__tests__/recovery*.test.ts` (or nearest)

**Purpose:** Prevent stale sessions/resumes from mutating current state after phase intent changes.

### Step 1: Add failing tests for stale generation behavior
- session exit callback from old generation is ignored
- startup recovery skips stale worker state
- resume endpoint rejects stale pending response
- stale callback cannot write tasks, feedback, blocked status, worker-state, or phase transitions
- stale/legacy untagged pending ticket response is rejected and cleaned up
- response `questionId` mismatch is rejected even when generation matches
- legacy `sessions.execution_generation IS NULL` callback path is stale-dropped

### Step 2: Implement stale fencing at completion path
- On agent completion and phase transitions, compare session generation against ticket generation.
- If stale: no-op and log reason.
- Explicitly no-op all side effects (task status, ralph feedback, ticket blocked/unblocked, worker-state writes, spawn triggers).
- Ensure PTY exit handler passes generation/session identity into completion helper in a way that cannot be bypassed.

### Step 3: Implement stale fencing in recovery paths
- In `recoverPendingResponses` and worker-state resume loops:
  - validate current generation before respawn/resume
  - require pending question/response generation + `questionId` pair match
  - process `pendingSpawn: true` before generic worker-state recovery
  - clear stale pending artifacts/state when needed
- Add one shared ticket-response reconciliation helper and require all ticket entry points to call it:
  - HTTP `/api/tickets/:project/:id/input`
  - startup `recoverPendingResponses`
  - Telegram response callback
  - Slack response callback
- Enforce one precedence order in that helper:
  - stale mismatch reject/cleanup
  - valid suspended resume
  - `pendingSpawn` spawn/retry
  - generic worker-state recovery

### Step 4: Harden resume endpoint behavior
- In `/api/tickets/:project/:id/input` + `resumeSuspendedTicket`:
  - validate target phase still automates and generation matches
  - require generation-tagged pending artifacts for ticket resumes
  - require `questionId` match between pending question and response
  - return explicit `409` for stale/mismatched response with actionable error payload:
    - `code: "STALE_TICKET_INPUT"`
    - `reason: "generation_mismatch" | "question_mismatch" | "legacy_untagged"`
    - `currentPhase`
    - `currentGeneration`

### Step 5: Run tests
Run:
- `pnpm --filter @potato-cannon/daemon test -- worker-executor`
- `pnpm --filter @potato-cannon/daemon test -- recovery`
Expected:
- PASS

### Step 6: Commit
- `git commit -m "fix(daemon): fence stale session callbacks and recovery resumes by generation"`

---

## Task 5: Entry Worker Idempotency Contract (Task-Master Self-Skip)
**Depends on:** Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Modify: `apps/daemon/src/services/session/prompts.ts` (if prompt contract is needed)
- Modify: `apps/daemon/src/mcp/tools/task.tools.ts` (if helper needed)
- Test: `apps/daemon/src/services/session/__tests__/worker-executor*.test.ts`
- Docs: `docs/architecture.md` or equivalent execution docs

**Purpose:** Avoid special-case swimlane logic while preventing duplicated planning behavior.

**Gotchas:** Keep orchestrator generic; idempotency belongs to worker behavior + durable task state inspection.

### Step 1: Add failing tests
- Re-entering a phase with existing actionable tasks does not duplicate planning outputs.
- Entry worker runs but can mark itself as skip/continue based on durable state.

### Step 2: Implement contract
- Add a generic entry-worker context signal (e.g., `phaseEntryMode`, task summary).
- Ensure task-master-like worker checks durable task status before generating new planning artifacts.

### Step 3: Run tests
Run:
- `pnpm --filter @potato-cannon/daemon test -- worker-executor`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): make phase entry workers idempotent using durable task state"`

---

## Task 6: Frontend/UX Consistency and Observability
**Depends on:** Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/ticket-detail/ActivityTab.tsx`
- Modify: `apps/frontend/src/components/ticket-detail/TicketDetailPanel.tsx`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `packages/shared/src/types/conversation.types.ts` (if response/error envelope types are shared)
- Test: `apps/frontend/src/components/ticket-detail/*.test.tsx`

**Purpose:** Make cancellation/restart states understandable and reduce confusion during move/re-entry.

### Step 1: Add tests for new API outcomes
- stale resume returns handled error state
- move-triggered cancellation reflects in activity state
- `409` stale-response payload renders actionable user-facing explanation
- `409` lifecycle conflict payload renders "ticket changed, please retry" state

### Step 2: Implement minimal UX updates
- show clear message when a stale response is rejected due to phase/generation mismatch
- ensure active-session indicators update quickly after move cancellation
- implement typed 409 error transport in client layer:
  - preserve `status`, `code`, `reason`, `currentPhase`, `currentGeneration`, `retryable`
  - do not collapse lifecycle 409s into generic `Error(message)`
- on `409` input submission:
  - rollback optimistic user message
  - refetch pending-question and ticket state
  - show actionable conflict text ("ticket changed, retry")

### Step 3: Run tests
Run:
- `pnpm --filter @potato-cannon/frontend test -- ticket-detail`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(frontend): surface lifecycle cancellation and stale-resume states"`

---

## Task 7: End-to-End Verification and Rollout Guardrails
**Depends on:** Tasks 1-6
**Complexity:** standard
**Files:**
- Modify: `docs/plans/2026-03-11-ticket-session-lifecycle-hardening-design.md`
- Modify: `docs/` operational runbook (choose existing path)
- Modify: `apps/daemon/src/types/config.types.ts`
- Modify: `apps/daemon/src/stores/config.store.ts`
- Modify: `apps/daemon/src/server/server.ts` (config read path)
- Test: daemon integration test suites

**Purpose:** Reduce rollout risk with explicit scenario coverage and rollback strategy.

### Step 1: Execute scenario matrix manually/integration
Scenarios:
1. Architecture active -> move to Backlog -> no background continuation
2. Build mid-task -> move to Backlog -> move back to Build -> entry worker self-skips if tasks already structured
3. Crash during active agent -> restart daemon -> resumes only non-stale generation
4. Stale user input after phase move -> rejected and logged
5. Concurrent move/restart calls -> exactly one committed generation path continues
6. Stale callback arrives after replacement session spawn -> dropped with zero side effects
7. Post-commit spawn failure leaves `pendingSpawn: true`; startup recovery spawns exactly once
8. Ticket has both pending response and worker-state on startup; recovery order yields exactly one session

### Step 2: Run full quality gates
Run:
- `pnpm --filter @potato-cannon/daemon test`
- `pnpm --filter @potato-cannon/frontend test`
- `pnpm -r lint`
- `pnpm -r typecheck`
Expected:
- PASS

### Step 3: Document metrics/logging expectations
- add expected log signatures for:
  - stale callback dropped
  - generation mismatch resume rejected
  - move invalidation applied
  - CAS conflict/retry on concurrent lifecycle mutation
  - spawn dedupe guard activation
  - pendingSpawn recovery spawn attempt/success/failure

### Step 4: Add rollout toggles and rollback procedure
- define flags for:
  - strict stale callback drop enforcement
  - stale resume `409` enforcement
- attach flags to existing daemon config surface (no second flag system):
  - `GlobalConfig.daemon.lifecycleHardening.strictStaleDrop` (default `false`)
  - `GlobalConfig.daemon.lifecycleHardening.strictStaleResume409` (default `false`)
- define config load behavior:
  - absent config => defaults above
  - unknown keys ignored safely
- document rollback steps and telemetry thresholds for disable/re-enable decisions

### Step 5: Commit
- `git commit -m "docs: add rollout verification for session lifecycle hardening"`

---

## Test Strategy (Condensed)

1. Unit tests for generation compare and worker-state freshness
2. Route/service integration tests for move/restart/resume/recovery paths
3. Regression tests for existing restart behavior
4. UI tests for stale-input and cancellation status messages
5. Concurrency tests for move/move, move/restart, and stale callback interleavings

## Rollout Plan

1. Dark-launch generation fields and stale checks behind safe default behavior
2. Enable transactional move/restart invalidation + CAS bump
3. Enable strict stale callback drop + stale resume `409` behind flags
4. Monitor logs for stale drops, spawn churn, and `409` rates for one release window
5. Keep documented rollback toggles ready for rapid disable if false-positive stale drops appear

## Risk Register

1. race in kill->exit callback
- mitigated by generation fencing + forceKilled
2. migration drift in legacy sessions
- mitigated by strict legacy handling: null generation is never trusted for stale-sensitive paths; legacy rows are stale-dropped
3. planner skip heuristics too aggressive
- mitigated by conservative self-skip criteria and explicit tests
4. concurrent lifecycle mutations cause split-brain state
- mitigated by transactional invalidation and CAS preconditions
- implementation guard: explicit retryable `409` contract with client retry path
5. strict stale enforcement blocks valid resumes by bug
- mitigated by feature flags, telemetry thresholds, and rollback procedure

## Plan Verification Checklist

- Complete: yes, covers schema, runtime, recovery, resume, concurrency, UX, rollout
- Accurate: yes, file targets map to current daemon/frontend architecture
- Commands valid: yes, aligned with pnpm workspace usage in repo
- YAGNI: yes, avoids per-phase branching and new orchestration modes
- Minimal: yes, focuses only on lifecycle hardening + idempotent entry behavior
- Not over-engineered: yes, one generation fence primitive reused across paths
- Key decisions documented: yes
- Context sections present: yes

## Suggested Beads Epic Breakdown

1. Epic: Session lifecycle generation fencing
2. Subtask: schema + stores
3. Subtask: move/restart invalidation
4. Subtask: recovery/resume stale guards
5. Subtask: idempotent entry worker contract
6. Subtask: frontend messaging + verification

---

## Verification Record

- Draft pass: completed
- Feasibility pass: completed
- Completeness pass: completed
- Risk pass: completed
- Optimality pass: completed
- Outcome: ready for implementation as staged slices
