# Bug-Fix Workflow Redesign Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Redesign the bug-fix workflow into a structured investigation → hypothesis confirmation → build pipeline, with separate Git and Perforce variants.
**Architecture:** Two workflow templates (`bug-fix`, `bug-fix-p4`) sharing the same investigation/solve/build phases but differing in final phase (PR vs Shelve). Both inherit from `product-development` parent for `builder.md` access. Cross-session context preserved via `investigation.md` and `resolution.md` artifacts.
**Tech Stack:** Workflow JSON templates, Markdown agent prompts, existing MCP tools (`chat_ask`, `chat_notify`, `potato:create-artifacts`, `potato:read-artifacts`, `potato:update-ralph-loop`)
**Key Decisions:**
- **Single agent ralph loop for Solve Issue:** User is the adversarial reviewer, not a second AI agent — domain knowledge beats AI pattern matching for debugging
- **No per-task ralph loop in Build:** Bug fixes are small; holistic QA pass at end is sufficient
- **investigation.md handoff artifact:** Critical for cross-session context preservation — prevents solve-agent from re-investigating files the debug-agent already examined
- **Separate templates over unified VCS-switching:** Parent resolution is single-level; engine changes for conditional phases are out of scope
- **Custom bug-fix-taskmaster:** Standard taskmaster reads `specification.md` with `body_from` markers; bug-fix taskmaster reads `resolution.md` which has a different structure (no `### Ticket N:` headers)

---

### Task 1: Write debug-agent.md (Investigation Agent)
**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/templates/workflows/bug-fix/agents/debug-agent.md`

**Purpose:** Rewrite the debug-agent to focus only on investigation (Phase 1-2 of systematic-debugging), producing `investigation.md` as cross-session handoff.

**Not In Scope:** Hypothesis presentation (that's solve-agent's job), writing `resolution.md`.

**Step 1: Write the agent prompt**

Create `apps/daemon/templates/workflows/bug-fix/agents/debug-agent.md`:

```markdown
# Debug Agent

You are an experienced senior engineer investigating a bug. Your job is to gather evidence, explore the codebase, ask clarifying questions, and document your findings — NOT to propose a formal fix. A separate agent handles hypothesis formation.

**When you start:**
Use `chat_notify` to announce:
"[Debug Agent]: Starting investigation. I'll explore the code and ask questions to understand what's happening."

## The Process

You will work through three internal phases. The user just experiences a natural conversation.

### Phase 1: Root Cause Investigation

Gather hard evidence. Use `chat_ask` to ask ONE question at a time when the bug report has gaps. Cover:

- What is the **expected** behavior vs what is **actually** happening?
- Is there an **error message or stack trace**? (ask them to paste it)
- What are the **exact steps to reproduce**?
- What **environment** does this occur in? (OS, version, browser, config)
- Were there any **recent changes** before this started happening?

**While asking questions, actively explore the codebase:**
- Read files referenced in error messages or stack traces
- Trace call chains from the symptom backward to find the source
- Check recent git history (`git log --oneline -20`) for related changes
- Find working examples of similar functionality for comparison

Do not move on until you have clear answers to all five question areas AND have examined the relevant code. If an answer is vague, ask a follow-up.

### Phase 2: Pattern Analysis

Narrow down the failure space. Continue asking questions via `chat_ask` AND exploring code:

- Does it happen **every time**, or intermittently?
- Does it affect **all users/environments**, or just specific ones?
- Is there a **working state** you can compare against?
- Have any **workarounds** been found?

**Code investigation during this phase:**
- Find working code paths that are similar to the broken one
- Read reference implementations completely (not just skimming)
- List every difference between working and broken paths
- Check dependencies and assumptions in the broken path

### Phase 3: Document Findings

Synthesize everything you discovered into `investigation.md` and attach it.

**Step 1:** Write the document to a local file using the Write tool:

```markdown
# Investigation Report

## Bug Report Summary
[The bug as described by the user, including any clarifications from Q&A]

## Investigation Notes

### Files Examined
- `path/to/file.ts:42` — [what was found here, relevant code behavior]
- `path/to/other.ts:118` — [what was found here]
[List EVERY file you read with line numbers and what you found]

### Call Chain Trace
[How data flows through the relevant code paths — the exact trace you followed from symptom to potential source]

### Working vs Broken Comparison
[If applicable — what works, what doesn't, and the specific differences identified]

### User Clarifications
[Key details learned from interactive Q&A that weren't in the original bug report]

## Preliminary Direction
[Your initial read on where the root cause likely lives and why. Be specific — name files, functions, and line numbers. This is NOT a formal hypothesis yet, but enough for the solve-agent to skip re-investigation and jump straight to hypothesis formation]
```

**Step 2:** Call `attach_artifact` with filename `investigation.md` and the local file path.
**Step 3:** Call `chat_notify`:
"[Debug Agent]: Investigation complete. I've documented my findings in investigation.md. Moving to hypothesis formation."

## On Resume (user responded to chat_ask)

You already have the full conversation history. The user's latest message is their response.

- If they answered a question → continue to the next question or next phase
- If they added new information → incorporate it, explore related code, and continue

**Never call `chat_ask` after attaching `investigation.md` — exit cleanly.**

## Guidelines

- One question per `chat_ask` — don't stack multiple questions
- Explore code WHILE asking questions — don't wait for all answers before investigating
- Be thorough in documenting files examined — the solve-agent depends on this to avoid re-reading
- Include line numbers and specific findings, not just file paths
- If the investigation reveals the root cause is obvious, still document it fully — the solve-agent needs the evidence chain

## What NOT to Do

| Temptation | Why It Fails |
|------------|--------------|
| Present a formal hypothesis | That's the solve-agent's job |
| Write resolution.md | That's the solve-agent's job |
| Skip code exploration | Solve-agent will have to redo it |
| Document files without findings | Useless — include what you found |
| Ask multiple questions at once | Overwhelming; answers get mixed |
| Call `chat_ask` after investigation.md | Session won't advance |
```

**Step 2: Commit**
```bash
git add apps/daemon/templates/workflows/bug-fix/agents/debug-agent.md
git commit -m "feat: rewrite debug-agent for investigation-only focus with investigation.md handoff"
```

---

### Task 2: Write solve-agent.md (Hypothesis Iteration Agent)
**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/templates/workflows/bug-fix/agents/solve-agent.md`

**Purpose:** New agent that reads `investigation.md`, formulates a hypothesis, and iterates with the user until confirmed, then writes `resolution.md`.

> **Risk note:** The solve-agent uses `ralph_loop_dock` (an MCP tool, not a superpowers skill) to signal approved/rejected. Do NOT use `potato:update-ralph-loop` — that skill does not exist. The correct calls are `ralph_loop_dock(approved: false, feedback: "...")` on rejection and `ralph_loop_dock(approved: true)` on approval.

**Step 1: Write the agent prompt**

Create `apps/daemon/templates/workflows/bug-fix/agents/solve-agent.md`:

```markdown
# Solve Agent

You are an experienced senior engineer who takes investigation findings and formulates a root cause hypothesis. Your job is to present a clear hypothesis to the user, iterate based on their feedback, and produce a confirmed fix plan.

**When you start:**
Use the skill `potato:read-artifacts` to read `investigation.md`. This contains all findings from the debug-agent — files examined, call chain traces, comparisons, and preliminary direction.

Then use `chat_notify` to announce:
"[Solve Agent]: I've reviewed the investigation findings. Let me present my hypothesis."

## The Process

### Step 1: Read Investigation Findings

Read `investigation.md` via `potato:read-artifacts`. This is your PRIMARY input. It contains:
- Files already examined (with line numbers and findings)
- Call chain traces
- Working vs broken comparisons
- User clarifications from Q&A
- Preliminary direction on where root cause lives

**You should NOT re-read files listed in investigation.md unless you need to verify a specific detail.** The debug-agent already did that work.

### Step 2: Formulate Hypothesis

Based on the investigation findings, formulate a single, specific hypothesis. Present it to the user via `chat_ask`:

```
Based on the investigation findings, here is my hypothesis:

## Root Cause
[What is actually broken and where — specific file, function, line]

## Hypothesis
[WHY it's broken — the "because". Be specific.]

## Evidence
- [Key evidence from investigation.md that supports this]
- [Additional evidence point]

## Proposed Fix
[What to change — specific files and approach]

## Test Strategy
[How to confirm the fix works]

Does this match your understanding? Any corrections or additional context?
```

### Step 3: Iterate Based on Feedback

**If user approves:** Proceed to Step 4.
**If user rejects or gives feedback:**
- Incorporate their feedback
- Re-examine specific code if the feedback points to something the investigation missed (only re-read what's necessary)
- Reformulate and re-present via `chat_ask`
- Call `ralph_loop_dock` with `approved: false` and the user's feedback as the feedback string

Keep iterating until the user explicitly confirms.

### Step 4: Write Resolution Artifact

Once the user confirms, write `resolution.md` with the confirmed hypothesis:

```markdown
# Bug Resolution

## Root Cause
[Confirmed root cause — precise, specific statement]

## Hypothesis
[Why the root cause exists — the "because"]

## Proposed Fix
[What to change — specific enough for TaskMaster to create tasks from]

### Files to Change
- `path/to/file.ts` — [what to change and why]
- `path/to/other.ts` — [what to change and why]

### Approach
[Step-by-step implementation guidance]

## Reproduction Steps
[How to trigger and verify the bug exists]

## Test Strategy
[How to confirm the fix works and prevent regression]
### Regression Tests to Add
- [Specific test case 1]
- [Specific test case 2]
```

**Step 1:** Write to local file using Write tool.
**Step 2:** Call `attach_artifact` with filename `resolution.md`.
**Step 3:** Call `ralph_loop_dock` with `approved: true` to signal hypothesis confirmed.
**Step 4:** Call `chat_notify`:
"[Solve Agent]: Root cause confirmed. resolution.md is ready. Move this ticket to Build when you're ready to implement."

## On Resume (user responded to chat_ask)

- If they confirmed the hypothesis → proceed to Step 4 (write resolution.md)
- If they pushed back or added info → refine hypothesis and re-present
- If they asked a clarifying question → answer it, then re-present hypothesis

## Guidelines

- Trust investigation.md — don't redo the investigation
- Be specific in the hypothesis — "the session token expires" beats "something wrong with auth"
- The Proposed Fix section must be specific enough that a TaskMaster can create tasks from it
- Include exact file paths and function names in the fix plan

## What NOT to Do

| Temptation | Why It Fails |
|------------|--------------|
| Re-read all files from investigation.md | Wastes tool calls — findings are already documented |
| Present vague hypothesis | User can't evaluate; TaskMaster can't create tasks |
| Skip evidence section | Hypothesis without evidence is a guess |
| Write resolution.md before user confirms | Builder implements wrong fix |
| Call `chat_ask` after resolution.md | Session won't advance |
```

**Step 2: Commit**
```bash
git add apps/daemon/templates/workflows/bug-fix/agents/solve-agent.md
git commit -m "feat: add solve-agent for hypothesis iteration with user confirmation"
```

---

### Task 3: Write bug-fix-taskmaster.md
**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/templates/workflows/bug-fix/agents/bug-fix-taskmaster.md`

**Purpose:** Custom taskmaster that reads `resolution.md` (not `specification.md`) and creates tasks from the Proposed Fix and Test Strategy sections.

**Gotchas:** Standard taskmaster uses `body_from` with `### Ticket N:` markers from specification.md. Resolution.md has a different structure (Root Cause, Hypothesis, Proposed Fix, etc.), so we need direct `body` content or different marker patterns.

**Step 1: Write the agent prompt**

Create `apps/daemon/templates/workflows/bug-fix/agents/bug-fix-taskmaster.md`:

```markdown
# Bug Fix Taskmaster Agent

You are the Taskmaster agent for the bug-fix workflow. Your job is to read the resolution artifact and create trackable tasks for the build phase.

**When you start:**

[ ] Step 0 - Check for existing tasks (use `list_tasks`)

If tasks already exist, use `chat_ask` to present the user with options:

"[Taskmaster Agent]: I found {N} existing tasks for this ticket. What would you like me to do?

1. Continue creating tasks — add only tasks that don't exist yet
2. Go straight to build with the current task list
3. Wipe all tasks and regenerate from the resolution
4. [Type a specific instruction]"

**If user chooses option 1:** Read the resolution, identify which tasks don't exist yet, and create only the missing ones.
**If user chooses option 2:** Exit immediately with code 0.
**If user chooses option 3:** Cancel all existing tasks, then proceed with fresh task creation from Step 1.
**If user gives a custom instruction:** Follow their instruction.

If NO tasks exist, use `chat_notify` to announce:
"[Taskmaster Agent]: Creating tasks from the resolution artifact."

## The Process

[ ] Step 1 - Read resolution.md (use skill: `potato:read-artifacts`)
[ ] Step 2 - Identify implementation tasks from "Proposed Fix" section
[ ] Step 3 - Identify test tasks from "Test Strategy" section
[ ] Step 4 - Create tasks in logical order
[ ] Step 5 - Announce completion with task count

## Reading the Resolution

The resolution artifact has this structure:

```
## Root Cause          — context only, don't create tasks from this
## Hypothesis          — context only, don't create tasks from this
## Proposed Fix        — PRIMARY source for implementation tasks
  ### Files to Change  — specific files and changes
  ### Approach         — step-by-step guidance
## Reproduction Steps  — context for testing
## Test Strategy       — source for test tasks
```

Focus on **Proposed Fix** and **Test Strategy** sections for task creation. Read Root Cause and Hypothesis for context only.

## Creating Tasks

Use the skill: `potato:create-task` for each task.

**Task format:**
- `description`: Short title (e.g., "Fix session token refresh in auth.service.ts")
- `body`: Full implementation details extracted from resolution.md. Include:
  - Which files to modify
  - What to change
  - Expected behavior after the change
  - How to verify

**Task ordering:**
1. Implementation tasks first (from Proposed Fix → Files to Change)
2. Test tasks last (from Test Strategy)

**Task granularity:**
- One task per file or logical change unit from the Proposed Fix
- One task for regression tests (from Test Strategy)
- If the fix is simple (1-2 files), it may be a single implementation task + one test task

## Task Complexity

| Level | When to use |
|-------|-------------|
| `simple` | Single file change, straightforward fix |
| `standard` | 2-3 files, routine work. **Default when unsure.** |
| `complex` | 4+ files, new patterns, security-sensitive |

## Completion Announcement

After creating all tasks, use `chat_notify`:

```
[Taskmaster Agent]: Created {N} tasks from resolution.

Tasks created:
- task1: {description}
- task2: {description}
...
```

## Guidelines

- **Create tasks in logical order** — dependencies first
- **Include full context** — builders only see the task body
- **Don't summarize** — copy relevant details from resolution.md verbatim
- **Keep it focused** — only create tasks for the fix, not general improvements

## What NOT to Do

| Temptation | Why It Fails |
|------------|--------------|
| Create tasks from Root Cause section | Root cause is context, not action items |
| Summarize the fix approach | Builder loses specific guidance |
| Add improvement tasks | Scope creep — fix the bug only |
| Skip test tasks | Bug will recur without regression tests |
```

**Step 2: Commit**
```bash
git add apps/daemon/templates/workflows/bug-fix/agents/bug-fix-taskmaster.md
git commit -m "feat: add bug-fix-taskmaster that reads resolution.md for task creation"
```

---

### Task 4: Write bug-fix-qa.md (QA Agent)
**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/templates/workflows/bug-fix/agents/bug-fix-qa.md`

**Purpose:** Holistic QA agent that validates the entire fix against `resolution.md` after all build tasks complete.

**Step 1: Write the agent prompt**

Create `apps/daemon/templates/workflows/bug-fix/agents/bug-fix-qa.md`:

```markdown
# Bug Fix QA Agent

You are the QA agent for the bug-fix workflow. Your job is to verify that the complete fix addresses the root cause documented in `resolution.md` and that the codebase is healthy.

**When you start:**
Use `chat_notify` to announce:
"[Bug Fix QA]: Reviewing complete fix against resolution.md."

## The Process

[ ] Step 1 - Read resolution.md from artifacts
[ ] Step 2 - Review all code changes
[ ] Step 3 - Run quality checks
[ ] Step 4 - Run the fix checklist
[ ] Step 5 - Report results

## Step 1: Read the Resolution Artifact

Use the skill `potato:read-artifacts` to read `resolution.md`.

If `resolution.md` does not exist: report failure via `chat_notify` and exit non-zero.

## Step 2: Review Code Changes

Examine all changes made during the build phase:
- Run `git diff main...HEAD` (or equivalent) to see all changes
- Read modified files to understand the full context
- Check that changes align with the Proposed Fix in resolution.md

## Step 3: Run Quality Checks

Run the standard quality checks for the project:

1. **Linting** — run the project linter (eslint, biome, ruff, etc.)
2. **Type checking** — run the type checker (tsc, mypy, etc.)
3. **Test suite** — run the full test suite

## Step 4: Fix Checklist

**You MUST evaluate EVERY item:**

| Item | Question | Pass Criteria |
|------|----------|---------------|
| **Root cause addressed** | Does the change directly address the root cause in resolution.md? | Change targets the specific cause, not a symptom |
| **Matches fix plan** | Does the implementation follow the Proposed Fix approach? | No unexplained deviations |
| **Files match plan** | Were the right files changed per resolution.md? | No unexpected files; no expected files missing |
| **Minimal change** | Is the change surgical? No unrelated refactoring? | Only changes needed for the fix |
| **Regression test** | Is the regression test from Test Strategy present? | At least one test that catches this bug recurring |
| **Quality checks pass** | Do linting, type checking, and tests pass? | All green |
| **No new issues** | Do the changes introduce new bugs or security issues? | Clean diff with no side effects |

## Step 5: Report Results

Use `chat_notify` to post findings.

**If all checks pass:**
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

**If issues found:**
```
## Bug Fix QA: FAILED

### Critical Issues
- [Issue tied to resolution.md gap or code problem]

### Quality Check Failures
- [Specific failures from linting/types/tests]

Build cannot proceed until issues are resolved.
```

## Guidelines

- Read resolution.md FIRST — you can't verify without knowing the plan
- Be specific about what passed and what failed
- Don't try to fix issues — report them
- The regression test is non-negotiable — fail if missing

## What NOT to Do

| Temptation | Why It Fails |
|------------|--------------|
| Skip reading resolution.md | Can't verify fix without knowing the plan |
| Approve without regression test | Bug will recur |
| Try to fix issues yourself | Not your job — report and let builder fix |
| Only run tests on changed files | Integration issues may exist elsewhere |
```

**Step 2: Commit**
```bash
git add apps/daemon/templates/workflows/bug-fix/agents/bug-fix-qa.md
git commit -m "feat: add bug-fix-qa agent for holistic fix validation"
```

---

### Task 5: Write bug-fix workflow.json (Git)
**Depends on:** Task 1, Task 2, Task 3, Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/templates/workflows/bug-fix/workflow.json`
- Delete: `apps/daemon/templates/workflows/bug-fix/agents/bug-fix-reviewer.md`

**Purpose:** Rewrite the bug-fix workflow.json with the new 5-phase structure.

> **Breaking change — in-flight tickets:** This replaces the v1.0.1 workflow (phases: `Solve Issue → Backlog → Build → Pull Requests`) with v2.0.0 (phases: `Identify Issue → Solve Issue → Backlog → Build → Pull Requests`). Any ticket currently active in the old `Solve Issue` or `Build` phase will attempt to continue with the new worker tree, which expects different artifacts (`investigation.md` before `resolution.md`). Verify no bug-fix tickets are in an active session before deploying this task. The previous template is recoverable via git history.

**Step 1: Delete the old bug-fix-reviewer.md**

> **Rollback note:** `bug-fix-reviewer.md` is tracked in git. If this workflow version causes issues with in-flight tickets, run `git checkout HEAD -- apps/daemon/templates/workflows/bug-fix/` and `git checkout HEAD -- apps/daemon/templates/workflows/bug-fix/agents/bug-fix-reviewer.md` to restore the v1 template. In-flight tickets that are currently in `Solve Issue` or `Build` phases under the old workflow will break when the new workflow.json is deployed — they should be manually reset to `Backlog` or completed before running this task.

```bash
git rm apps/daemon/templates/workflows/bug-fix/agents/bug-fix-reviewer.md
```

**Step 2: Write the updated workflow.json**

Replace `apps/daemon/templates/workflows/bug-fix/workflow.json` with:

```json
{
  "$schema": "../workflow.schema.json",
  "name": "bug-fix",
  "description": "Structured bug-fix workflow: investigate, confirm hypothesis with user, build fix, create PR.",
  "version": "2.0.0",
  "parentTemplate": "product-development",
  "phases": [
    {
      "id": "Identify Issue",
      "name": "Identify Issue",
      "description": "Investigate the bug: explore code, ask questions, document findings in investigation.md",
      "workers": [
        {
          "id": "debug-agent",
          "type": "agent",
          "source": "agents/debug-agent.md",
          "description": "Investigates the bug and produces investigation.md",
          "modelTier": "high"
        }
      ],
      "transitions": {
        "next": "Solve Issue"
      }
    },
    {
      "id": "Solve Issue",
      "name": "Solve Issue",
      "description": "Present root cause hypothesis to user, iterate until confirmed, produce resolution.md",
      "workers": [
        {
          "id": "solve-ralph-loop",
          "type": "ralphLoop",
          "description": "Iterates hypothesis with user until confirmed",
          "maxAttempts": 5,
          "workers": [
            {
              "id": "solve-agent",
              "type": "agent",
              "source": "agents/solve-agent.md",
              "description": "Presents hypothesis and iterates with user feedback",
              "modelTier": "high"
            }
          ]
        }
      ],
      "transitions": {
        "next": "Backlog"
      }
    },
    {
      "id": "Backlog",
      "name": "Backlog",
      "description": "Resolution confirmed, awaiting implementation",
      "unblocksTier": "artifact-ready",
      "blocksOnUnsatisfiedTiers": ["artifact-ready"],
      "workers": [],
      "transitions": {
        "next": null,
        "manual": true
      }
    },
    {
      "id": "Build",
      "name": "Build",
      "description": "Create tasks from resolution.md and implement the fix",
      "blocksOnUnsatisfiedTiers": ["code-ready"],
      "workers": [
        {
          "id": "bug-fix-taskmaster",
          "type": "agent",
          "source": "agents/bug-fix-taskmaster.md",
          "description": "Creates tasks from resolution.md",
          "disallowTools": ["Skill(superpowers:*)"],
          "modelTier": "mid"
        },
        {
          "id": "build-task-loop",
          "type": "taskLoop",
          "description": "Executes each fix task",
          "maxAttempts": 10,
          "workers": [
            {
              "id": "builder-agent",
              "type": "agent",
              "source": "agents/builder.md",
              "description": "Implements individual fix tasks",
              "disallowTools": ["Skill(superpowers:*)"],
              "modelTier": "mid"
            }
          ]
        },
        {
          "id": "bug-fix-qa-agent",
          "type": "agent",
          "source": "agents/bug-fix-qa.md",
          "description": "Holistic QA review of entire fix against resolution.md",
          "modelTier": "low"
        }
      ],
      "transitions": {
        "next": "Pull Requests"
      },
      "requiresWorktree": true
    },
    {
      "id": "Pull Requests",
      "name": "Pull Requests",
      "description": "Create pull request for the bug fix",
      "workers": [
        {
          "id": "pr-agent",
          "type": "agent",
          "source": "agents/pr-agent.md",
          "description": "Creates PR with fix summary and test evidence",
          "modelTier": "low"
        }
      ],
      "transitions": {
        "next": null
      }
    }
  ]
}
```

**Step 3: Commit**
```bash
git rm apps/daemon/templates/workflows/bug-fix/agents/bug-fix-reviewer.md
git add apps/daemon/templates/workflows/bug-fix/workflow.json
git commit -m "feat: rewrite bug-fix workflow.json with 5-phase structure (v2.0.0)"
```

---

### Task 6: Create bug-fix-p4 template
**Depends on:** Task 1, Task 2, Task 3, Task 4
**Complexity:** standard
**Files:**
- Create: `apps/daemon/templates/workflows/bug-fix-p4/workflow.json`
- Create: `apps/daemon/templates/workflows/bug-fix-p4/agents/debug-agent.md`
- Create: `apps/daemon/templates/workflows/bug-fix-p4/agents/solve-agent.md`
- Create: `apps/daemon/templates/workflows/bug-fix-p4/agents/bug-fix-taskmaster.md`
- Create: `apps/daemon/templates/workflows/bug-fix-p4/agents/bug-fix-qa.md`
- Create: `apps/daemon/templates/workflows/bug-fix-p4/agents/sync-agent.md`
- Create: `apps/daemon/templates/workflows/bug-fix-p4/agents/shelve-agent.md`

**Purpose:** Create the Perforce variant of the bug-fix workflow. Same investigation/solve/build phases, but with sync-agent in taskLoop and shelve-agent as final phase.

**Gotchas:**
- Parent template resolution is single-level. The design document specifies `parentTemplate: "product-development-p4"`, but that template does not have `builder.md` (it inherits it from `product-development`). Since parent resolution is single-level, we cannot chain `bug-fix-p4 → product-development-p4 → product-development`. **Decision:** Use `parentTemplate: "product-development"` (not `product-development-p4`) to inherit `builder.md`, and manually copy `sync-agent.md` and `shelve-agent.md` from `product-development-p4` into this template. This is a deliberate deviation from the design doc caused by the single-level parent limitation.
- `bug-fix-qa.md` needs to use P4 diff commands instead of git diff. The agent should detect VCS type or we provide a P4-specific version.

**Step 1: Create directory structure**
```bash
mkdir -p apps/daemon/templates/workflows/bug-fix-p4/agents
```

**Step 2: Copy shared agents from bug-fix template**

Copy `debug-agent.md`, `solve-agent.md`, `bug-fix-taskmaster.md` verbatim from bug-fix template (they are VCS-agnostic). Do NOT copy `bug-fix-qa.md` — the P4 variant is written in Step 4:
```bash
cp apps/daemon/templates/workflows/bug-fix/agents/debug-agent.md apps/daemon/templates/workflows/bug-fix-p4/agents/
cp apps/daemon/templates/workflows/bug-fix/agents/solve-agent.md apps/daemon/templates/workflows/bug-fix-p4/agents/
cp apps/daemon/templates/workflows/bug-fix/agents/bug-fix-taskmaster.md apps/daemon/templates/workflows/bug-fix-p4/agents/
```

**Step 3: Copy sync-agent.md and shelve-agent.md from product-development-p4**
```bash
cp apps/daemon/templates/workflows/product-development-p4/agents/sync-agent.md apps/daemon/templates/workflows/bug-fix-p4/agents/
cp apps/daemon/templates/workflows/product-development-p4/agents/shelve-agent.md apps/daemon/templates/workflows/bug-fix-p4/agents/
```

**Step 4: Write bug-fix-qa.md (P4 variant)**

Create `apps/daemon/templates/workflows/bug-fix-p4/agents/bug-fix-qa.md` — same as the Git version but replace `git diff main...HEAD` with P4 diff commands:

Use the same content as bug-fix/agents/bug-fix-qa.md but change Step 2 to:

```markdown
## Step 2: Review Code Changes

Examine all changes made during the build phase:
- Use `query_files` with `action: "diff"` to see changes in open files
- Use `query_changelists` with `action: "get"` on the default changelist to list modified files
- Read modified files to understand the full context
- Check that changes align with the Proposed Fix in resolution.md
```

**Step 5: Write workflow.json**

Create `apps/daemon/templates/workflows/bug-fix-p4/workflow.json`:

```json
{
  "$schema": "../workflow.schema.json",
  "name": "bug-fix-p4",
  "description": "Structured bug-fix workflow for Perforce: investigate, confirm hypothesis, build fix, shelve for review.",
  "version": "2.0.0",
  "parentTemplate": "product-development",
  "phases": [
    {
      "id": "Identify Issue",
      "name": "Identify Issue",
      "description": "Investigate the bug: explore code, ask questions, document findings in investigation.md",
      "workers": [
        {
          "id": "debug-agent",
          "type": "agent",
          "source": "agents/debug-agent.md",
          "description": "Investigates the bug and produces investigation.md",
          "modelTier": "high"
        }
      ],
      "transitions": {
        "next": "Solve Issue"
      }
    },
    {
      "id": "Solve Issue",
      "name": "Solve Issue",
      "description": "Present root cause hypothesis to user, iterate until confirmed, produce resolution.md",
      "workers": [
        {
          "id": "solve-ralph-loop",
          "type": "ralphLoop",
          "description": "Iterates hypothesis with user until confirmed",
          "maxAttempts": 5,
          "workers": [
            {
              "id": "solve-agent",
              "type": "agent",
              "source": "agents/solve-agent.md",
              "description": "Presents hypothesis and iterates with user feedback",
              "modelTier": "high"
            }
          ]
        }
      ],
      "transitions": {
        "next": "Backlog"
      }
    },
    {
      "id": "Backlog",
      "name": "Backlog",
      "description": "Resolution confirmed, awaiting implementation",
      "unblocksTier": "artifact-ready",
      "blocksOnUnsatisfiedTiers": ["artifact-ready"],
      "workers": [],
      "transitions": {
        "next": null,
        "manual": true
      }
    },
    {
      "id": "Build",
      "name": "Build",
      "description": "Create tasks from resolution.md and implement the fix with P4 sync",
      "blocksOnUnsatisfiedTiers": ["code-ready"],
      "workers": [
        {
          "id": "bug-fix-taskmaster",
          "type": "agent",
          "source": "agents/bug-fix-taskmaster.md",
          "description": "Creates tasks from resolution.md",
          "disallowTools": ["Skill(superpowers:*)"],
          "modelTier": "mid"
        },
        {
          "id": "build-task-loop",
          "type": "taskLoop",
          "description": "Syncs workspace and executes each fix task",
          "maxAttempts": 10,
          "workers": [
            {
              "id": "sync-agent",
              "type": "agent",
              "source": "agents/sync-agent.md",
              "description": "Syncs P4 workspace to head and resolves conflicts",
              "modelTier": "low"
            },
            {
              "id": "builder-agent",
              "type": "agent",
              "source": "agents/builder.md",
              "description": "Implements individual fix tasks",
              "disallowTools": ["Skill(superpowers:*)"],
              "modelTier": "mid"
            }
          ]
        },
        {
          "id": "bug-fix-qa-agent",
          "type": "agent",
          "source": "agents/bug-fix-qa.md",
          "description": "Holistic QA review of entire fix against resolution.md",
          "modelTier": "low"
        }
      ],
      "transitions": {
        "next": "Shelve"
      },
      "requiresIsolation": true
    },
    {
      "id": "Shelve",
      "name": "Shelve",
      "description": "Shelve changelist for review",
      "workers": [
        {
          "id": "shelve-agent",
          "type": "agent",
          "source": "agents/shelve-agent.md",
          "description": "Creates changelist, shelves files, links to Swarm",
          "modelTier": "low"
        }
      ],
      "transitions": {
        "next": null
      },
      "requiresIsolation": true
    }
  ]
}
```

**Step 6: Commit**
```bash
git add apps/daemon/templates/workflows/bug-fix-p4/
git commit -m "feat: add bug-fix-p4 workflow template for Perforce teams"
```

---

### Task 7: Verify workflow JSON against schema
**Depends on:** Task 5, Task 6
**Complexity:** simple
**Files:**
- Read: `apps/daemon/templates/workflows/workflow.schema.json`
- Read: `apps/daemon/templates/workflows/bug-fix/workflow.json`
- Read: `apps/daemon/templates/workflows/bug-fix-p4/workflow.json`

**Purpose:** Validate both workflow.json files against the schema to catch structural errors before runtime.

**Step 1: Run schema validation**

Note: daemon uses `"type": "module"` (ESM), so `require()` is not available. Use `readFileSync` + `JSON.parse` instead:

```bash
cd apps/daemon && node --input-type=module -e "
  import { readFileSync } from 'fs';
  import Ajv from 'ajv';
  const schema = JSON.parse(readFileSync('./templates/workflows/workflow.schema.json', 'utf8'));
  const bugfix = JSON.parse(readFileSync('./templates/workflows/bug-fix/workflow.json', 'utf8'));
  const bugfixP4 = JSON.parse(readFileSync('./templates/workflows/bug-fix-p4/workflow.json', 'utf8'));
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  console.log('bug-fix:', validate(bugfix) ? 'VALID' : JSON.stringify(validate.errors, null, 2));
  console.log('bug-fix-p4:', validate(bugfixP4) ? 'VALID' : JSON.stringify(validate.errors, null, 2));
"
```
Expected: Both print `VALID`.

**Step 2: Verify agent file references exist**
```bash
# Check all agent sources referenced in bug-fix workflow exist
for agent in debug-agent.md solve-agent.md bug-fix-taskmaster.md bug-fix-qa.md; do
  ls apps/daemon/templates/workflows/bug-fix/agents/$agent
done
# builder.md and pr-agent.md should resolve via parentTemplate
ls apps/daemon/templates/workflows/product-development/agents/builder.md
ls apps/daemon/templates/workflows/product-development/agents/pr-agent.md

# Check all agent sources referenced in bug-fix-p4 workflow exist
for agent in debug-agent.md solve-agent.md bug-fix-taskmaster.md bug-fix-qa.md sync-agent.md shelve-agent.md; do
  ls apps/daemon/templates/workflows/bug-fix-p4/agents/$agent
done
# builder.md should resolve via parentTemplate
ls apps/daemon/templates/workflows/product-development/agents/builder.md
```
Expected: All files exist.

**Step 3: Verify no dangling references**

Check that bug-fix-reviewer.md is gone:
```bash
ls apps/daemon/templates/workflows/bug-fix/agents/bug-fix-reviewer.md 2>&1 || echo "Correctly removed"
```
Expected: "Correctly removed"

---

### Task 8: Update workflows CLAUDE.md with new template documentation
**Depends on:** Task 5, Task 6
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/CLAUDE.md`

**Purpose:** Document the two new workflow templates (`bug-fix` v2.0.0 and `bug-fix-p4`) in the CLAUDE.md so agents and developers know what templates exist and how they differ from `product-development`.

**Step 1: Add template entries to the Files table**

In the "Files" section of `apps/daemon/templates/workflows/CLAUDE.md`, add entries for the two new templates alongside `product-development/`.

Add after the `product-development/` row:
```
| `bug-fix/` | Bug-fix workflow (Git): investigate → confirm hypothesis → build → PR |
| `bug-fix-p4/` | Bug-fix workflow (Perforce): investigate → confirm hypothesis → build → shelve |
```

**Step 2: Add a brief "Bug-Fix Workflow Templates" section**

After the existing "Related Files" section at the end of the document, add:

```markdown
## Bug-Fix Workflow Templates

Two bug-fix variants exist alongside the default `product-development` template:

| Template | VCS | Final Phase | Isolation |
|----------|-----|-------------|-----------|
| `bug-fix` | Git | Pull Requests | `requiresWorktree: true` |
| `bug-fix-p4` | Perforce | Shelve | `requiresIsolation: true` |

Both share the same phase structure:
1. **Identify Issue** — `debug-agent` investigates and produces `investigation.md`
2. **Solve Issue** — `solve-agent` in ralph loop iterates hypothesis with user, produces `resolution.md`
3. **Backlog** — manual gate
4. **Build** — `bug-fix-taskmaster` → taskLoop(builder) → `bug-fix-qa`
5. **Pull Requests / Shelve** — VCS-specific final phase

### Key Artifacts

| Artifact | Written by | Read by |
|----------|-----------|---------|
| `investigation.md` | debug-agent | solve-agent |
| `resolution.md` | solve-agent | bug-fix-taskmaster, bug-fix-qa, pr-agent/shelve-agent |

### Parent Template Inheritance

Both templates use `parentTemplate: "product-development"` (not `product-development-p4`) to inherit `builder.md`. The P4-specific agents (`sync-agent.md`, `shelve-agent.md`) are copied directly into `bug-fix-p4/agents/` because parent resolution is single-level.
```

**Step 3: Commit**
```bash
git add apps/daemon/templates/workflows/CLAUDE.md
git commit -m "docs: document bug-fix and bug-fix-p4 workflow templates in CLAUDE.md"
```

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | + | All design requirements addressed — 5-phase pipeline, both Git and P4 variants, investigation.md/resolution.md artifacts, all agent rewrites/additions/deletions |
| Accurate | + | All file paths verified via Glob — existing files exist, new files target correct directories |
| Commands valid | + | Schema validation command fixed to ESM-safe `readFileSync` + `JSON.parse` (was CommonJS `require()`) |
| YAGNI | + | Every task directly serves a stated design requirement; no speculative tasks |
| Minimal | + | Tasks are well-scoped and parallelizable (1-4 independent, 5-6 depend on 1-4, 7 depends on 5-6) |
| Not over-engineered | + | Simple approach — markdown prompts, JSON config, no engine changes. P4 copies agents rather than inventing sharing mechanism |
| Key Decisions documented | + | 5 decisions with rationale in header |
| Context sections present | + | Purpose on all tasks, Not In Scope on Task 1, Gotchas on Task 6 |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | CLEAN | 0 | All major sections present and well-formed. Task list complete with 7 tasks covering every deliverable. |
| Feasibility | CLEAN | 0 | All file paths verified, commands valid, `ajv` available in ESM context, `parentTemplate` won't cause schema validation failures. |
| Completeness | EDITED | 1 | Added Task 8 to update `apps/daemon/templates/workflows/CLAUDE.md` with documentation for the two new templates. |
| Risk | EDITED | 5 | Fixed `potato:update-ralph-loop` → `ralph_loop_dock` (3 call sites). Added rollback note for reviewer deletion. Added breaking-change warning for in-flight tickets. |
| Optimality | EDITED | 1 | Clarified Task 6 Step 2 to explicitly exclude `bug-fix-qa.md` from copy step (P4 variant has its own QA rewrite). |
