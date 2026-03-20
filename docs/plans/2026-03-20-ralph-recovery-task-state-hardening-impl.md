# Ralph Recovery and Task State Hardening Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Harden Ralph review aggregation, startup pending-response recovery, session-scoped task mutation, and task-loop/task-row consistency without regressing valid control-plane flows.
**Architecture:** Keep the fixes inside the daemon backend. Put orchestration invariants in shared session/runtime helpers, keep route behavior compatible where possible, and only trust session-scoped task mutations when the MCP call carries an explicit agent identity.
**Tech Stack:** TypeScript, Express, better-sqlite3, daemon session orchestration, MCP proxy/routes, node:test.
**Key Decisions:**
- **Task mutation enforcement lives at the MCP session boundary:** The bug originates from session agents calling daemon tools, so the guard must use MCP call context plus worker state, not just REST task routes.
- **Startup replay safety beats legacy fallback:** Recovery should drop stale lifecycle-aware answers and consume one-shot fallback answers before spawning so restarts cannot replay the same response forever.
- **Task-loop consistency is enforced with shared helpers:** The same reconciliation logic should gate both restricted task writes and task-loop recovery so we do not encode incompatible invariants in multiple places.
- **Ralph verdicts accumulate within an iteration:** Approval only happens when no reviewer in the current iteration rejects, while single-reviewer loops continue to work unchanged.

---

## Review Findings Applied

- The original plan points Task 4 at [`task.tools.ts`](/D:/GIT/potato-cannonP4/apps/daemon/src/mcp/tools/task.tools.ts), but the current `McpContext` does not carry `agentSource`, so the proposed allowlist cannot work until the MCP proxy and `/mcp/call` route pass that identity through.
- The stale-recovery issue is not a `chat.store` problem. The replay loop is caused by startup recovery logic in [`server.ts`](/D:/GIT/potato-cannonP4/apps/daemon/src/server/server.ts) plus `spawnForTicket()` not consuming the pending interaction before fallback spawn.
- Reconciliation should not only run inside executor transitions. It also needs to run before resuming an interrupted task loop so corrupted persisted task rows cannot silently continue.

---

## Task 1: Add Failing Regression Tests

**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/__tests__/ralph-loop.test.ts`
- Create: `apps/daemon/src/services/session/__tests__/task-status-guard.test.ts`
- Create: `apps/daemon/src/services/session/__tests__/task-state-reconciliation.test.ts`
- Modify: `apps/daemon/src/server/__tests__/recovery.utils.test.ts`
- Modify: `apps/daemon/src/mcp/__tests__/proxy.test.ts`

**Purpose:** Lock the intended behavior before implementation.

**Coverage:**
- Ralph loop rejects the iteration when any reviewer rejects before a later reviewer approves.
- Startup recovery drops stale lifecycle-aware pending input and marks fallback spawn paths as one-shot/consumed.
- Restricted agents can only mutate the current orchestrated task.
- Trusted agents and external/manual contexts retain broader task powers.
- Reconciliation flags impossible task-loop/task-row combinations and the repair helper derives the expected statuses.
- MCP proxy forwards `agentSource` in tool-call context.

---

## Task 2: Implement Iteration-Wide Ralph Verdict Aggregation

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/loops/ralph-loop.ts`
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Modify: `apps/daemon/src/types/orchestration.types.ts`
- Modify: `apps/daemon/src/services/session/worker-state.ts`

**Purpose:** Prevent last-reviewer-wins approvals.

**Implementation notes:**
- Extend `RalphLoopState` with iteration-level rejection tracking.
- Carry forward prior rejection state as reviewers finish within the same iteration.
- Reset the aggregation state when a new iteration starts.
- Record the aggregated iteration verdict in Ralph feedback history, not just the final reviewer’s raw verdict.

---

## Task 3: Harden Startup Pending-Response Recovery

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/server.ts`
- Modify: `apps/daemon/src/server/recovery.utils.ts`

**Purpose:** Stop stale or legacy pending inputs from being replayed across restarts.

**Implementation notes:**
- Extract a recovery decision helper so startup behavior is unit-testable.
- Drop lifecycle-aware pending input when its question identity or generation is stale.
- Preserve the non-question fallback path for blocking asks, but clear the pending interaction before spawning so the same answer cannot be reprocessed on the next restart.
- Keep the stricter behavior scoped to startup recovery; do not regress the live ticket input route.

---

## Task 4: Thread Agent Identity Through MCP and Guard Task Status Writes

**Depends on:** Tasks 1, 3
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/mcp/proxy.ts`
- Modify: `apps/daemon/src/server/routes/mcp.routes.ts`
- Modify: `apps/daemon/src/types/mcp.types.ts`
- Modify: `apps/daemon/src/mcp/tools/task.tools.ts`
- Create: `apps/daemon/src/services/session/task-state-reconciliation.ts`

**Purpose:** Restrict builder/reviewer task writes using explicit session identity and current task-loop state.

**Implementation notes:**
- Add `agentSource` to MCP tool-call context from the session proxy.
- Centralize trusted-agent detection and task-loop reconciliation in a shared helper.
- For restricted agents, allow only `in_progress`, `failed`, and `completed` on the current task-loop task.
- Leave external/manual contexts and trusted control-plane agents unrestricted.

---

## Task 5: Enforce Reconciliation on Recovery and Expose Repair Helper

**Depends on:** Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Modify: `apps/daemon/src/services/session/task-state-reconciliation.ts`

**Purpose:** Prevent corrupted task rows from silently continuing, and make repair deterministic.

**Implementation notes:**
- Validate task-loop state before resuming an interrupted phase.
- Block recovery with a clear reason when persisted task rows disagree with `currentTaskId`, `pendingTasks`, or `completedTasks`.
- Export a repair-plan helper that derives expected statuses from task-loop state for future manual/admin repair flows.

---

## Verification

- Build daemon: `pnpm --filter @potato-cannon/daemon build`
- Run targeted tests:
  - `node --experimental-test-module-mocks --test dist/services/session/__tests__/ralph-loop.test.js`
  - `node --experimental-test-module-mocks --test dist/services/session/__tests__/task-status-guard.test.js`
  - `node --experimental-test-module-mocks --test dist/services/session/__tests__/task-state-reconciliation.test.js`
  - `node --experimental-test-module-mocks --test dist/server/__tests__/recovery.utils.test.js`
  - `node --experimental-test-module-mocks --test dist/mcp/__tests__/proxy.test.js`

