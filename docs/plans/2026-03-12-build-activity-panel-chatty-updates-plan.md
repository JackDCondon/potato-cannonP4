# Build Activity Panel Chatty Updates Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Make Build phase updates in the Activity panel consistently narrative, task-name based, and milestone-oriented.
**Architecture:** Keep message generation where it already lives for low effort: agent templates for stage start/finish narrative, plus a small orchestration hook for deterministic task-close notifications. Reuse existing `chat_notify`/`ticket:message` plumbing so frontend rendering behavior remains unchanged.
**Tech Stack:** Markdown workflow templates, daemon TypeScript orchestration (`worker-executor`), Node test runner with module mocks.
**Key Decisions:**
- **Task label source:** Use task `description` as the canonical task name -- it is already present in injected `Current Task` context.
- **Milestone ownership:** Keep builder/spec/quality stage narration in agent templates -- fastest path with minimal code churn.
- **Task-close reliability:** Emit task-close notification from orchestration layer when status becomes `completed` -- deterministic even if agent wording drifts.
- **Suggestion count policy:** Keep `#N suggestions` best-effort in reviewer prompt text for v1 -- no structured verdict schema changes.
- **Frontend scope:** Do not modify Activity UI for v1 -- `ticket:message` notifications already render in Activity tab.
---

## Scope

In scope:
- Builder/spec/quality agent notification wording updates to use task names.
- Explicit start/finish notification points for builder, spec review, and code review.
- Deterministic task-close notification when a task is marked completed in build task loop.
- Automated tests for notification contract and task-close notification behavior.

Not in scope:
- Structured verdict schema for exact suggestion counts.
- Activity tab UI redesign.
- New SSE event types for chat notifications.

## Message Contract (V1)

The v1 implementation targets these exact user-visible strings:
- `[Builder Agent]: I'm getting started on task: {Task Name}`
- `[Builder Agent]: Finished coding {Task Name}`
- `[Verify Spec Agent]: Starting spec review of {Task Name}`
- `[Verify Spec Agent]: Finished spec review of {Task Name} - PASS|FAIL`
- `[Code Review Agent]: Starting code review of {Task Name}`
- `[Code Review Agent]: Finished code review of {Task Name} - Making #{N} suggestions`
- `[Workflow]: Task closed: {Task Name}`

Where:
- `{Task Name}` = the current task `description`
- `{N}` = best-effort count derived by reviewer from findings

## Task Plan

### Task 1: Add failing tests for notification contract and task-close signal
**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/services/session/__tests__/build-notification-contract.test.ts`
- Create: `apps/daemon/src/services/session/__tests__/worker-executor-task-close-notification.test.ts`

**Purpose:** Lock expected message contract and deterministic close-notification behavior before implementation.

**Not In Scope:** Changing production code in this task.

**Gotchas:** Daemon tests run from compiled `dist`, so test assertions must use paths valid from daemon package root.

**Step 1: Write failing tests**
- `build-notification-contract.test.ts`: assert template files contain required message patterns with task name tokens.
- `worker-executor-task-close-notification.test.ts`: assert `chatService.notify(...)` is called when task status transitions to `completed` inside task loop completion path.

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/build-notification-contract.test.js dist/services/session/__tests__/worker-executor-task-close-notification.test.js
```
Expected: FAIL (missing message strings and missing task-close notification behavior)

**Step 3: Commit failing-test baseline**
```bash
git add apps/daemon/src/services/session/__tests__/build-notification-contract.test.ts apps/daemon/src/services/session/__tests__/worker-executor-task-close-notification.test.ts
git commit -m "test: add failing tests for build activity notification contract"
```

### Task 2: Implement chatty message contract in Build agent templates
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/agents/builder.md`
- Modify: `apps/daemon/templates/workflows/product-development/agents/verify-spec.md`
- Modify: `apps/daemon/templates/workflows/product-development/agents/verify-quality.md`

**Purpose:** Ensure stage-level activity messages use human task names and clear start/finish milestones.

**Not In Scope:** Structured machine-readable reviewer output.

**Gotchas:** Keep guidance explicit about pulling task name from `Current Task -> description` to reduce UUID leakage.

**Step 1: Update builder template**
- Start notification:
  - `[Builder Agent]: I'm getting started on task: {Task Name}`
- Completion notification after implementation and verification:
  - `[Builder Agent]: Finished coding {Task Name}`

**Step 2: Update spec reviewer template**
- Start notification:
  - `[Verify Spec Agent]: Starting spec review of {Task Name}`
- Finish notification:
  - `[Verify Spec Agent]: Finished spec review of {Task Name} - PASS|FAIL`

**Step 3: Update quality reviewer template**
- Start notification:
  - `[Code Review Agent]: Starting code review of {Task Name}`
- Finish notification:
  - `[Code Review Agent]: Finished code review of {Task Name} - Making #{N} suggestions`
- Require best-effort counting from findings sections.

**Step 4: Run tests to verify pass for template contract assertions**
Run:
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/build-notification-contract.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/templates/workflows/product-development/agents/builder.md apps/daemon/templates/workflows/product-development/agents/verify-spec.md apps/daemon/templates/workflows/product-development/agents/verify-quality.md
git commit -m "feat: add chatty build milestone notifications with task names"
```

### Task 3: Emit deterministic task-close notification from worker executor
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Test: `apps/daemon/src/services/session/__tests__/worker-executor-task-close-notification.test.ts`

**Purpose:** Guarantee Activity panel receives a task-close message when task state becomes completed.

**Not In Scope:** Notifications for every in-progress transition.

**Gotchas:** Avoid duplicate close notifications across retries by emitting only when writing `completed` status for current task.

**Step 1: Implement helper for status update + optional notify**
- Add a small internal helper in `worker-executor.ts` that:
  - Reads task metadata (`getTask`) for description.
  - Calls `updateTaskStatus`.
  - On `completed`, calls `chatService.notify({ projectId, ticketId }, "[Workflow]: Task closed: {Task Name}")`.

**Step 2: Replace direct completion status writes**
- Use helper where task loop marks current task `completed`.

**Step 3: Run tests to verify pass**
Run:
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/worker-executor-task-close-notification.test.js
```
Expected: PASS

**Step 4: Commit**
```bash
git add apps/daemon/src/services/session/worker-executor.ts apps/daemon/src/services/session/__tests__/worker-executor-task-close-notification.test.ts
git commit -m "feat: notify activity feed when build task closes"
```

### Task 4: End-to-end verification and regression sweep
**Depends on:** Task 2, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/session/__tests__/build-notification-contract.test.ts` (only if needed for final assertions)
- Modify: `apps/daemon/src/services/session/__tests__/worker-executor-task-close-notification.test.ts` (only if needed for final assertions)

**Purpose:** Confirm final behavior and prevent regressions before merge.

**Not In Scope:** Introducing new provider-level chat routing behavior.

**Gotchas:** Manual smoke checks should be run on a ticket with at least one full ralph loop so every expected milestone notification has a chance to appear.

**Step 1: Run targeted daemon tests**
Run:
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/build-notification-contract.test.js dist/services/session/__tests__/worker-executor-task-close-notification.test.js
```
Expected: PASS

**Step 2: Run broader daemon suite**
Run:
```bash
pnpm --filter @potato-cannon/daemon test
```
Expected: PASS

**Step 3: Manual smoke check (activity transcript)**
- Move a test ticket into Build.
- Confirm activity includes:
  - Builder start with task name
  - Builder finished coding with task name
  - Spec review start/finish with PASS/FAIL
  - Code review start/finish with best-effort suggestion count
  - Workflow task-close notification

**Step 4: Commit verification touch-ups (if any)**
```bash
git add apps/daemon/src/services/session/__tests__/build-notification-contract.test.ts apps/daemon/src/services/session/__tests__/worker-executor-task-close-notification.test.ts
git commit -m "test: finalize build activity notification verification"
```

## Rollback Plan
- Revert template message changes in builder/spec/quality files.
- Revert `worker-executor.ts` task-close notify helper.
- Keep tests to document removed behavior or revert tests in same rollback commit.

## Risks and Mitigations
- **Risk:** Reviewer-provided `#{N}` can be inconsistent across runs.
  - **Mitigation:** Treat as best-effort in v1 and rely on PASS/FAIL + review comment details for authority.
- **Risk:** Duplicate close notifications across retries.
  - **Mitigation:** Emit close notification only on `completed` transition write in task loop completion path.
- **Risk:** UUID leakage still appears if agent ignores template guidance.
  - **Mitigation:** Add explicit template instruction to source task label from `Current Task -> description` and enforce via template-contract tests.
- **Risk:** Message prefix mismatch causes inconsistent UX.
  - **Mitigation:** Lock exact prefixes/phrases in contract tests and keep names aligned with this plan's message contract section.

## Acceptance Criteria
- Build stage notifications reference task names (task descriptions), not UUID task IDs.
- Builder/spec/code-review start and finish notifications appear in Activity.
- Spec review finish includes PASS/FAIL state.
- Code review finish includes best-effort `#N suggestions` text.
- Task closure emits deterministic Activity notification.
- New tests pass and existing daemon tests remain green.

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | PASS | Covers task-name substitution, stage start/finish messages, and task-close feedback requested by user. |
| Accurate | PASS | All referenced files exist in current repo layout and match workflow wiring. |
| Commands valid | PASS | Commands align with daemon build/test tooling and dist-based test execution model. |
| YAGNI | PASS | Defers structured suggestion-count schema and frontend redesign to keep scope minimal. |
| Minimal | PASS | Uses existing notification pipeline; no new transport/event architecture added. |
| Not over-engineered | PASS | Combines prompt-level narration with one orchestration hook for reliability only where needed. |
| Key Decisions documented | PASS | Five explicit decisions included with rationale and alternatives boundary. |
| Context sections present | PASS | Tasks include Depends on, Complexity, Files, Purpose, and context boundaries/gotchas where needed. |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | PASS | 1 | Added explicit v1 message contract section to make expected output concrete. |
| Feasibility | PASS | 1 | Tightened task-4 gotcha and validated commands against daemon package scripts/test execution style. |
| Completeness | PASS | 1 | Added explicit token mapping for `{Task Name}` and `{N}` to avoid ambiguity during implementation. |
| Risk | PASS | 1 | Added dedicated risk/mitigation section for count drift, duplicate closes, and UUID leakage. |
| Optimality | PASS | 0 | Plan already minimal for v1: template updates + single deterministic close-notify hook. |
