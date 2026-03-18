---
name: taskmaster_hardening_epic_body-from-8ft
description: Verification outcome for epic body-from-8ft (taskmaster hardening: dedup, body_from enforcement, re-entry, task-loop guard)
type: project
---

Epic body-from-8ft verified PASS on 2026-03-18. Head SHA f4377a3, base SHA 5dc34e2.

**Why:** Four-change hardening: prompt re-entry awareness (taskmaster.md), body_from enforcement (taskmaster.md + task.tools.ts nudge), duplicate detection (task.tools.ts + task-dedup.test.ts), task-loop empty guard (worker-executor.ts + worker-executor-taskloop-guard.test.ts).

**How to apply:** Pre-existing failing test `cancels awaiting_reply brainstorm questions from dead sessions` (chat.service.prune.test.ts:122) was confirmed present on base SHA — not introduced by this epic. Do not flag it as an epic regression in future reviews.

Key verification patterns used:
- Confirmed pre-existing test failures by checking out base SHA and re-running tests
- The task-loop guard only fires on initTaskLoop (initial entry); mid-loop completion handled by handleTaskWorkersComplete — separate code path
- body_from nudge path in task.tools.ts uses `args.body && !args.body_from` check on raw args before body resolution, which is correct
- Path construction for spec check at line 424 uses same safeProject pattern as all other tools
