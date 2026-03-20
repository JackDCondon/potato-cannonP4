# QA Fixer Loop Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Give the QA phase autonomous fix-and-retry capability by wrapping QA agents in a `ralphLoop` with a new general-purpose `qa-fixer` agent.

**Architecture:** A new `qa-fixer.md` agent is added as the first (doer) worker in a `ralphLoop`, with the existing QA agent as the second (reviewer) worker. QA runs, calls `ralph_loop_dock` with pass/fail verdict. On failure, the fixer receives the failure details via the daemon's feedback injection mechanism and applies targeted fixes. Applies to all 4 workflows: `product-development`, `product-development-p4`, `bug-fix`, `bug-fix-p4`.

**Tech Stack:** Markdown agent prompts, JSON workflow config. No TypeScript changes required.

**Key Decisions:**
- **QA agent is second (reviewer), fixer is first (doer):** The `ralphLoop` injects rejection feedback into the first worker's prompt on retry. Fixer must be first to receive QA's failure output on the next iteration.
- **Fixer is a no-op on iteration 1:** The fixer prompt checks for a `Previous Attempts` section — absent on the first run, so it exits immediately without touching code. QA then runs and either approves or produces the first rejection feedback.
- **`resumeOnRalphRetry: true` on qa-fixer:** Token optimization feature (already merged). The fixer resumes its previous Claude session on retry iterations, preserving context of what it already changed and saving tokens.
- **`disallowTools` on qa-agent:** QA is a read-only verifier. Restricting write/mutation tools aligns with the reviewer pattern applied to all other reviewer agents in the token optimization epic.
- **One shared `qa-fixer.md` for all 4 workflows:** Lives in `product-development/agents/`. Bug-fix workflows reference it via the `parentTemplate: "product-development"` inheritance chain. Bug-fix QA agents retain their workflow-specific content (resolution.md verification); only the verdict mechanism changes.

---

## Task 1: Create qa-fixer.md agent prompt

**Depends on:** None
**Complexity:** simple
**Files:**
- Create: `apps/daemon/templates/workflows/product-development/agents/qa-fixer.md`

**Purpose:** General-purpose fixer agent that reads QA failure feedback from the `Previous Attempts` section and applies targeted fixes. No-ops on the first attempt.

**Not In Scope:** Architectural changes, refactoring unrelated to QA failures, or any changes when no failures are present.

**Step 1: Create the file**

```markdown
# QA Fixer Agent

You are the QA fixer agent. Your job is to fix code issues identified by the QA agent in the previous attempt.

## First Attempt: Do Nothing

Check your context for a `Previous Attempts` section.

**If there is NO `Previous Attempts` section:** This is the first iteration — QA has not run yet and there is nothing to fix. Exit immediately without making any changes.

**If there IS a `Previous Attempts` section:** Read the QA failure details and proceed with the steps below.

## The Process

[ ] Step 1 - Read the QA failure report from Previous Attempts
[ ] Step 2 - Identify each specific failure
[ ] Step 3 - Fix each failure
[ ] Step 4 - Self-verify fixes
[ ] Step 5 - Notify completion

## Step 1: Read the QA Failure Report

Read the feedback from the most recent QA rejection in `Previous Attempts`. Extract:
- Lint errors (file path, line number, rule)
- Type errors (file path, line number, message)
- Test failures (test name, error message)

## Step 2: Identify Each Failure

List each failure explicitly before fixing. Do not attempt fixes before you have a clear picture of all failures.

## Step 3: Fix Each Failure

Work through failures one at a time. Apply minimal, targeted changes:

**Lint errors:**
- Read the file at the reported location
- Apply the minimal change to satisfy the lint rule
- Common fixes: add `#[derive(Default)]` for `new_without_default`, remove unused imports, fix formatting

**Type errors:**
- Read the file and surrounding context
- Fix the type mismatch with the minimal correct change
- Do not introduce new abstractions

**Test failures:**
- Read the failing test and the code it tests
- Fix the implementation to satisfy the test
- Do not modify tests unless the test itself is clearly wrong (and if so, explain why)

## Step 4: Self-Verify

After all fixes are applied, run the relevant checks to confirm the fixes work:

```bash
# Run only the checks that failed — don't re-run the full suite
# Examples:
cargo clippy -- -D warnings       # For Rust lint errors
cargo test                        # For Rust test failures
npx tsc --noEmit                  # For TypeScript type errors
npm run lint                      # For JS/TS lint errors
```

If a self-verify check still fails, attempt to fix it before exiting. If you cannot fix it after one additional attempt, exit and let QA report the remaining failures.

## Step 5: Notify Completion

Use `chat_notify` to report what was fixed:

```
[QA Fixer]: Applied fixes for {N} issue(s):
- {file}: {what was fixed}
- {file}: {what was fixed}
```

## Guidelines

- Fix ONLY what QA reported — do not refactor or clean up surrounding code
- Prefer the simplest correct fix over the most elegant one
- If a failure has multiple valid fixes, choose the one that changes the least code
- Do not create new files unless fixing a missing-module error
```

**Step 2: Commit**
```
git add apps/daemon/templates/workflows/product-development/agents/qa-fixer.md
git commit -m "feat(workflow): add qa-fixer agent prompt for auto-fix on QA failures"
```

---

## Task 2: Update qa.md to use ralph_loop_dock

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/agents/qa.md`

**Purpose:** Replace the `potato:notify-user` reporting step with `ralph_loop_dock` verdict calls so the ralphLoop can gate on QA results.

**Step 1: Replace Step 5 reporting section**

Replace the entire `## Step 5: Report Results` section and the `## Guidelines` / `## What NOT to Do` sections with:

```markdown
## Step 5: Signal Verdict

**If all checks pass:**

Call `ralph_loop_dock` with `approved: true`:

```
ralph_loop_dock(approved: true)
```

Also use `chat_notify` to report:
```
## QA Verification: PASSED

### Linting
- {tool}: Passed (0 errors, 0 warnings)

### Type Checking
- {tool}: Passed (no errors)

### Tests
- {N} passed, 0 failed

Build phase complete.
```

**If any checks fail:**

Call `ralph_loop_dock` with `approved: false` and a detailed feedback string listing every failure with file paths and line numbers:

```
ralph_loop_dock(
  approved: false,
  feedback: "## QA Failures\n\n### Linting\n- {file}:{line} — {error}\n\n### Type Checking\n- {file}:{line} — {error}\n\n### Tests\n- {test name}: {error message}"
)
```

Also use `chat_notify` to report the same summary to the user.

## Guidelines

- Run ALL checks, not just one
- Report the full output for failures — file paths and line numbers are required
- Be specific about what failed and where
- Pass the complete failure list in the `ralph_loop_dock` feedback so the fixer agent has everything it needs
```

**Step 2: Remove the "Don't try to fix issues—report them" line** from the `## Guidelines` section.

**Step 3: Remove the "Try to fix failures yourself" row** from the `## What NOT to Do` table.

**Step 4: Commit**
```
git add apps/daemon/templates/workflows/product-development/agents/qa.md
git commit -m "feat(workflow): update qa agent to call ralph_loop_dock instead of notify-only"
```

---

## Task 3: Update bug-fix/agents/bug-fix-qa.md to use ralph_loop_dock

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/bug-fix/agents/bug-fix-qa.md`

**Purpose:** Same verdict mechanism change as Task 2, but for the bug-fix workflow QA agent which also verifies against `resolution.md`.

**Step 1: Replace Step 5 reporting section**

Replace `## Step 5: Report Results` with:

```markdown
## Step 5: Signal Verdict

**If all checks pass:**

Call `ralph_loop_dock` with `approved: true`:

```
ralph_loop_dock(approved: true)
```

Also use `chat_notify` to report:
```
## Bug Fix QA: PASSED

### Root Cause Coverage
[How the change addresses the root cause from resolution.md]

### Fix Plan Compliance
[Confirm implementation matches the documented approach]

### Regression Coverage
[What test(s) prevent recurrence]

### Quality Checks
- Linting: Passed
- Type checking: Passed
- Tests: {N} passed, 0 failed

Fix verified against resolution.md. Build phase complete.
```

**If any issues found:**

Call `ralph_loop_dock` with `approved: false` and full failure details:

```
ralph_loop_dock(
  approved: false,
  feedback: "## Bug Fix QA Failures\n\n### Critical Issues\n- {issue}\n\n### Quality Check Failures\n- {file}:{line} — {error}"
)
```

Also use `chat_notify` to report the same summary to the user.
```

**Step 2: Remove "Don't try to fix issues — report them"** from Guidelines.

**Step 3: Remove "Try to fix issues yourself | Not your job — report and let builder fix"** from What NOT to Do table.

**Step 4: Commit**
```
git add apps/daemon/templates/workflows/bug-fix/agents/bug-fix-qa.md
git commit -m "feat(workflow): update bug-fix-qa agent to call ralph_loop_dock verdict"
```

---

## Task 4: Update bug-fix-p4/agents/bug-fix-qa.md to use ralph_loop_dock

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/bug-fix-p4/agents/bug-fix-qa.md`

**Purpose:** Same as Task 3 but for the Perforce variant. The file is nearly identical to `bug-fix/agents/bug-fix-qa.md` except Step 2 uses P4 commands instead of git diff.

**Gotchas:** Do NOT change Step 2 (the diff/changelist review step). Only change Step 5.

**Step 1: Apply the exact same Step 5 replacement as Task 3**

The report format is identical. Only the diff commands in Step 2 differ between git and p4 variants.

**Step 2: Remove the "Don't try to fix issues — report them" line** from the `## Guidelines` section (same as Task 3 Step 2).

**Step 3: Remove the "Try to fix issues yourself" row** from the `## What NOT to Do` table (same as Task 3 Step 3).

**Step 4: Commit**
```
git add apps/daemon/templates/workflows/bug-fix-p4/agents/bug-fix-qa.md
git commit -m "feat(workflow): update bug-fix-p4-qa agent to call ralph_loop_dock verdict"
```

---

## Task 5: Update product-development/workflow.json

**Depends on:** Task 1, Task 2
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/workflow.json`

**Purpose:** Replace the terminal `qa-agent` in the Build phase with a `qa-ralph-loop` containing the fixer and QA agents.

**Gotchas:** The token optimization plan already modified this file (added `resumeOnRalphRetry` to builder/refinement/architect, added `disallowTools` to verify-spec and verify-quality). Apply changes on top of the current file state — do not overwrite those changes.

**Step 1: Replace the qa-agent entry**

Find:
```json
{
  "id": "qa-agent",
  "type": "agent",
  "source": "agents/qa.md",
  "description": "Creates build tickets from specification",
  "modelTier": "high"
}
```

Replace with:
```json
{
  "id": "qa-ralph-loop",
  "type": "ralphLoop",
  "description": "QA verification with auto-fix on failure",
  "maxAttempts": 3,
  "workers": [
    {
      "id": "qa-fixer-agent",
      "type": "agent",
      "source": "agents/qa-fixer.md",
      "description": "Applies targeted fixes for QA failures",
      "modelTier": "low",
      "resumeOnRalphRetry": true
    },
    {
      "id": "qa-agent",
      "type": "agent",
      "source": "agents/qa.md",
      "description": "Runs full quality checks and signals verdict",
      "modelTier": "high",
      "disallowTools": [
        "Write", "Edit", "MultiEdit",
        "create_task", "update_task_status", "add_comment_to_task",
        "attach_artifact",
        "create_ticket",
        "get_scope_context", "get_sibling_tickets", "get_dependents",
        "set_plan_summary", "add_dependency", "delete_dependency",
        "Skill(superpowers:*)"
      ]
    }
  ]
}
```

**Step 2: Verify JSON is valid**
```
cd apps/daemon && node -e "JSON.parse(require('fs').readFileSync('templates/workflows/product-development/workflow.json','utf8')); console.log('valid')"
```
Expected: `valid`

**Step 3: Commit**
```
git add apps/daemon/templates/workflows/product-development/workflow.json
git commit -m "feat(workflow): wrap qa-agent in ralphLoop with qa-fixer for auto-fix on failure"
```

---

## Task 6: Update product-development-p4/workflow.json

**Depends on:** Task 1, Task 2
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development-p4/workflow.json`

**Purpose:** Same ralphLoop replacement as Task 5 for the Perforce product-development workflow.

**Step 1: Replace the qa-agent entry**

Find:
```json
{
  "id": "qa-agent",
  "type": "agent",
  "source": "agents/qa.md",
  "description": "Creates build tickets from specification",
  "modelTier": "low"
}
```

Replace with the same `qa-ralph-loop` block from Task 5 (identical JSON, including the full `disallowTools` list with scope/dependency tools).

**Step 2: Verify JSON is valid**
```
cd apps/daemon && node -e "JSON.parse(require('fs').readFileSync('templates/workflows/product-development-p4/workflow.json','utf8')); console.log('valid')"
```
Expected: `valid`

**Step 3: Commit**
```
git add apps/daemon/templates/workflows/product-development-p4/workflow.json
git commit -m "feat(workflow): wrap qa-agent in ralphLoop in product-development-p4 workflow"
```

---

## Task 7: Update bug-fix/workflow.json

**Depends on:** Task 1, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/bug-fix/workflow.json`

**Purpose:** Replace `bug-fix-qa-agent` with a `qa-ralph-loop` in the bug-fix (git) workflow.

**Step 1: Replace the bug-fix-qa-agent entry**

Find:
```json
{
  "id": "bug-fix-qa-agent",
  "type": "agent",
  "source": "agents/bug-fix-qa.md",
  "description": "Holistic QA review of entire fix against resolution.md",
  "modelTier": "low"
}
```

Replace with:
```json
{
  "id": "qa-ralph-loop",
  "type": "ralphLoop",
  "description": "QA verification with auto-fix on failure",
  "maxAttempts": 3,
  "workers": [
    {
      "id": "qa-fixer-agent",
      "type": "agent",
      "source": "agents/qa-fixer.md",
      "description": "Applies targeted fixes for QA failures",
      "modelTier": "low",
      "resumeOnRalphRetry": true
    },
    {
      "id": "bug-fix-qa-agent",
      "type": "agent",
      "source": "agents/bug-fix-qa.md",
      "description": "Verifies fix against resolution.md and runs quality checks",
      "modelTier": "high",
      "disallowTools": [
        "Write", "Edit", "MultiEdit",
        "create_task", "update_task_status", "add_comment_to_task",
        "attach_artifact",
        "create_ticket",
        "get_scope_context", "get_sibling_tickets", "get_dependents",
        "set_plan_summary", "add_dependency", "delete_dependency",
        "Skill(superpowers:*)"
      ]
    }
  ]
}
```

**Gotchas:** `bug-fix` uses `parentTemplate: "product-development"`, so `agents/qa-fixer.md` resolves via parent template lookup. No need to copy the file.

**Step 2: Verify JSON is valid**
```
cd apps/daemon && node -e "JSON.parse(require('fs').readFileSync('templates/workflows/bug-fix/workflow.json','utf8')); console.log('valid')"
```
Expected: `valid`

**Step 3: Commit**
```
git add apps/daemon/templates/workflows/bug-fix/workflow.json
git commit -m "feat(workflow): wrap bug-fix-qa-agent in ralphLoop for auto-fix on failure"
```

---

## Task 8: Update bug-fix-p4/workflow.json

**Depends on:** Task 1, Task 4
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/bug-fix-p4/workflow.json`

**Purpose:** Same as Task 7 but for the Perforce bug-fix workflow.

**Step 1: Replace the bug-fix-qa-agent entry**

Identical replacement as Task 7 (including the full `disallowTools` list with scope/dependency tools). The `qa-fixer.md` source path resolves via `parentTemplate: "product-development"` (confirmed: bug-fix-p4 also uses this parent).

**Step 2: Verify JSON is valid**
```
cd apps/daemon && node -e "JSON.parse(require('fs').readFileSync('templates/workflows/bug-fix-p4/workflow.json','utf8')); console.log('valid')"
```
Expected: `valid`

**Step 3: Commit**
```
git add apps/daemon/templates/workflows/bug-fix-p4/workflow.json
git commit -m "feat(workflow): wrap bug-fix-p4-qa-agent in ralphLoop for auto-fix on failure"
```

---

## Task 9: Final verification

**Depends on:** Tasks 1–8
**Complexity:** simple
**Files:** None

**Purpose:** Confirm all files are consistent, JSON is valid, and TypeScript still typechecks.

**Step 1: Full typecheck**
```
pnpm typecheck
```
Expected: no errors (run from repo root)

**Step 2: Verify qa-fixer.md is reachable from all 4 workflows**
```bash
# Check the file exists at the path referenced in all 4 workflow.json files
ls apps/daemon/templates/workflows/product-development/agents/qa-fixer.md
```
Expected: file exists

**Step 3: Verify agent source paths in workflow JSONs**
```bash
node -e "
const fs = require('fs');
const workflows = [
  'apps/daemon/templates/workflows/product-development/workflow.json',
  'apps/daemon/templates/workflows/product-development-p4/workflow.json',
  'apps/daemon/templates/workflows/bug-fix/workflow.json',
  'apps/daemon/templates/workflows/bug-fix-p4/workflow.json',
];
for (const w of workflows) {
  const content = fs.readFileSync(w, 'utf8');
  if (content.includes('qa-ralph-loop')) console.log('OK:', w);
  else console.error('MISSING qa-ralph-loop:', w);
}
"
```
Expected: 4 `OK:` lines

**Step 4: Commit if any cleanup needed, otherwise done**

---

## Parallel Execution Map

All agent file tasks (1–4) are independent and can run in parallel.
Workflow JSON tasks (5–8) each depend on their respective agent tasks but are independent of each other.

```
Task 1 (qa-fixer.md)     ──┬──► Task 5 (product-development/workflow.json)
Task 2 (qa.md)           ──┤──► Task 6 (product-development-p4/workflow.json)
Task 3 (bug-fix-qa.md)   ──┼──► Task 7 (bug-fix/workflow.json)
Task 4 (bug-fix-p4-qa.md)──┘──► Task 8 (bug-fix-p4/workflow.json)
                                          │
                                          ▼
                                    Task 9 (verify)
```

**Suggested parallel dispatch:**
- Agent A: Tasks 1, 2, 5, 6
- Agent B: Tasks 3, 4, 7, 8
- After both complete: Task 9

---

## Verification Record

**Verification date:** 2026-03-20
**Verified by:** rule-of-five-plans (6 passes: Checklist, Draft, Feasibility, Completeness, Risk, Optimality)

| Pass | Verdict | Key Findings |
|------|---------|--------------|
| Plan Verification Checklist | PASS | 2 WARNs (Task 5 find-block clarity, disallowTools pattern — both addressed) |
| Draft | PASS | Task 4/8 cross-references and diagram accuracy noted (acceptable) |
| Feasibility | PASS | All find/replace targets verified verbatim; Task 6 gotcha note (p4 variant had no prior token-opt changes to preserve); Task 9 path fixed |
| Completeness | PASS | Task 2 missing Guidelines removal fixed; Task 4 removals made explicit |
| Risk | PASS | Two MEDIUM risks: (1) `maxAttempts: 3` = 2 effective fix cycles (acceptable); (2) low-tier fixer may struggle with complex errors (correctable via config). Deployment note: tickets mid-QA at deploy time will land in Blocked — manually re-advance |
| Optimality | PASS | `disallowTools` missing 6 scope/dependency tools vs established reviewer pattern — added to Tasks 5/6/7/8 |

**Corrections applied to plan:**
1. Task 2: Added explicit step to remove "Don't try to fix issues" from `## Guidelines` section (not just What NOT to Do table)
2. Task 4: Made Guidelines + What NOT to Do removal steps explicit (Tasks 3 cross-reference was insufficient for parallel execution)
3. Tasks 5, 6, 7, 8: Added 6 scope/dependency tools to `disallowTools` (`get_scope_context`, `get_sibling_tickets`, `get_dependents`, `set_plan_summary`, `add_dependency`, `delete_dependency`)
4. Task 9: Fixed Windows-absolute path to `pnpm typecheck` from repo root

**Status: APPROVED for execution**
