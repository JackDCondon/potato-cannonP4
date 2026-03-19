# Bug-Fix Workflow Design

**Date:** 2026-03-19
**Status:** Draft

## Overview

Redesign the bug-fix workflow template to provide a structured investigation → confirmation → build pipeline. Create two variants: `bug-fix` (Git) and `bug-fix-p4` (Perforce).

## Motivation

The current bug-fix template combines investigation and hypothesis confirmation into a single "Solve Issue" phase. Splitting this into distinct phases gives:

- **Clearer phase gates** — investigation is complete before hypothesis iteration begins
- **User-validated hypotheses** — the user confirms root cause before any code is written
- **Structured artifact** — `resolution.md` with 5 sections gives the TaskMaster everything it needs
- **Less review overhead** — bug fixes are small; per-task ralph loops are overkill

## Phase Flow

```
┌──────────────────┐
│  Identify Issue   │  debug-agent explores code, asks questions
│  (single agent)   │  follows systematic-debugging methodology
└────────┬─────────┘
         │ auto
         ▼
┌──────────────────┐
│   Solve Issue     │  ralph loop: agent presents hypothesis
│  (ralph loop)     │  user approves or gives feedback → iterate
│                   │  on approval → creates resolution.md
└────────┬─────────┘
         │ auto
         ▼
┌──────────────────┐
│    Backlog        │  manual gate
│  (empty)          │  user confirms ready to build
└────────┬─────────┘
         │ manual
         ▼
┌──────────────────┐
│     Build         │  taskmaster → taskLoop → QA
│  (isolated env)   │  no per-task review loop
└────────┬─────────┘
         │ auto
         ▼
┌──────────────────┐     ┌──────────────────┐
│  Pull Requests    │ OR  │     Shelve        │
│  (Git only)       │     │  (P4 only)        │
└──────────────────┘     └──────────────────┘
```

## Phase Details

### Phase 1: Identify Issue

**Worker:** Single `debug-agent` (modelTier: high)

Follows the systematic-debugging methodology:

1. **Root Cause Investigation** — reads error messages, explores codebase, traces call chains, asks clarifying questions via `chat_ask` when the bug report has gaps (QA often misses state/environment details important to programmers)
2. **Pattern Analysis** — finds working examples, compares with broken state, identifies all differences
3. **Preliminary Findings** — synthesizes evidence into initial hypothesis direction

The agent explores code freely and asks questions interactively. It does NOT present a formal hypothesis yet — that happens in Solve Issue.

**Critical: Cross-session context preservation.** The debug-agent and solve-agent run as separate Claude sessions. Without an explicit handoff artifact, the solve-agent would need to re-investigate the entire codebase — duplicating all the tool calls the debug-agent already made.

**Output:** `investigation.md` artifact attached to the ticket via `potato:create-artifacts`. This artifact captures everything the debug-agent discovered so the solve-agent can start informed:

```markdown
## Bug Report Summary
[The bug as described by the user, including any clarifications from Q&A]

## Investigation Notes

### Files Examined
- `path/to/file.ts:42` — [what was found here, relevant code behavior]
- `path/to/other.ts:118` — [what was found here]

### Call Chain Trace
[How data flows through the relevant code paths — the trace the agent followed]

### Working vs Broken Comparison
[If applicable — what works, what doesn't, and the differences identified]

### User Clarifications
[Key details learned from interactive Q&A that weren't in the original bug report]

## Preliminary Direction
[The agent's initial read on where the root cause likely lives — NOT a formal hypothesis yet, but enough for the solve-agent to skip re-investigation and jump straight to hypothesis formation]
```

This artifact is the **primary input** for the solve-agent. It should contain enough detail that the solve-agent can formulate a hypothesis without re-reading the files the debug-agent already examined.

**Transition:** Auto → Solve Issue

### Phase 2: Solve Issue

**Worker:** `solve-ralph-loop` (maxAttempts: 5)

Contains a single agent that:

1. **Reads `investigation.md`** via `potato:read-artifacts` — this is its primary input, containing all the debug-agent's findings, file traces, and preliminary direction. The solve-agent should NOT re-read the files listed in `investigation.md` unless it needs to verify something specific.
2. **Formulates a hypothesis** from the investigation findings
3. **Presents Root Cause + Hypothesis + Proposed Fix** to the user via `chat_ask`

The user is the adversarial reviewer:

- **User approves** → agent writes `resolution.md` artifact, loop exits
- **User rejects/gives feedback** → agent refines hypothesis, re-presents

The ralph loop here uses the user as the quality gate rather than a second AI agent. This is intentional — the user has domain knowledge no AI reviewer can match for debugging.

**Artifact produced:** `resolution.md` with these sections:

```markdown
## Root Cause
[What's actually broken and where in the code]

## Hypothesis
[Why it's broken — the "because"]

## Proposed Fix
[What to change — specific enough for TaskMaster to create tasks]

## Reproduction Steps
[How to trigger and verify the bug]

## Test Strategy
[How to confirm the fix works and prevent regression]
```

**Transition:** Auto → Backlog

### Phase 3: Backlog

**Workers:** None (manual gate)

User reviews `resolution.md` one final time and moves to Build when ready.

**Transition:** Manual → Build

### Phase 4: Build

**Workers:**

```
├── taskmaster-agent    Creates tasks from resolution.md
├── build-task-loop     taskLoop over pending tasks
│   └── builder-agent   Executes each task (no per-task review)
└── qa-agent            Holistic review of entire fix against resolution.md
```

- **TaskMaster** reads `resolution.md`, prioritizes the Proposed Fix and Test Strategy sections, creates tasks
- **Builder** executes each task sequentially
- **QA Agent** runs once after all tasks complete — checks the full fix holistically against `resolution.md` (root cause addressed? regression tests present? no new issues?)

For P4 variant, the taskLoop includes a `sync-agent` before the builder to sync the workspace and resolve conflicts.

**Git Build structure:**
```
├── taskmaster-agent
├── build-task-loop (taskLoop)
│   └── builder-agent
└── qa-agent
```

**P4 Build structure:**
```
├── taskmaster-agent
├── build-task-loop (taskLoop)
│   ├── sync-agent        ← P4 workspace sync + conflict resolution
│   └── builder-agent
└── qa-agent
```

**Isolation:**
- Git: `requiresWorktree: true`
- P4: `requiresIsolation: true`

**Transition:** Auto → Pull Requests (Git) / Shelve (P4)

### Phase 5a: Pull Requests (Git)

**Worker:** `pr-agent` (inherited from product-development parent)

Pushes branch, creates GitHub PR with fix summary, links to `resolution.md`.

### Phase 5b: Shelve (P4)

**Worker:** `shelve-agent` (inherited from product-development-p4 parent)

Creates numbered changelist, consolidates files, shelves for review, provides Swarm link if configured.

## Template Structure

### bug-fix (Git)

```
templates/workflows/bug-fix/
├── workflow.json
└── agents/
    ├── debug-agent.md          Phase 1: Investigation
    ├── solve-agent.md          Phase 2: Hypothesis iteration (NEW)
    ├── bug-fix-qa.md           Phase 4: Holistic QA (NEW)
    └── (builder.md)            Inherited from product-development
    └── (pr-agent.md)           Inherited from product-development
```

`parentTemplate: "product-development"` — inherits `builder.md`, `taskmaster.md`, `pr-agent.md`

### bug-fix-p4 (Perforce)

```
templates/workflows/bug-fix-p4/
├── workflow.json
└── agents/
    ├── debug-agent.md          Phase 1: Investigation (same as Git)
    ├── solve-agent.md          Phase 2: Hypothesis iteration (same as Git)
    ├── bug-fix-qa.md           Phase 4: Holistic QA (same as Git)
    └── (builder.md)            Inherited from product-development
    └── (sync-agent.md)         Inherited from product-development-p4
    └── (shelve-agent.md)       Inherited from product-development-p4
```

`parentTemplate: "product-development-p4"` — inherits `builder.md`, `taskmaster.md`, `sync-agent.md`, `shelve-agent.md`

## Agent Changes

### debug-agent.md (REWRITE)

Current debug-agent combines all 4 phases (investigate, analyze, hypothesize, write artifact). New version focuses only on investigation:

- Explores codebase freely (Read, Grep, Glob, Bash)
- Asks clarifying questions via `chat_ask` when bug report has gaps
- Follows systematic-debugging Phase 1 (Root Cause Investigation) and Phase 2 (Pattern Analysis)
- Does NOT present a formal hypothesis — that's the solve-agent's job
- **Writes `investigation.md` artifact** via `potato:create-artifacts` capturing: files examined (with line numbers and findings), call chain traces, working vs broken comparisons, user clarifications, and preliminary direction
- This artifact is critical — it's the cross-session handoff that prevents the solve-agent from re-investigating the entire codebase

### solve-agent.md (NEW)

Presents hypothesis to user and iterates:

- **First action:** reads `investigation.md` via `potato:read-artifacts` — this contains all findings from the debug-agent (files examined, call traces, preliminary direction)
- Formulates Root Cause + Hypothesis + Proposed Fix based on investigation findings — should NOT re-read files already examined unless verifying a specific detail
- Presents to user via `chat_ask`
- Iterates based on feedback until user confirms
- On confirmation, writes `resolution.md` via `potato:create-artifacts`
- Ralph loop uses `potato:update-ralph-loop` — user approval = approve, user rejection = reject with feedback

### bug-fix-qa.md (NEW)

Holistic QA review after all build tasks complete:

- Reads `resolution.md` artifact
- Reviews all code changes (git diff or p4 diff depending on VCS)
- Checklist: root cause addressed, fix matches plan, regression tests present, no new issues
- Reports findings via `chat_notify`
- Signals pass/fail

### bug-fix-reviewer.md (REMOVED)

No longer needed — per-task ralph loop is removed. QA agent replaces it with a single holistic pass.

## Artifact Flow

```
Phase 1: Identify Issue
    │
    │  writes investigation.md
    │  (files examined, call traces, comparisons, preliminary direction)
    │
    ▼
Phase 2: Solve Issue
    │
    │  reads investigation.md (avoids re-investigating)
    │  writes resolution.md
    │  (root cause, hypothesis, proposed fix, repro steps, test strategy)
    │
    ▼
Phase 4: Build
    │
    │  TaskMaster reads resolution.md (focuses on Proposed Fix + Test Strategy)
    │  QA Agent reads resolution.md (validates fix against root cause)
    │
    ▼
Phase 5: PR / Shelve
    │
    │  reads resolution.md (for PR/CL description)
```

Each artifact serves as the **sole context handoff** between sessions. No agent should need to re-do work a previous agent already captured in an artifact.

## Out of Scope

- **Unified template with VCS switching** — would require workflow engine changes. Separate templates for now, refactor later.
- **Multi-bug tickets** — one bug per ticket. Complex multi-bug investigations are a different workflow.
- **Automated reproduction** — agent doesn't run the app to reproduce. It investigates code and asks the user.

## Migration

The current `bug-fix` template (v1.0.1) will be replaced. No migration needed — existing in-progress tickets on the old template will continue with their current phase; new tickets pick up the new template.
