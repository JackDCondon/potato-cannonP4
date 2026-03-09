# Complexity-Based Model Routing Design

**Date:** 2026-03-09
**Status:** Draft

## Overview

Add a three-level complexity rating system to tickets and tasks that drives automatic model selection per agent. Inspired by superpowers-bd's complexity routing. Goal: use cheaper models for simple work, reserve capable models for complex work.

## Complexity Levels

Three levels, consistent across all agents and UI:

| Level | Heuristic |
|-------|-----------|
| `simple` | ≤1 non-test file, ≤1 implementation step. Config/wording/export changes. |
| `standard` | 2-3 non-test files, clear requirements, routine work. **Default.** |
| `complex` | 4+ non-test files OR new architectural patterns OR security-sensitive OR cross-system integration. |

Heuristics live in a single shared `potato:estimate-complexity` skill (see below). All agents reference this skill rather than duplicating the heuristics inline.

---

## 1. Data Model

### DB Schema

Add `complexity` column to two tables:

```sql
-- tickets table
ALTER TABLE tickets ADD COLUMN complexity TEXT DEFAULT 'standard'
  CHECK(complexity IN ('simple', 'standard', 'complex'));

-- tasks table
ALTER TABLE tasks ADD COLUMN complexity TEXT DEFAULT 'standard'
  CHECK(complexity IN ('simple', 'standard', 'complex'));
```

- Defaults to `'standard'` at creation — never null, no empty state to handle.
- Stored as a simple enum string, directly queryable.

### TypeScript Types

```typescript
// packages/shared/src/types/
export type Complexity = 'simple' | 'standard' | 'complex'

// Add to Ticket interface
complexity: Complexity

// Add to Task interface
complexity: Complexity
```

---

## 2. Workflow Template Schema

The `model` field on agent workers is extended to support a complexity matrix:

```json
// Before (still valid — string form)
{ "model": "haiku" }

// New: complexity matrix
{
  "model": {
    "simple": "haiku",
    "standard": "sonnet",
    "complex": "opus"
  }
}
```

Both forms remain valid. String form is backwards-compatible — used as-is for all complexity levels.

The template editor always shows the three-row matrix UI (no single-model mode). If all three rows are set to the same value, it serializes as the object form.

---

## 3. Runtime Model Resolution

### Executor Logic

`model-resolver.ts` is extended to handle the matrix shape:

```typescript
type ComplexityModelMap = { simple?: string; standard?: string; complex?: string }

function resolveModel(
  modelSpec: string | ComplexityModelMap | undefined,
  complexity: Complexity
): string | undefined {
  if (!modelSpec || typeof modelSpec === 'string') return modelSpec
  return modelSpec[complexity] ?? modelSpec['standard'] ?? undefined
}
```

### Complexity Source by Worker Context

| Worker context | Complexity source |
|----------------|------------------|
| Phase agent (refinement, architecture, spec, etc.) | Ticket-level complexity |
| Agent inside `taskLoop` | Task-level complexity, falling back to ticket-level if somehow unset |

The executor already distinguishes these two contexts (it has current task context when inside a task loop), so no structural changes are needed — just passing the right complexity value to `resolveModel`.

---

## 4. Complexity Lifecycle

Complexity is set and refined at three points in the workflow:

### 4a. Brainstorm Agent (ticket-level, initial estimate)
- Invokes `potato:estimate-complexity` skill
- Calls `set_ticket_complexity(complexity)` MCP tool before finishing
- Framed as an initial estimate — refinement will re-evaluate

### 4b. Refinement Agent (ticket-level, revised estimate)
- Re-evaluates complexity after requirements are fully understood
- Invokes `potato:estimate-complexity` skill
- Calls `set_ticket_complexity(complexity)` with updated value
- Most reliable estimate since the full refined scope is known

### 4c. Taskmaster / Spec Agent (task-level, per task)
- Sets complexity on each individual task when calling `create_task`
- Uses same heuristics applied to the individual task scope (not the whole ticket)
- `create_task` MCP tool extended to accept optional `complexity` field (defaults to `'standard'`)

### 4d. Human Override (ticket-level only, anytime)
- User can change ticket-level complexity via UI badge at any time
- Task-level complexity is agent-set only in MVP

---

## 5. MCP Tool Changes

| Tool | Change |
|------|--------|
| `set_ticket_complexity` | New tool. Args: `complexity: Complexity`. Sets ticket complexity. |
| `create_task` | Add optional `complexity?: Complexity` field. Defaults to `'standard'`. |

---

## 6. Shared Complexity Skill

A new skill `potato:estimate-complexity` serves as the single source of truth for heuristics. All agents invoke it instead of embedding heuristics inline.

**Skill responsibilities:**
1. Present the heuristics table
2. Walk the agent through evaluating the current ticket or task scope
3. Recommend a complexity level with brief reasoning
4. Instruct the agent to call the appropriate MCP tool to persist it

**Access:** Skill is prefixed `potato:` so it's accessible to all agents, including those with `"disallowTools": ["Skill(superpowers:*)"]`.

**Updating heuristics:** Edit the skill file only — all three agents pick up changes immediately.

---

## 7. Frontend UI

### Template Editor (AgentCard)

Each agent card gains a "Model Routing" section in its expanded view, always showing the three-row matrix:

```
Model Routing:
  Simple:   [haiku  ▾]
  Standard: [sonnet ▾]
  Complex:  [opus   ▾]
```

Model dropdown options: `haiku`, `sonnet`, `opus`, plus free-text for explicit model IDs (e.g. `claude-sonnet-4-20250514`).

Serializes to `"model": { "simple": "...", "standard": "...", "complex": "..." }` in the template.

### Ticket Detail View

Complexity badge always visible in the ticket metadata panel:

| Level | Color |
|-------|-------|
| `simple` | Gray |
| `standard` | Blue |
| `complex` | Amber/Orange |

Clicking the badge opens a dropdown to change complexity (simple/standard/complex). Change saved immediately via API. Badge is always shown (never hidden) since complexity always has a value.

### Task List

Each task row shows a small colored dot after the task name using the same color scheme. Read-only in MVP (agent-set only). Dot is always visible since tasks always have a complexity value.

---

## 8. Agent Prompt Changes

Three agent prompts receive minimal additions:

| Agent | Change |
|-------|--------|
| `brainstorm.md` | Add: invoke `potato:estimate-complexity`, call `set_ticket_complexity` before finishing |
| `refinement.md` | Add: re-evaluate complexity at end of refinement, invoke `potato:estimate-complexity`, call `set_ticket_complexity` |
| `taskmaster.md` / spec agent | Add: set `complexity` field on each `create_task` call using `potato:estimate-complexity` |

---

## Scope: Perforce Workflow First

Initial implementation targets the Perforce / `product-development` workflow template. Architecture is generic — any workflow template that uses the `model` matrix syntax gets complexity routing automatically. No workflow-specific logic in the resolver.

---

## Out of Scope (MVP)

- Human override of task-level complexity
- Complexity analytics / cost tracking dashboards
- Per-project override of the model matrix (template-level config only)
- Continuous complexity scaling (0–1 float) — three levels are sufficient
