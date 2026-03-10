# Project Workflows (Multi-Board) Design

**Date:** 2026-03-10
**Status:** Approved

## Problem

A project (codebase) can only have one workflow template today, enforced by a single `template_name` on the `projects` row and a `UNIQUE` constraint on `projects.path`. Users want multiple independent kanban boards under one project — one for bug fixes, one for game dialogue, one for game design data, etc. — each using potentially the same or different workflow templates but tracked independently.

## Solution

Add a `project_workflows` table. Each row is an independent board with its own template reference, ticket queue, and configuration. One workflow per project is marked as default (replacing the current single-template model).

---

## Data Model

### New table: `project_workflows`

```sql
CREATE TABLE project_workflows (
  id            TEXT PRIMARY KEY,         -- UUID
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,            -- e.g. "Bug Fixes", "Game Dialogue"
  template_name TEXT NOT NULL,            -- reference to template registry
  is_default    INTEGER NOT NULL DEFAULT 0, -- boolean, one per project
  order_index   INTEGER NOT NULL DEFAULT 0, -- display ordering
  disabled_phases TEXT,                   -- JSON array, per-workflow phase overrides
  branch_prefix TEXT,                     -- e.g. "bug", "feat", "dialogue"
  created_at    TEXT NOT NULL             -- ISO 8601
);
```

### `tickets` table changes

Add `workflow_id TEXT REFERENCES project_workflows(id)` column (nullable for migration, required for new tickets).

### `projects` table changes

`template_name` and `template_version` columns are deprecated but kept for the migration period. After backfill they are no longer used.

---

## Migration

1. For each existing project with a `template_name`, auto-create one `project_workflows` row (`is_default = 1`) using that template.
2. Backfill all existing tickets: set `workflow_id` to their project's default workflow.
3. Leave `projects.template_name` / `template_version` in place (unused) — no destructive schema changes.

---

## UI Changes

### Sidebar

- Project items become **expandable**
- Expanding a project reveals its workflows as child items
- Clicking a workflow opens that board's kanban
- Default workflow is shown first; others follow by `order_index`

### Project Settings

- New **Workflows** tab/section
- Lists all workflows with: name, template, branch prefix, disabled phases
- Actions: Add, Rename, Reorder, Configure, Delete
- "Add Workflow" opens a template picker (from template registry)

### Kanban / Ticket Creation

- Tickets are created within the context of the open workflow board
- Ticket ID prefix still derived from project display name (e.g. `POT-1`), shared across all workflows of a project
- Workflow board is the primary filter for the kanban view

---

## Key Properties

- **Independent queues:** Each workflow has its own ticket list; no cross-contamination
- **Same template allowed:** Two workflows in one project can reference the same template (e.g. two separate bug-fix queues)
- **Per-workflow config:** `disabled_phases`, `branch_prefix` are set independently per workflow
- **Default workflow:** Existing integrations (Telegram, API calls without explicit workflow) target the default workflow
- **No path uniqueness removal needed:** The original constraint stays; the multi-board feature lives entirely within a project
