# Remote Control Session Feature Design

**Date:** 2026-03-09
**Status:** Draft

## Overview

Add the ability to peer into and interact with a running ticket's Claude session via Claude's built-in `/remote-control` feature. A button in the ticket details panel injects the `/remote-control` command into the active PTY session, captures the resulting session URL, and displays it as a persistent clickable link.

## Goals

- Observe a running Claude session from any browser
- Intervene when needed without breaking the autonomous workflow
- Keep the implementation simple given the current instability of the remote-control feature

## Non-Goals

- A "Stop" remote-control button (removed for simplicity; rely on natural session termination)
- Embedding a terminal emulator in the UI
- Auto-starting remote-control on every session

---

## Data Flow

```
User clicks "Start Remote Control"
  → POST /api/tickets/:ticketId/remote-control/start
  → Daemon writes "/remote-control <ticket-title>\n" to PTY stdin
  → PTY output listener scans for URL: https://claude.ai/code/[^\s]+
  → URL stored on session record
  → SSE event "remote-control-url" emitted to frontend
  → Frontend renders persistent "Open in Claude.ai →" link

Session ends (PTY exits)
  → URL cleared from session record
  → SSE event "remote-control-cleared" emitted
  → Frontend resets to enabled button state
```

---

## Backend

### New API Endpoint

**`POST /api/tickets/:ticketId/remote-control/start`**

- Looks up the active session for the ticket
- Returns 409 if no active session exists
- Writes `/remote-control <ticket-title>\n` to PTY stdin
- Sets `remote_control_pending = true` on the session record
- Returns `{ status: "pending" }`

The URL is not returned synchronously — it arrives via SSE once captured from PTY output.

### PTY Output Parsing

The existing PTY output listener in `session.service.ts` is extended to:

1. When `remote_control_pending` is true, scan each output chunk for a URL matching `https://claude\.ai/code/[^\s]+`
2. On match: store URL as `remote_control_url` on the session record, clear `remote_control_pending`, emit SSE event
3. On PTY exit: clear `remote_control_url`, emit `remote-control-cleared` SSE event

### Database

Add two columns to the `sessions` table (new migration):

```sql
ALTER TABLE sessions ADD COLUMN remote_control_url TEXT;
ALTER TABLE sessions ADD COLUMN remote_control_pending INTEGER NOT NULL DEFAULT 0;
```

---

## Frontend

### Button State Machine

```
no active session   → button disabled, greyed out
active session      → button enabled ("Start Remote Control")
pending URL         → button disabled + spinner ("Connecting…")
URL captured        → "Open in Claude.ai →" link (opens new tab)
session ends        → returns to "no active session" state
```

### UI Placement

In the ticket details panel, add a "Remote Control" row. The button/link is always visible; its state reflects the session lifecycle above.

Once the URL is captured, the link persists for the entire session so the user can copy or re-open it at any time.

### SSE Events

| Event | Payload | Action |
|-------|---------|--------|
| `remote-control-url` | `{ sessionId, url }` | Show link |
| `remote-control-cleared` | `{ sessionId }` | Reset to button |

---

## Key Considerations

- **Timing:** Claude only reads stdin between tool calls. The URL may take several seconds to appear if Claude is mid-execution. The "Connecting…" state covers this.
- **Instability:** The remote-control feature is under active development. The URL auto-clears on session end which handles most failure modes gracefully.
- **One RC per session:** Claude only supports one remote connection at a time. Clicking "Start Remote Control" a second time while one is already active would inject another `/remote-control` command, which presents an interactive disconnect prompt — the button should be hidden/disabled once a URL is active to prevent this.
