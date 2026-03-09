# Session Transcript Viewer — Design

**Date:** 2026-03-09
**Status:** Approved for implementation

## Overview

Replace the broken Remote Control button with a "View Session" button that opens a live, syntax-highlighted transcript of the running Claude session in a new browser tab.

The session output data is already flowing — `session:output` SSE events are broadcast to all clients, and per-session JSONL log files are written in real-time. This feature is purely a UI surface over existing infrastructure.

## Entry Point

`ViewSessionButton` replaces `RemoteControlButton` in `ActivityTab`. Rendered as an `<a>` tag styled as a button with `target="_blank" rel="noopener noreferrer"` pointing to `/sessions/:sessionId`. Enabled when `hasActiveSession` is true. Requires no API call on click — the sessionId is already known from the active session state.

Remove all RC state machine logic (`pending` / `active` / `idle`, `useRemoteControlSSE`, RC API calls). The component becomes a simple link button.

## Route

New TanStack Router route: `apps/frontend/src/routes/sessions/$sessionId.tsx`

Full-page layout — no sidebar, no app chrome. Works as a standalone tab. Multiple transcripts can be open simultaneously for different sessions.

## Data Layer

**Historical events:**
`GET /api/sessions/:sessionId/log` — new daemon endpoint that reads the existing per-session JSONL log file and returns a parsed array of events. File is already written by `spawnClaudeSession`.

**Live events:**
Subscribe to `sse:session-output` custom window events (already dispatched by `useSSE.ts`). Filter by `sessionId`. Append matching events to local state.

**Session end:**
`sse:session-ended` event for this sessionId marks the page as "Ended" and stops waiting for new events.

**Auto-scroll:**
Stick to bottom while events arrive. If user scrolls up, pause and show a floating "↓ Jump to bottom" pill. Resume on click.

## Event Rendering

Each event is a collapsed row by default. Click to expand.

| Event type | Collapsed display | Expanded content |
|------------|-------------------|-----------------|
| `assistant` → text | Claude's message, ~2 lines truncated | Full message text |
| `assistant` → tool_use | `⚡ ToolName → key input param` | JSON input, syntax-highlighted |
| `user` → tool_result | `✓ result` or `✗ error` + first line | Full content, auto-detected language highlight |
| `system` task_started | `▶ Task: description` (section header, not collapsible) | — |
| `system` task_progress | `↻ Running: action description` | — |
| `raw` | Dimmed italic text | — |

Tool results are visually indented under their paired tool_use row.

**Syntax highlighting:** `highlight.js` with auto-detection. Applied only to expanded content. Detects JSON, TypeScript, C++, bash.

## Header Bar (fixed)

- Ticket title + session ID (from first `session_start` log event)
- Phase / agent type badge (e.g. `Build · taskmaster`)
- Live green dot while running; grey "Ended" badge when session exits
- Running token counter (from `usage.total_tokens` in system events)
- "Copy transcript" button (copies as readable markdown)

## Styling

- `bg-zinc-950` dark background (terminal feel, not literal terminal)
- Proportional font for prose and labels
- Monospace font only for expanded code/JSON blocks
- Relative timestamps on row hover, absolute on tooltip
- Spinner while fetching historical events; static view if session already ended

## Files to Create / Modify

| File | Change |
|------|--------|
| `apps/daemon/src/server/routes/sessions.routes.ts` | Add `GET /api/sessions/:sessionId/log` endpoint |
| `apps/frontend/src/routes/sessions/$sessionId.tsx` | New page component |
| `apps/frontend/src/routeTree.gen.ts` | Updated by TanStack Router codegen |
| `apps/frontend/src/components/ticket-detail/ViewSessionButton.tsx` | Replaces `RemoteControlButton.tsx` |
| `apps/frontend/src/components/ticket-detail/ActivityTab.tsx` | Swap RC button for View Session button |
| `apps/frontend/src/api/client.ts` | Add `getSessionLog(sessionId)` |
| `apps/daemon/src/server/routes/sessions.routes.ts` | Remove RC start/get endpoints (or leave for now) |

## Out of Scope

- Remote control / claude.ai handoff (removed entirely)
- Editing or replying to the session from the transcript view
- Persisting transcript view state across page reloads (SSE reconnect re-fetches from log)
