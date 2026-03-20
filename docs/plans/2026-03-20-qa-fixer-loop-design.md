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

## Token Optimization Integration (merged 2026-03-20)

The token optimization epic landed before this feature. Three integration points:

**`resumeOnRalphRetry: true` on qa-fixer**
qa-fixer is a doer agent — it makes code changes. Adding this flag means on iteration 2+, the daemon resumes its previous Claude session instead of starting fresh, saving tokens and preserving context of what it already changed.

**`disallowTools` on qa-agent**
qa-agent is a reviewer (read-only verifier). Per the optimization pattern applied to all reviewer agents, it should receive a restrictive `disallowTools` list. It only needs: `Bash` (to run checks), file read tools, `ralph_loop_dock`, `chat_notify`. No task creation, artifact management, or scope tools.

**`SCOPE_USING_AGENTS` — no change needed**
`shared-core.md` is intentionally empty. `qa-fixer.md` is NOT a scope-using agent (it doesn't query sibling tickets or dependencies). It must NOT be added to the `SCOPE_USING_AGENTS` set in `agent-loader.ts` — the default (no-op) is correct.

## Failure Escalation

If all 3 attempts are exhausted without QA approval, the ralph loop exits as failed. The daemon surfaces this to the user as a build phase failure requiring human intervention — same as today, but only after 2 autonomous fix attempts.
