# Ralph Loop, Recovery, and Task State Hardening Plan

> **For the next session:** Start by re-reading this file, then verify the referenced code paths before making changes. This plan is intended as a focused handoff for execution, not as a broad redesign.

**Goal:** Fix four linked backend integrity problems without breaking existing workflows: Ralph loop verdict aggregation, stale pending-response recovery, unsafe task status mutation, and divergence between `worker_state` and persisted task rows.

**Architecture:** The fixes should stay inside the daemon backend and preserve current workflow templates unless a template change is required for compatibility. The core strategy is to move enforcement into orchestration/runtime layers rather than trusting individual agents to behave correctly.

**Tech Stack:** TypeScript, better-sqlite3, Express routes, daemon session orchestration, MCP tools, JSON worker-state snapshots in SQLite.

**Key Decisions:**
- **Ralph verdicts are iteration-wide, not last-writer-wins:** Any rejection in an iteration must force revision unless the loop explicitly defines a different policy.
- **Recovery must prefer safety over convenience:** Legacy pending responses should be dropped or quarantined once they are stale; they should not be replayed indefinitely across daemon restarts.
- **Task state mutation is privilege-based, not globally open:** Orchestrated builder loops should only mutate the current task; trusted non-builder agents such as taskmaster and PM can retain broader powers through explicit allowlisting.
- **Worker state remains the source of execution order:** Persisted task rows are a projection of orchestrator progress and must be reconciled against `worker_state`, not allowed to drift independently.
- **Compatibility matters:** The changes should default to preserving existing non-task-loop Ralph behavior unless the current behavior is clearly unsafe.

---

## Problem Summary

### 1. Ralph loop approves on the final reviewer only

Current behavior in [apps/daemon/src/services/session/loops/ralph-loop.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/services/session/loops/ralph-loop.ts) treats the final `verdict.approved` as the full iteration result.

Observed consequence for `GAM-5` task 9:
- Verify Spec reported a real scope failure.
- Quality reviewer later approved.
- The loop advanced and task 9 was treated as approved.

This is not safe for any Ralph loop that expects multiple reviewers to gate the doer.

### 2. Startup recovery replays stale pending responses

Current behavior in [apps/daemon/src/server/server.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/server/server.ts) allows stale ticket inputs through when `strictStaleResume409` is disabled.

Observed consequence for `GAM-5`:
- The same `pending-response.json` was processed multiple times across daemon restarts.
- Recovery repeatedly spawned fresh Build sessions.
- The stale answer was not cleared after fallback spawn.

### 3. `update_task_status` is too permissive

Current behavior in [apps/daemon/src/mcp/tools/task.tools.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/mcp/tools/task.tools.ts) allows any session-context agent to mutate any task by ID for the ticket.

Observed consequence for `GAM-5`:
- Builder-side sessions directly marked tasks 12-15 as completed.
- This happened even though orchestrator `worker_state` still showed task 10 as current.

### 4. `worker_state` and task rows can diverge silently

Current behavior stores:
- orchestration execution order in `tickets.worker_state`
- task status rows in `tasks`

There is no hard reconciliation guard ensuring:
- only `currentTaskId` can move to `completed`/`failed` from orchestration,
- persisted rows still agree with `pendingTasks`, `completedTasks`, and `currentTaskId`.

Observed consequence for `GAM-5`:
- `worker_state` says task 10 is current and tasks 11-15 are pending.
- `tasks` table says 11-15 are completed.

---

## Non-Goals

- Do not redesign workflow templates broadly.
- Do not remove valid task mutation capabilities from taskmaster or PM.
- Do not change general session continuity behavior unless required for stale-response safety.
- Do not add a large permissions framework if a small targeted allowlist will solve this.

---

## Reference Files

- [apps/daemon/src/services/session/loops/ralph-loop.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/services/session/loops/ralph-loop.ts)
- [apps/daemon/src/services/session/worker-executor.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/services/session/worker-executor.ts)
- [apps/daemon/src/services/session/worker-state.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/services/session/worker-state.ts)
- [apps/daemon/src/services/session/loops/task-loop.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/services/session/loops/task-loop.ts)
- [apps/daemon/src/server/server.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/server/server.ts)
- [apps/daemon/src/server/recovery.utils.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/server/recovery.utils.ts)
- [apps/daemon/src/stores/chat.store.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/stores/chat.store.ts)
- [apps/daemon/src/mcp/tools/task.tools.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/mcp/tools/task.tools.ts)
- [apps/daemon/src/mcp/tools/ralph.tools.ts](/D:/GIT/potato-cannonP4/apps/daemon/src/mcp/tools/ralph.tools.ts)
- [apps/daemon/templates/workflows/product-development/workflow.json](/D:/GIT/potato-cannonP4/apps/daemon/templates/workflows/product-development/workflow.json)
- [apps/daemon/templates/workflows/product-development-p4/workflow.json](/D:/GIT/potato-cannonP4/apps/daemon/templates/workflows/product-development-p4/workflow.json)

---

## Execution Order

Implement in this order:
1. Add tests that capture current bad behavior.
2. Fix Ralph verdict aggregation.
3. Fix stale recovery behavior.
4. Lock task status mutation with explicit trusted exceptions.
5. Add reconciliation guard(s).
6. Repair or quarantine existing corrupted state only after runtime protections are in place.

This order avoids “fixing” corrupted live data before the code stops recreating it.

---

## Task 1: Add Regression Tests for the Known Failures

**Depends on:** None  
**Complexity:** standard  
**Files:**
- Modify: `apps/daemon/src/services/session/__tests__/ralph-loop.test.ts`
- Modify: `apps/daemon/src/server/__tests__/ticket-input.routes.test.ts`
- Modify: `apps/daemon/src/server/__tests__/server.daemon-entry.test.ts`
- Create or modify: `apps/daemon/src/services/session/__tests__/task-status-guard.test.ts`
- Create or modify: `apps/daemon/src/services/session/__tests__/worker-state-reconciliation.test.ts`

**Purpose:** Lock in the desired behavior before changing orchestration logic.

**Coverage to add:**
- Ralph loop rejects iteration if any reviewer rejected, even if the last reviewer approved.
- Ralph loop still works for simple approval-only flows.
- Startup recovery drops or clears stale legacy pending responses instead of replaying them repeatedly.
- Builder-side session-context `update_task_status` cannot mark a future task completed.
- Trusted agent contexts can still perform legitimate task mutations.
- Reconciliation detects mismatches between `worker_state` and persisted task rows.

**Gotchas:**
- Existing tests may assume “last verdict wins”; update them carefully.
- Recovery tests will need explicit flag coverage for both strict and non-strict modes.

---

## Task 2: Fix Ralph Loop Verdict Aggregation

**Depends on:** Task 1  
**Complexity:** complex  
**Files:**
- Modify: `apps/daemon/src/services/session/loops/ralph-loop.ts`
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Modify: `apps/daemon/src/types/orchestration.types.ts`
- Modify: `apps/daemon/src/services/session/worker-state.ts`
- Test: `apps/daemon/src/services/session/__tests__/ralph-loop.test.ts`

**Purpose:** Ensure one rejection in an iteration blocks approval unless a workflow explicitly opts out in the future.

**Implementation direction:**
- Extend `RalphLoopState` to track per-iteration verdict state, not just iteration count and worker index.
- Record whether any reviewer in the current iteration rejected.
- At the end of an iteration:
  - approve only if no reviewer rejected,
  - otherwise start the next iteration or hit `maxAttempts`.
- Reset aggregated verdict state when a new iteration begins.

**Compatibility requirement:**
- Preserve behavior for loops with only one reviewer.
- Preserve retry/resume behavior for `resumeOnRalphRetry`.
- Do not require template changes for existing workflows unless absolutely necessary.

**Preferred model:**
- Add a field such as `iterationRejected: boolean` or `iterationVerdicts: Record<string, boolean>`.
- Keep the logic local to Ralph loop state rather than inferring from `ralph_iterations` rows after the fact.

---

## Task 3: Harden Startup Recovery for Stale Pending Responses

**Depends on:** Task 1  
**Complexity:** standard  
**Files:**
- Modify: `apps/daemon/src/server/server.ts`
- Modify: `apps/daemon/src/server/recovery.utils.ts`
- Modify: `apps/daemon/src/stores/chat.store.ts`
- Test: `apps/daemon/src/server/__tests__/ticket-input.routes.test.ts`
- Test: `apps/daemon/src/server/__tests__/server.daemon-entry.test.ts`

**Purpose:** Prevent stale answers from being replayed indefinitely after daemon restart.

**Implementation direction:**
- When `isStalePendingTicketInput(...)` is true during startup recovery, clear the pending interaction and do not replay it.
- Remove or narrow the legacy fallback path that infers missing identity from question metadata.
- If backward compatibility is needed, allow one controlled compatibility path that:
  - resumes exactly once,
  - clears the pending response before spawn,
  - logs a warning with enough context for debugging.
- Ensure fallback `spawnForTicket(...)` clears or consumes the pending response if it is being acted upon.

**Decision to keep simple unless blocked:**
- Default to rejection/clear for stale ticket inputs in startup recovery regardless of flag.
- If the existing flag must remain, use it only for live route behavior, not startup replay.

---

## Task 4: Lock `update_task_status` to the Current Orchestrated Task, with Trusted Exceptions

**Depends on:** Task 1  
**Complexity:** complex  
**Files:**
- Modify: `apps/daemon/src/mcp/tools/task.tools.ts`
- Modify: `apps/daemon/src/types/mcp.types.ts` or adjacent context typing if needed
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Possibly modify: `apps/daemon/src/server/routes/mcp-tools.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/task-status-guard.test.ts`

**Purpose:** Prevent builder/reviewer sessions from mutating arbitrary future tasks while preserving valid control for taskmaster/PM.

**Policy target:**
- **Restricted agents:** builder, verify-spec, verify-quality, adversarial reviewers, other doer/reviewer agents inside task loops.
- **Trusted agents:** taskmaster, task-review, project-manager, possibly explicit admin/manual routes.

**Implementation direction:**
- Add a policy function based on `ctx.agentSource` and current `worker_state`.
- For restricted agents:
  - allow `in_progress`, `failed`, `completed` only on the active orchestrated task,
  - reject mutations for any other task with a clear error.
- For trusted agents:
  - allow broader task status mutation.
- Keep the existing session-active guard semantics, but add a stronger orchestration guard for session-scoped calls.

**Important:**  
Do not key this only off “active session exists”. The builder’s own session is active when it makes valid updates. The real distinction is **who the agent is** and **whether the target task matches the orchestrated current task**.

---

## Task 5: Add Reconciliation Guards Between `worker_state` and `tasks`

**Depends on:** Tasks 2, 4  
**Complexity:** complex  
**Files:**
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Modify: `apps/daemon/src/services/session/worker-state.ts`
- Possibly create: `apps/daemon/src/services/session/task-state-reconciliation.ts`
- Test: `apps/daemon/src/services/session/__tests__/worker-state-reconciliation.test.ts`

**Purpose:** Detect or prevent impossible state transitions like `completed` future tasks with a different `currentTaskId`.

**Implementation direction:**
- Add a reconciliation helper that compares:
  - `currentTaskId`
  - `pendingTasks`
  - `completedTasks`
  - `tasks` row statuses for the same phase
- Enforce invariants such as:
  - `currentTaskId` must be `in_progress` or logically active
  - tasks in `completedTasks` must be `completed`
  - tasks in `pendingTasks` must not be `completed`
  - no task outside `completedTasks` may become `completed` through restricted agent calls
- Run reconciliation:
  - before spawning the next worker on recovery,
  - before accepting restricted `update_task_status`,
  - optionally after task-loop transitions in executor.

**Failure behavior:**
- Prefer blocking and logging over silent repair on first implementation.
- Include enough context in daemon logs to identify which task IDs diverged.

---

## Task 6: Add a Safe Repair Path for Existing Corrupted Tickets

**Depends on:** Tasks 3, 4, 5  
**Complexity:** standard  
**Files:**
- Create or modify: `apps/daemon/src/services/session/task-state-reconciliation.ts`
- Possibly add a route or admin helper if needed
- Test: targeted reconciliation repair tests

**Purpose:** Make it possible to recover tickets like `GAM-5` after protections are in place.

**Implementation direction:**
- Add a helper that can derive expected task statuses from `worker_state` for a task loop.
- For repair mode:
  - set `currentTaskId` to `in_progress`,
  - set `completedTasks` rows to `completed`,
  - set pending future tasks back to `pending`,
  - leave comments/history untouched.
- Keep repair out of automatic startup flow unless strongly justified.
- First version can be an internal helper used from tests and future maintenance commands.

**For `GAM-5` specifically after code lands:**
- task 10 should remain current/in-progress,
- tasks 11-15 should be restored to pending unless a fresh verification proves otherwise.

---

## Compatibility Checklist

The next session should verify these explicitly before merging:

- Single-reviewer Ralph loops still approve correctly.
- Multi-reviewer loops now require unanimous approval within an iteration.
- Bug-fix workflows do not regress.
- Taskmaster can still create tasks and modify statuses where intended.
- PM flows can still manage task state when acting as a control-plane agent.
- Manual/admin routes still work if they intentionally bypass orchestrator restrictions.
- Suspended-session resume still works for valid pending questions.
- Startup no longer replays the same stale `pending-response.json` across repeated restarts.

---

## Recommended Test Matrix

- Ralph loop unit tests:
  - all reviewers approve
  - spec rejects, quality approves
  - reviewer rejects on final allowed iteration
  - doer exits non-zero with retry path

- Recovery tests:
  - valid pending question + valid response identity
  - stale response identity with strict mode on
  - stale response identity with strict mode off
  - legacy response missing identity
  - fallback spawn consumes or clears response

- Task mutation tests:
  - builder can mark only the current task
  - builder cannot mark future task complete
  - taskmaster can adjust task statuses
  - PM can adjust task statuses
  - external/manual context still behaves as intended

- Reconciliation tests:
  - matching `worker_state` and tasks passes
  - future task completed while pending in state is rejected
  - current task mismatch is rejected
  - optional repair helper restores consistency

---

## Notes for the Next Session

- Start from tests, not implementation.
- Do not “fix” `GAM-5` data until the runtime protections are in place.
- Be careful with agent allowlisting: use exact agent sources or explicit role metadata, not fuzzy string matching unless centralized.
- The most dangerous regression would be breaking taskmaster or PM control-plane behavior while tightening builder/reviewer permissions.
- The second most dangerous regression would be over-hardening startup recovery and dropping valid suspended answers.

---

## Expected Deliverables

- Code changes implementing all four protections.
- Regression tests covering the `GAM-5` class of failure.
- A short follow-up note describing:
  - what changed,
  - whether `GAM-5` was repaired,
  - whether any existing tickets were found to be inconsistent.
