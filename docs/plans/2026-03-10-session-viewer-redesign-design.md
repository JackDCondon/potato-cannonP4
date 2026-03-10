# Session Viewer Redesign

**Date:** 2026-03-10
**Status:** Design validated

## Problem

The current Session Viewer is session-scoped, not ticket-scoped. It shows one agent interaction then closes. Output is a raw JSONL stream with ANSI escape codes, unformatted JSON, and no meaningful tool call collapsing. Phase transitions are invisible.

## Goals

1. Unified ticket-level timeline that automatically follows the ticket through all phases
2. Clear visual phase transition markers using swimlane colors
3. Clean, readable output with collapsible tool calls and syntax highlighting
4. Extensible rendering architecture — generic JSON display now, per-tool rich views later

---

## Route & Lifecycle Architecture

**New route:** `/transcript/ticket/:ticketId` replaces `/transcript/:sessionId`

- `ViewSessionButton` navigates directly to the ticket-level route — no more pending page polling
- The `pending.tsx` route is removed; idle state is handled inline
- The page owns the full ticket timeline from first session to present

**Backend additions:**
- `GET /api/projects/:projectId/tickets/:ticketId/sessions` — returns all sessions for a ticket ordered by `startedAt`, with metadata (phase, agentType, status)
- SSE `session:output` events already include `sessionId`; frontend filters by sessions belonging to this ticket

**Frontend stitching logic:**
1. On mount: fetch all sessions for ticket → load each session's JSONL log in order → merge into one unified entry array with phase dividers inserted between sessions
2. Subscribe to SSE `session:output` — when a new `session_start` arrives for this ticketId, append a phase divider + begin streaming live entries
3. When a session ends (`session_end` entry), append a "Phase complete — waiting for next phase" marker at the bottom

---

## Phase Transition UI

### Sticky Header (always visible at top)
- Shows current phase name + agent type
- Left border or background tint in the current swimlane color
- Includes ticket title, current status, and live/idle indicator dot
- Updates live as new sessions start (reads from latest `session_start` meta)

### In-Stream Phase Divider (full-width banner)
- Full-width, bold — hard to miss
- Takes the swimlane color of the phase the ticket is **entering**
- Content: `→ Build Phase · architect-agent · Mar 10, 2:34pm`
- Swimlane color comes from shared board color config (exposed via API or shared constants)
- Clearly separates one agent's output from the next

### Idle Marker (appears when session ends, no new one yet)
- Subtle — just text: `Phase complete · waiting for next phase · 2:34pm`
- Not animated, not a spinner — just a record
- Replaced automatically when the next phase divider arrives

---

## Output Rendering

### ANSI Cleanup
- Strip all ANSI escape codes from `raw` and tool result content before display
- Use `strip-ansi` or a simple regex applied at parse time

### Tool Call Rows (collapsed by default)
- Collapsed header: `▶ ToolName → primary argument`
  - `Read`/`Write`/`Edit` → file path
  - `Bash` → command string
  - Unknown tools → first input key value
- Expand to show: pretty-printed input JSON + result content
- Error results: red left border when collapsed so failures are scannable without expanding

### Syntax Highlighting (extensible slot)
- Expanded JSON: pretty-printed with syntax highlighting (highlight.js or Prism)
- Bash output: dark terminal block style
- File content from `Read` results: language detected from file extension → highlighted accordingly
- Each tool type can later graduate from generic JSON to a purpose-built display (diff view for `Edit`, file tree for `Glob`, etc.)

### Assistant Text Blocks
- Render as markdown — no collapsing
- These are the narrative of what the agent is doing and should always be visible

---

## What's Not Changing

- Full-page route (not a panel or drawer)
- Auto-scroll to bottom with manual disable
- Copy transcript button
- Token count display in header

---

## Implementation Scope

### Backend
- [ ] Add `GET /api/projects/:projectId/tickets/:ticketId/sessions` endpoint
- [ ] Ensure SSE `session:output` payload includes `ticketId` for client-side filtering

### Frontend
- [ ] New route `/transcript/ticket/:ticketId`
- [ ] Ticket-level session stitching logic (load all sessions, merge with dividers)
- [ ] SSE subscription that appends new sessions as they start
- [ ] Sticky phase header component
- [ ] Phase divider banner component (swimlane-colored)
- [ ] Idle/waiting marker component
- [ ] `EventRow` overhaul: ANSI stripping, collapsed tool calls, error border
- [ ] Syntax highlighting for expanded tool content
- [ ] Remove `pending.tsx` route
- [ ] Update `ViewSessionButton` to navigate to new route
