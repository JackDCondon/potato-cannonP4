# Bug-Fix Workflow Design

## Overview

A dedicated `bug-fix` workflow template providing a fast path from bug report to shipped fix. Replaces the full product-development pipeline (Refinement → Architecture → Specification) with a single interactive diagnostic phase that produces a targeted resolution artifact, then proceeds directly to Build.

## Phases

```
Solve Issue → Backlog → Build → Pull Requests → (Done)
```

| Phase | Workers | Isolation | Gate |
|-------|---------|-----------|------|
| Solve Issue | 1× opus agent (interactive) | None | Auto → Backlog |
| Backlog | — | — | Manual → Build |
| Build | ralph loop: builder + bug-fix-reviewer | worktree | Auto → Pull Requests |
| Pull Requests | pr-agent | — | Terminal |

## Phase 1: Solve Issue

### Agent: `debug-agent.md`

A single `opus` agent. No ralph loop — the iterative conversation via `chat_ask` IS the review loop. The agent follows the systematic-debugging 4-phase structure internally; the user experiences a natural conversation with a senior developer.

**Internal phases (invisible to user):**

1. **Root Cause Investigation** — Gathers evidence via `chat_ask`:
   - Expected vs actual behavior
   - Error messages / stack traces
   - Steps to reproduce
   - Environment, version, platform
   - Any recent changes before the bug appeared

2. **Pattern Analysis** — Probes working vs broken states:
   - When did it start?
   - Does it affect all users / configs / environments?
   - Any known workarounds?

3. **Hypothesis Formation** — Agent synthesises evidence into a single specific hypothesis and presents it conversationally:
   > "Based on what you've described, I believe the root cause is X because Y. The evidence pointing here is Z. Does that match what you're seeing?"

   If the user pushes back or adds context, agent refines and re-presents. Iterates until confirmed.

4. **Fix Plan** — Once hypothesis is confirmed, agent writes `resolution.md` artifact and completes the phase.

**Model:** `opus`
**No `requiresWorktree`** — analysis only, no code changes.

### Output Artifact: `resolution.md`

```markdown
# Bug Resolution

## Bug Description
[User's description in their own words]

## Root Cause
[The specific WHY — what code/state/condition causes this]

## Evidence
[What the conversation revealed that confirms the hypothesis]

## Fix Plan
### Files to Change
- `path/to/file.ts` — [what to change and why]

### Approach
[Specific implementation guidance for the builder]

### Regression Test Strategy
[What tests to add/modify to prevent recurrence]
```

## Phase 2: Backlog

Empty workers array, `manual: true`. User reviews `resolution.md` and advances the ticket when ready to implement.

## Phase 3: Build

### Workers

```
ralph loop (maxAttempts: 2)
├── builder agent      — reads resolution.md, implements the fix
└── bug-fix-reviewer   — cross-references resolution.md, validates fix
```

`requiresWorktree: true` — isolated Git branch, clean PR creation, safe to abandon.

### Agent: `builder.md` (inherited from product-development)

Builder reads `resolution.md` from artifacts. The fix plan provides specific files and approach — no task decomposition needed.

### Agent: `bug-fix-reviewer.md`

Specialized reviewer that cross-references `resolution.md`. Checks:
- Does the change address the stated root cause (not just symptoms)?
- Is the change minimal and surgical (no unnecessary refactoring)?
- Does it follow the fix approach from the resolution artifact?
- Are the regression tests from the test strategy present?
- No new issues introduced?

Signals verdict via `ralph_loop_dock`. On rejection, provides specific feedback tied to resolution artifact gaps.

**Model:** `haiku` (focused pass/fail review)

## Phase 4: Pull Requests

Reuses `pr-agent.md` from `product-development` via `parentTemplate` fallback. No changes needed.

## Workflow JSON Structure

```json
{
  "name": "bug-fix",
  "parentTemplate": "product-development",
  "phases": [
    {
      "id": "Solve Issue",
      "name": "Solve Issue",
      "description": "Interactive diagnostic session to identify root cause and produce a fix plan",
      "workers": [
        {
          "id": "debug-agent",
          "type": "agent",
          "source": "agents/debug-agent.md",
          "description": "Interactively diagnoses the bug and produces resolution.md",
          "model": "opus"
        }
      ],
      "transitions": { "next": "Backlog" }
    },
    {
      "id": "Backlog",
      "name": "Backlog",
      "description": "Resolution confirmed, awaiting implementation",
      "workers": [],
      "transitions": { "next": null, "manual": true }
    },
    {
      "id": "Build",
      "name": "Build",
      "description": "Implement the fix from resolution.md with adversarial review",
      "workers": [
        {
          "id": "build-ralph-loop",
          "type": "ralphLoop",
          "description": "Implements and reviews the fix",
          "maxAttempts": 2,
          "workers": [
            {
              "id": "builder-agent",
              "type": "agent",
              "source": "agents/builder.md",
              "description": "Implements the fix from resolution.md",
              "disallowTools": ["Skill(superpowers:*)"],
              "model": "sonnet"
            },
            {
              "id": "bug-fix-reviewer-agent",
              "type": "agent",
              "source": "agents/bug-fix-reviewer.md",
              "description": "Verifies fix addresses root cause from resolution.md",
              "model": "haiku"
            }
          ]
        }
      ],
      "transitions": { "next": "Pull Requests" },
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
          "description": "Creates PR with fix summary and test evidence"
        }
      ],
      "transitions": { "next": null }
    }
  ]
}
```

## New Files Required

| File | Purpose |
|------|---------|
| `apps/daemon/templates/workflows/bug-fix/workflow.json` | Workflow definition |
| `apps/daemon/templates/workflows/bug-fix/agents/debug-agent.md` | Solve Issue interactive agent |
| `apps/daemon/templates/workflows/bug-fix/agents/bug-fix-reviewer.md` | Build reviewer agent |

## Inherited from product-development (via parentTemplate)

- `agents/builder.md`
- `agents/pr-agent.md`

## Usage

Register a second project pointing at the same codebase with `template: "bug-fix"`. Drop bug tickets into this project's Solve Issue lane. Feature tickets continue using the `product-development` project as normal.

## Non-Goals

- No task decomposition (taskmaster, task-review, task-loop) — resolution.md is the plan
- No architecture or specification phases — bugs don't need design docs
- No QA agent after Build — reviewer + regression tests cover it
- No P4 variant in this iteration (can be added as `bug-fix-p4` following the product-development-p4 pattern)
