# Daemon Log Visibility & Error Surfacing Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Wire the existing Logs UI to real daemon log data, surface ticket-blocked errors in the Activity feed, and fix the stale-session bug that silently prevents Build from executing.

**Architecture:** The daemon's `Logger` class already intercepts all `console.log/warn/error` calls — we extend it to also emit `log:entry` SSE events so the existing `LogsView` gets live data. A new REST endpoint serves historical log lines parsed from `daemon.log` so the view is populated on mount. Blocked ticket errors are written as `error` conversation messages so they appear in `ActivityTab`. Stale sessions from previous daemon runs are ended at startup before recovery runs.

**Tech Stack:** TypeScript, Express, Node fs, React 19, TanStack Query, SSE (existing eventBus)

**Key Decisions:**
- **Log SSE wiring:** Patch `Logger` to emit `log:entry` rather than adding a new log-shipping layer — Logger already intercepts console, zero duplication.
- **Historical logs via REST not SSE replay:** Emit historical lines on new SSE connection is complex and order-sensitive; a simple `GET /api/system/logs?lines=500` REST call on mount is simpler and already fits TanStack Query patterns.
- **Blocked error → conversation message:** Rather than a new event type, write an `error` `ConversationMessage` via the existing `addMessage()` store function — ActivityTab already renders `type: 'error'` bubbles.
- **Stale session fix:** End all open DB sessions at daemon startup (before recovery) — avoids a per-request in-memory check and is the correct behaviour: if the daemon restarted, no previous PTY is alive.
- **Log format parsing:** The daemon.log format is `[ISO] [LEVEL] message\n` — parse with a simple regex, no extra library needed.

---

## Task 1: End stale DB sessions at daemon startup

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/session.store.ts`
- Modify: `apps/daemon/src/server/server.ts`

**Purpose:** When the daemon restarts, sessions from the previous run are still marked active in SQLite. `getActiveSessionForTicket()` finds them and skips spawning. Ending them at startup clears the stale state so recovery + user-triggered moves work correctly.

**Not In Scope:** Killing actual PTY processes (they're already dead if the daemon restarted).

**Gotchas:** The `endStaleSessions` call must happen *before* the recovery spawn loop in `server.ts`; otherwise recovery sees stale sessions and skips tickets.

**Step 1: Add `endAllOpenSessions()` to session store**

The codebase uses a factory pattern: each store has a class with methods, plus top-level singleton convenience exports. Add the method to `SessionStore` and export a top-level convenience function.

In `apps/daemon/src/stores/session.store.ts`, inside the `SessionStore` class add:

```typescript
/**
 * End all sessions that have no ended_at (stale from a previous daemon run).
 * Call at daemon startup before recovery.
 */
endAllOpenSessions(): number {
  const result = this.db
    .prepare(
      `UPDATE sessions SET ended_at = ?, exit_code = -1 WHERE ended_at IS NULL`
    )
    .run(new Date().toISOString());
  return result.changes;
}
```

After the class definition, add the top-level convenience export (matching the pattern used by other convenience functions in the file — each instantiates `new SessionStore(getDatabase())` directly; there is no `getSessionStore()` singleton):

```typescript
export function endAllOpenSessions(): number {
  return new SessionStore(getDatabase()).endAllOpenSessions();
}
```

**Step 2: Write test to verify it ends open sessions**

In `apps/daemon/src/stores/__tests__/session.store.test.ts` (add inside the existing `describe('SessionStore', ...)` block, using the existing `sessionStore` and `ticketStore` variables — look at how other tests call `sessionStore.createSession()`):

```typescript
it('endAllOpenSessions marks open sessions as ended', () => {
  // Create a ticket first (sessions require a valid ticketId FK)
  const ticket = ticketStore.createTicket(projectId, { title: 'T-stale' });
  sessionStore.createSession({ ticketId: ticket.id, projectId });
  assert.notEqual(sessionStore.getActiveSessionForTicket(ticket.id), null);
  const count = sessionStore.endAllOpenSessions();
  assert.ok(count >= 1);
  assert.equal(sessionStore.getActiveSessionForTicket(ticket.id), null);
});
```

Run: `cd apps/daemon && pnpm test`
Expected: new test passes.

**Step 3: Call `endAllOpenSessions()` in `server.ts` startup**

In `apps/daemon/src/server/server.ts`, find the recovery block — look for the first `for` loop that iterates over pending/processing tickets to re-spawn them (search for `getActiveSessionForTicket`). Add the import at the top with the other store imports, then add before that loop:

```typescript
import { endAllOpenSessions } from '../stores/session.store.js';

// Clear sessions from previous daemon run before recovery
const staleSessions = endAllOpenSessions();
if (staleSessions > 0) {
  console.log(`[startup] Cleared ${staleSessions} stale session(s) from previous run`);
}
```

**Step 4: Commit**

```bash
git add apps/daemon/src/stores/session.store.ts apps/daemon/src/server/server.ts apps/daemon/src/stores/__tests__/session.store.test.ts
git commit -m "fix: end stale DB sessions at daemon startup to unblock ticket spawning"
```

---

## Task 2: Emit `ticket:message` error when a ticket is blocked

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/types/conversation.types.ts`
- Modify: `packages/shared/src/types/conversation.types.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts:1077-1100`

**Purpose:** When P4 validation fails (or any other block condition), the ticket moves to Blocked but the user sees nothing in the Activity feed. Writing an `error` conversation message makes it visible immediately.

**Gotchas:** There are two type locations to fix: (1) `apps/daemon/src/types/conversation.types.ts` defines the daemon-local `ConversationMessage` used by `addMessage()`; (2) `packages/shared/src/types/conversation.types.ts` defines `TicketMessage` returned by the REST API — the frontend `ActivityTab` already renders `type: 'error'` with a red destructive style but TypeScript strict mode will error without the shared type updated too. `CreateMessageInput.type` derives from `ConversationMessage["type"]` automatically. Run `pnpm build:shared` after editing shared types. The ticket's `conversationId` must be looked up from the ticket record. `addMessage` from `conversation.store.ts` is already imported elsewhere in session.service.ts.

**Step 1: Extend `ConversationMessage.type` in daemon-local types**

In `apps/daemon/src/types/conversation.types.ts`, change the `type` field of `ConversationMessage` from:

```typescript
type: 'question' | 'user' | 'notification' | 'artifact'
```

to:

```typescript
type: 'question' | 'user' | 'notification' | 'artifact' | 'error'
```

**Step 1b: Extend `TicketMessage.type` in shared types**

In `packages/shared/src/types/conversation.types.ts`, change the `type` field of `TicketMessage` from:

```typescript
type: 'question' | 'user' | 'notification' | 'artifact'
```

to:

```typescript
type: 'question' | 'user' | 'notification' | 'artifact' | 'error'
```

Then run: `pnpm build:shared`

**Step 2: Add error message in `handleTicketBlocked`**

In `apps/daemon/src/services/session/session.service.ts`, find `handleTicketBlocked` (around line 1077). After the `updateTicket` call and before the SSE emits, add:

```typescript
// Write error to conversation so it appears in Activity feed
try {
  const { addMessage } = await import('../../stores/conversation.store.js');
  const ticket = getTicket(projectId, ticketId);
  if (ticket?.conversationId) {
    addMessage(ticket.conversationId, {
      type: 'error',
      text: reason,
    });
    eventBus.emit('ticket:message', {
      projectId,
      ticketId,
      message: { type: 'error', text: reason },
    });
  }
} catch (err) {
  console.error(`[handleTicketBlocked] Failed to write error message: ${(err as Error).message}`);
}
```

**Step 3: Verify manually**

Restart the daemon, move JCI-1 to Build. The Activity tab should now show a red error bubble with the block reason. (No automated test for SSE emission — covered by manual verification.)

**Step 4: Commit**

```bash
git add apps/daemon/src/types/conversation.types.ts packages/shared/src/types/conversation.types.ts apps/daemon/src/services/session/session.service.ts
git commit -m "feat: surface ticket-blocked reason as error message in Activity feed"
```

---

## Task 3: Emit `log:entry` SSE events from Logger

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/utils/logger.ts`

**Purpose:** The `LogsView` frontend already listens to `log:entry` SSE events but the daemon never emits them. Patching `Logger` to emit via `eventBus` makes the live view work with zero frontend changes.

**Gotchas:** `logger.ts` and `event-bus.ts` live in the same `utils/` directory with no circular dependency — use a static top-level import. No dynamic import needed.

**Step 1: Patch `Logger` to also emit SSE**

At the top of `apps/daemon/src/utils/logger.ts`, add a static import alongside the existing imports:

```typescript
import { eventBus } from './event-bus.js';
```

Replace `write()` in `apps/daemon/src/utils/logger.ts`:

```typescript
private write(msg: string, level: 'INFO' | 'WARN' | 'ERROR', rawArgs: unknown[]): void {
  if (this.stream) {
    this.stream.write(msg);
    this.checkRotation();
  }
  // Emit live log entry for frontend log viewer (best-effort, no throw)
  try {
    const message = rawArgs
      .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ');
    eventBus.emit('log:entry', {
      level: level.toLowerCase(),
      message,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // ignore
  }
}
```

Update `init()` to pass `level` and `rawArgs` through to `write()`:

```typescript
console.log = (...args: unknown[]): void => {
  const msg = this.format('INFO', args);
  this.write(msg, 'INFO', args);
  originalLog.apply(console, args);
};
console.warn = (...args: unknown[]): void => {
  const msg = this.format('WARN', args);
  this.write(msg, 'WARN', args);
  originalWarn.apply(console, args);
};
console.error = (...args: unknown[]): void => {
  const msg = this.format('ERROR', args);
  this.write(msg, 'ERROR', args);
  originalError.apply(console, args);
};
```

**Step 2: Smoke-test**

Start daemon (`pnpm dev:daemon`), open `/logs` in the browser, move a ticket — log entries should appear live in the Logs view.

**Step 3: Commit**

```bash
git add apps/daemon/src/utils/logger.ts
git commit -m "feat: emit log:entry SSE events from Logger for live log viewer"
```

---

## Task 4: Add `GET /api/system/logs` endpoint for historical log entries

**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/server/routes/system.routes.ts`
- Modify: `apps/daemon/src/server/server.ts`

**Purpose:** The LogsView starts empty on mount — historical entries from `daemon.log` need to be loadable via REST so the view is useful immediately. Parses the last N lines of the log file.

**Not In Scope:** Streaming / tailing the log file (SSE handles live updates). Log rotation (`daemon.log.1`, etc.) — only current file.

**Gotchas:** The log format is `[ISO_TIMESTAMP] [LEVEL] message`. Lines that don't match the regex are returned as `debug` level with the raw content.

**Step 1: Create `system.routes.ts`**

```typescript
// apps/daemon/src/server/routes/system.routes.ts
import { Router } from 'express';
import fs from 'fs/promises';
import { LOG_FILE } from '../../config/paths.js';

export function registerSystemRoutes(app: ReturnType<typeof import('express').default>): void {
  const router = Router();

  /**
   * GET /api/system/logs?lines=500
   * Returns the last N lines of daemon.log as parsed LogEntry objects.
   */
  router.get('/logs', async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.lines ?? '500'), 10) || 500, 2000);
    try {
      const raw = await fs.readFile(LOG_FILE, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-limit);

      const LOG_LINE_RE = /^\[([^\]]+)\] \[(INFO|WARN|ERROR|DEBUG)\] (.+)$/;
      const entries = tail.map((line) => {
        const match = LOG_LINE_RE.exec(line);
        if (match) {
          return { timestamp: match[1], level: match[2].toLowerCase(), message: match[3] };
        }
        return { timestamp: new Date().toISOString(), level: 'debug', message: line };
      });

      res.json({ entries });
    } catch {
      // Log file doesn't exist yet
      res.json({ entries: [] });
    }
  });

  app.use('/api/system', router);
}
```

**Step 2: Register in `server.ts`**

In `apps/daemon/src/server/server.ts`, add after `registerFolderRoutes(app)`:

```typescript
import { registerSystemRoutes } from './routes/system.routes.js';
// ...
registerSystemRoutes(app);
```

**Step 3: Test endpoint**

```bash
curl http://localhost:8443/api/system/logs?lines=20
```

Expected: JSON with `{ entries: [...] }` array.

**Step 4: Commit**

```bash
git add apps/daemon/src/server/routes/system.routes.ts apps/daemon/src/server/server.ts
git commit -m "feat: add GET /api/system/logs endpoint for historical daemon log entries"
```

---

## Task 5: Load historical log entries in LogsView on mount

**Depends on:** Task 4
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/components/logs/LogsView.tsx`

**Purpose:** Wire the existing `LogsView` to the new REST endpoint so it shows the last 500 log entries on page load, then continues with live SSE entries.

**Gotchas:** Historical entries must be prepended before live entries. Dedup by timestamp is unnecessary (live SSE won't replay past entries). Keep the existing `MAX_ENTRIES` cap.

**Step 1: Add API client function**

In `apps/frontend/src/api/client.ts`, add inside the `api` object literal (the file uses a plain object `export const api = { ... }` with a module-level `request<T>()` function, not a class):

```typescript
async getSystemLogs(lines = 500): Promise<LogEntry[]> {
  return request<{ entries: LogEntry[] }>(`/api/system/logs?lines=${lines}`).then((d) => d.entries);
},
```

Also add `LogEntry` to the existing `@potato-cannon/shared` import at the top of the file (it is not currently imported there — `SessionLogEntry` is, so add `LogEntry` alongside it).

**Step 2: Load on mount in `LogsView`**

In `apps/frontend/src/components/logs/LogsView.tsx`, change the initial state and add a fetch effect:

```typescript
// Change initial state from hardcoded entry to empty
const [entries, setEntries] = useState<LogEntry[]>([])

// Add after existing state declarations:
useEffect(() => {
  api.getSystemLogs(500).then((historical) => {
    setEntries(historical)
  }).catch(() => {
    // Daemon may not have log file yet — start empty
  })
}, [])
```

Remove the hardcoded `{ level: 'info', message: 'Dashboard started', ... }` initial state value.

**Step 3: Verify**

Open `/logs`, refresh the page — should see ~500 historical entries immediately, then new entries stream in via SSE.

**Step 4: Commit**

```bash
git add apps/frontend/src/api/client.ts apps/frontend/src/components/logs/LogsView.tsx
git commit -m "feat: populate LogsView with historical daemon log entries on mount"
```

---

## Summary

| Task | Feature | Risk | Est. |
|------|---------|------|------|
| 1 | Fix stale session (JCI-1 bug) | Low | 20 min |
| 2 | Blocked error → Activity feed | Low | 15 min |
| 3 | Logger → SSE live log events | Low | 20 min |
| 4 | REST endpoint for historical logs | Low | 25 min |
| 5 | LogsView historical load on mount | Low | 15 min |

Tasks 1–4 are independent and can be executed in parallel. Task 5 depends on Task 4 (requires the REST endpoint to exist).

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | PASS | All 3 requirements addressed across 5 tasks |
| Accurate | PASS | All file paths verified; type file corrections applied |
| Commands valid | PASS | `pnpm test` and `pnpm build:shared` verified |
| YAGNI | PASS | Every task directly serves a stated requirement |
| Minimal | PASS | No tasks combinable without losing clarity |
| Not over-engineered | PASS | Simplest viable approach for each task |
| Key Decisions documented | PASS | 4 decisions with rationale in header |
| Context sections present | PASS | Purpose/Gotchas on all tasks |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | PASS (after fixes) | Fixed test harness pattern, broken ESM import type, internal contradiction in Task 3, summary parallelism claim | Shape and structure sound |
| Feasibility | PASS (after fixes) | Fixed getSessionStore() → new SessionStore(), 'error' type extension scope, relative import path, this.fetch → request<>() | All steps executable |
| Completeness | PASS (after fixes) | Added daemon-local type file target, shared TicketMessage type extension, pnpm build:shared note | All requirements traced |
| Risk | PASS | No changes needed | No blocking risks identified |
| Optimality | PASS (after fix) | Replaced dynamic import in Task 3 with static import (no circular dep) | Simplest valid approach |
