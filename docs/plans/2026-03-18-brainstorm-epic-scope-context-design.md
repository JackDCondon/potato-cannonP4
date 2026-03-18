# Brainstorm-to-Epic Scope Context Design

**Date:** 2026-03-18
**Status:** Approved
**Problem:** Ticket agents work in isolation. When brainstorming creates multiple tickets for a larger goal, each agent can't see sibling tickets, the overall plan, or scope boundaries. This causes duplicated work, scope drift, and conflicting architecture decisions.

## Approach: Brainstorm-as-Grouping

Rather than introducing a new Epic entity, we fix the existing (half-built) brainstorm-to-ticket linkage and let brainstorms naturally evolve into Epics in the UI. The `brainstormId` parameter already flows through `create_ticket` but is never persisted on the ticket row. Fixing this gives us sibling discovery, scope context, and a natural grouping mechanism with no new tables.

### Why Not a Separate Epic Entity?

- Tickets have `phase`, `worker_state`, `workflow_id NOT NULL` -- all inapplicable to Epics.
- Putting Epics in the tickets table requires discriminator guards on every query.
- A separate `epics` table adds a full CRUD layer, API routes, and UI views for a concept that the brainstorm entity already represents.
- The brainstorm conversation contains the full context of *why* tickets were created together -- it's the natural home for the plan summary.

## 1. Data Model

### Migration V21

Two changes to existing tables:

```sql
-- Track which brainstorm created each ticket
ALTER TABLE tickets ADD COLUMN brainstorm_id TEXT REFERENCES brainstorms(id) ON DELETE SET NULL;
CREATE INDEX idx_tickets_brainstorm_id ON tickets(brainstorm_id) WHERE brainstorm_id IS NOT NULL;

-- Store the overall plan summary on the brainstorm
ALTER TABLE brainstorms ADD COLUMN plan_summary TEXT;
```

**Backfill:** For existing brainstorms with `created_ticket_id` set, populate that ticket's `brainstorm_id`:

```sql
UPDATE tickets SET brainstorm_id = (
  SELECT id FROM brainstorms WHERE created_ticket_id = tickets.id
)
WHERE id IN (SELECT created_ticket_id FROM brainstorms WHERE created_ticket_id IS NOT NULL);
```

### `create_ticket` Fix

The `brainstormId` parameter already exists in the MCP tool schema and gets passed to the REST endpoint, but the ticket store never persists it. Fix:

1. Add `brainstormId?: string` to `CreateTicketInput` in the ticket store
2. Include `brainstorm_id` in the INSERT statement
3. Map it in `rowToTicket()`

### Type Changes

**`packages/shared/src/types/ticket.types.ts`:**
- Add `brainstormId?: string` to `Ticket` interface

**`packages/shared/src/types/brainstorm.types.ts`:**
- Add `planSummary?: string` to `Brainstorm` interface
- Add `ticketCount?: number` and `activeTicketCount?: number` for API enrichment

## 2. MCP Tools

New file: `apps/daemon/src/mcp/tools/scope.tools.ts`

### `get_scope_context`

Single-call orientation briefing. Called once at agent startup.

**Parameters:** `ticketId?: string` (defaults to session ticket)

**Returns:**
```typescript
{
  ticket: { id, title, description (500 chars), phase, complexity }
  origin: { brainstormId, brainstormName, planSummary } | null
  dependsOn: [{ ticketId, title, phase, tier, satisfied, artifactFilenames }]
  dependedOnBy: [{ ticketId, title, phase, tier, satisfied }]
  siblings: [{ ticketId, title, phase, complexity, relationship }]
  workflow: { totalTickets, ticketsByPhase }
}
```

**Token cost:** ~400-800 tokens for a typical 5-ticket batch.

### `get_sibling_tickets`

Detail on demand when `get_scope_context` isn't enough.

**Parameters:** `ticketId?: string`, `includeDescriptions?: boolean`

**Returns:**
```typescript
{
  brainstormId: string | null
  siblings: [{
    ticketId, title, phase, complexity,
    description?: string (300 chars if includeDescriptions),
    dependencyRelation: "upstream" | "downstream" | "none",
    artifactFilenames: string[]
  }]
}
```

**Token cost:** ~200-600 without descriptions, ~600-1500 with.

### `get_dependents`

Reverse dependency lookup. Wraps the existing `getDependentsOfTicket()` store method (already implemented, just not MCP-exposed).

**Parameters:** `ticketId?: string`

**Returns:**
```typescript
{
  dependents: [{ ticketId, title, phase, tier, satisfied }]
}
```

**Token cost:** ~100-300 tokens.

### `set_plan_summary`

Called by the brainstorm agent after creating all tickets.

**Parameters:** `summary: string` (required)

**Behavior:** Stores the summary on the brainstorm row's `plan_summary` column. Only callable within a brainstorm session context.

## 3. Prompt Injection

### Auto-injection in `buildAgentPrompt`

In `apps/daemon/src/services/session/prompts.ts`, add a `formatScopeContext()` function after the existing dependency hint block.

When a ticket has a `brainstorm_id`, fetch the brainstorm's `plan_summary` and sibling tickets, then inject a `## Scope Context` section:

```
## Scope Context

**Epic goal:** [plan_summary text]

**Your role:** [this ticket's title]

**Sibling tickets:**
| ID | Title | Phase | Complexity |
|----|-------|-------|------------|
| POT-1 | Add auth middleware | Build | Medium |
| POT-3 | Update API schema | Spec | Low |

Stay in scope -- other tickets handle other parts. The `get_sibling_tickets`
and `get_dependents` tools are available if you encounter a specific ambiguity
about whether a component falls under your ticket or a sibling's. Don't call
them preemptively.
```

**Token budget:** ~300-500 tokens for a 5-ticket batch. The plan_summary is capped at ~200 words via brainstorm prompt instructions.

### Agent Prompt Updates

**Brainstorm agent** (`agents/brainstorm.md`):
> After creating all tickets, call `set_plan_summary` with a concise summary (100-200 words) of the overall plan. Structure it as: one paragraph describing the goal, then a bullet per ticket stating what it handles and how it relates to the others. This summary will be shown to every agent working on these tickets -- write it as a briefing for someone who knows nothing about the plan.

**Shared agent preamble** (`agents/shared.md`):
> The Scope Context section (when present) shows your ticket's role in a larger plan and your sibling tickets. This is usually sufficient to understand boundaries. Use `get_sibling_tickets` or `get_dependents` only when you have a specific question about scope -- for example, you're unsure whether a particular component falls under your ticket or a sibling's.

**Refinement** (`agents/refinement.md`):
> Reference sibling tickets when documenting scope boundaries. If the user asks about something owned by a sibling, redirect them to that ticket.

**Architect** (`agents/architect.md`):
> Read upstream dependency artifacts before designing. Don't redesign what siblings own -- reference their interfaces. Document integration points between tickets.

**Specification** (`agents/specification.md`):
> Verify each task falls within this ticket's scope. If a task would modify files owned by a sibling, note it as an integration point rather than specifying the change.

**Builder** (`agents/builder.md`):
> If you need to modify files that might belong to another ticket, call `get_sibling_tickets` to check before proceeding.

## 4. Brainstorm-to-Epic UI Evolution

### Epic Badge (Frontend-Only)

When rendering a brainstorm, check if it has linked tickets (`ticketCount > 0`):
- **Yes:** Render with an "Epic" label/badge and distinct color (e.g. purple/indigo). The brainstorm's `name` in the DB stays unchanged.
- **No:** Render as a normal brainstorm.

No backend changes for this -- purely cosmetic frontend logic based on `ticketCount`.

### Ticket Card Link

When a ticket has a `brainstormId`:
- Show a small link icon (e.g. Lucide `Link` icon) on the ticket card
- Tooltip on hover: brainstorm/epic name
- Click navigates to brainstorm detail view

### Deletion Warning

When deleting a brainstorm with active tickets:
- Query: `activeTicketCount` from the enriched brainstorm API response
- If > 0, show confirmation dialog: "This epic has N active tickets linked to it. Deleting it will remove the shared scope context those tickets use during refinement and execution. Continue?"
- If all tickets are Done, delete without warning.

### API Enrichment

Add to brainstorm GET response:
- `ticketCount: number` -- total linked tickets
- `activeTicketCount: number` -- tickets not in "Done" phase

Computed via subquery in the brainstorm store's `getBrainstorm`/`listBrainstorms` methods.

## 5. Scope Boundaries

### Not in MVP

- **Project management chat:** Resuming the brainstorm session as an epic PM (fast-follow)
- **Epic progress tracking:** Progress bars, phase breakdowns on the epic view
- **`check_scope_owner` tool:** Substring-based "who owns this?" lookup (add later if agents still struggle)
- **Adding tickets to existing epics:** Discouraged by design. New work = new brainstorm.
- **Epic lifecycle management:** No status field on brainstorms (active/completed/archived)

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| No new table | Brainstorm entity already models the 1:N relationship -- just wasn't persisted |
| `ON DELETE SET NULL` for brainstorm FK | Tickets survive brainstorm deletion, lose grouping link |
| Frontend-only Epic label | No backend coupling, trivially reversible, no edge cases |
| Auto-inject scope context in prompts | Agents get context without tool calls; same pattern as dependency hints |
| Tools are "reach for when stuck" | Prompt guidance frames tools as escape hatch, not default. Saves tokens. |
| No "add ticket to epic" flow | Plan summary is written for the original ticket set; adding tickets makes it stale |

## 6. Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `apps/daemon/src/mcp/tools/scope.tools.ts` | `get_scope_context`, `get_sibling_tickets`, `get_dependents`, `set_plan_summary` |

### Modified Files

| File | Change |
|------|--------|
| `apps/daemon/src/stores/migrations.ts` | V21: `brainstorm_id` on tickets, `plan_summary` on brainstorms, backfill |
| `apps/daemon/src/stores/ticket.store.ts` | Map `brainstorm_id` in rowToTicket, accept in CreateTicketInput, add to INSERT |
| `apps/daemon/src/stores/brainstorm.store.ts` | Map `plan_summary`, add ticket count methods |
| `packages/shared/src/types/ticket.types.ts` | Add `brainstormId?: string` to Ticket |
| `packages/shared/src/types/brainstorm.types.ts` | Add `planSummary?: string`, `ticketCount?: number`, `activeTicketCount?: number` |
| `apps/daemon/src/mcp/tools/index.ts` | Register scope tools |
| `apps/daemon/src/services/session/prompts.ts` | Add `formatScopeContext()` in `buildAgentPrompt` |
| `apps/daemon/templates/workflows/product-development/agents/brainstorm.md` | `set_plan_summary` instructions |
| `apps/daemon/templates/workflows/product-development/agents/shared.md` | Scope awareness guidance |
| `apps/daemon/templates/workflows/product-development/agents/refinement.md` | Cross-ticket context paragraph |
| `apps/daemon/templates/workflows/product-development/agents/architect.md` | Cross-ticket architecture paragraph |
| `apps/daemon/templates/workflows/product-development/agents/specification.md` | Scope fencing paragraph |
| `apps/daemon/templates/workflows/product-development/agents/builder.md` | Scope boundaries paragraph |
| `apps/daemon/src/server/routes/brainstorms.routes.ts` | Enrich GET with ticket counts |
| `apps/frontend/src/components/brainstorm/` | Epic badge, color, label logic |
| `apps/frontend/src/components/board/TicketCard.tsx` | Brainstorm link icon |
| Frontend brainstorm delete flow | Deletion warning dialog |

### Implementation Order

1. Migration + store plumbing (brainstorm_id, plan_summary, create_ticket fix)
2. MCP tools (scope.tools.ts, register in index)
3. Prompt injection (formatScopeContext in buildAgentPrompt)
4. Agent prompt updates (brainstorm, shared, refinement, architect, spec, builder)
5. API enrichment (ticket counts on brainstorm response)
6. Frontend (Epic badge, ticket link icon, deletion warning)
