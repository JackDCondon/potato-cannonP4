# QA Fixer Loop Design

**Date:** 2026-03-20
**Status:** Approved

## Problem

The QA agent runs after the build phase completes but has no ability to fix failures. When lint, type, or test checks fail, the build phase stalls and requires manual intervention.

## Solution

Wrap the QA agent in a `ralphLoop` with a new general-purpose `qa-fixer` agent. QA runs first, signals pass/fail via `ralph_loop_dock`, and the fixer (if triggered) receives the failure details via the daemon's built-in feedback injection mechanism.

## Worker Structure

```
ralphLoop (maxAttempts: 3)
  ├── qa-fixer-agent   (modelTier: low)   — reads Previous Attempts feedback, applies fixes
  └── qa-agent         (modelTier: high)  — runs all checks, calls ralph_loop_dock
```

**Iteration flow:**
- **Attempt 1:** Fixer sees no `Previous Attempts` section → exits immediately (no-op). QA runs → calls `ralph_loop_dock(approved: true)` on pass (done), or `ralph_loop_dock(approved: false, feedback: "...")` on fail.
- **Attempt 2+:** Fixer receives QA failure details injected into its prompt → applies targeted fixes. QA reruns → approves or rejects again.
- **maxAttempts: 3** → 3 QA runs, 2 fixer passes before escalating to human.

## Scope of Changes

### Workflows (4 files)

| File | Change |
|------|--------|
| `product-development/workflow.json` | Replace `qa-agent` with `qa-ralph-loop` |
| `product-development-p4/workflow.json` | Replace `qa-agent` with `qa-ralph-loop` |
| `bug-fix/workflow.json` | Replace `bug-fix-qa-agent` with `qa-ralph-loop` |
| `bug-fix-p4/workflow.json` | Replace `bug-fix-qa-agent` with `qa-ralph-loop` |

### Agent Files (3 files)

| File | Change |
|------|--------|
| `product-development/agents/qa.md` | Replace `notify-user` reporting with `ralph_loop_dock` verdict calls |
| `bug-fix/agents/bug-fix-qa.md` | Same change |
| `bug-fix-p4/agents/bug-fix-qa.md` | Same change |
| `product-development/agents/qa-fixer.md` | **New file** — general-purpose fixer agent |

### Agent: `qa-fixer.md` (new)

- On first attempt (no `Previous Attempts` in context): exit immediately without changes
- On subsequent attempts: read each failure from the injected feedback, apply targeted fixes
- Scope: lint errors (`clippy`, `eslint`, `biome`), type errors (`tsc`, `cargo check`), failing tests
- Run the relevant check commands after fixing to self-verify before exiting
- Do not attempt architectural changes — fix only what QA reported

### Agent: `qa.md` / `bug-fix-qa.md` (updated)

- Replace final `potato:notify-user` step with `ralph_loop_dock` calls:
  - All checks pass → `ralph_loop_dock(approved: true)`
  - Any check fails → `ralph_loop_dock(approved: false, feedback: "<full failure summary with file paths and error messages>")`
- Remove "Don't try to fix issues — report them" guideline (fixer handles this now)
- Keep "run ALL checks" and "report full output" guidelines

## Model Tiers

| Agent | Tier | Rationale |
|-------|------|-----------|
| `qa-agent` | `high` | Needs to reason about failure patterns across the whole codebase |
| `qa-fixer` | `low` | Mechanical fix application from explicit failure output |

## Failure Escalation

If all 3 attempts are exhausted without QA approval, the ralph loop exits as failed. The daemon surfaces this to the user as a build phase failure requiring human intervention — same as today, but only after 2 autonomous fix attempts.
