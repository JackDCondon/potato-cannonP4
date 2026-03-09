# Remote Control Session Feature — Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Add a "Start Remote Control" button to the ticket details panel that injects `/remote-control` into the running Claude PTY session and surfaces the resulting session URL as a clickable link.

**Architecture:** In-memory state (`Map<sessionId, RemoteControlState>`) on `SessionService` tracks pending/active RC state for live sessions. URL is extracted by scanning raw PTY output with an ANSI-stripped regex. SSE broadcasts `session:remote-control-url` and `session:remote-control-cleared` events to the frontend, which uses a `useRemoteControl` hook to drive button state.

**Tech Stack:** TypeScript, Express, node-pty, EventBus (SSE), React 19, TanStack Query, Zustand, Lucide icons

**Key Decisions:**
- **In-memory vs DB for RC state:** In-memory Map on SessionService — RC state is tied to a live PTY process; storing in DB would require a migration and cleanup logic for stale state on daemon restart. When the daemon restarts, the PTY is gone and the URL is invalid anyway.
- **No "Stop RC" button:** Removed for simplicity per design decision. The second `/remote-control` invocation opens an interactive menu; we cannot reliably automate disconnect from the daemon side.
- **URL placement in UI:** ActivityTab (not DetailsTab) — this is where session lifecycle is already surfaced; it's the natural home for RC state.
- **ANSI stripping before URL match:** PTY output contains terminal escape codes. The URL regex must run on ANSI-stripped text to reliably match `https://claude.ai/code/...`.
- **SSE pattern:** Follow existing `window.dispatchEvent(new CustomEvent(...))` pattern used by `session:output`, `session:ended` — single EventSource connection in `useSSE.ts`, local hooks subscribe to window events.

---

## Task 1: Add remote control state to SessionService

**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/services/session/types.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** SessionService needs in-memory tracking of which sessions have RC active, plus public methods to start RC and query state.

**Step 1: Write the failing tests**

Add to `apps/daemon/src/services/session/__tests__/session.service.test.ts`:

```typescript
describe("SessionService.startRemoteControl", () => {
  let service: SessionService;
  let eventEmitter: EventEmitter;

  beforeEach(() => {
    eventEmitter = new EventEmitter();
    service = new SessionService(eventEmitter);
  });

  it("should set pending state when session exists in memory", () => {
    const sessions = (service as any).sessions as Map<string, any>;
    const rcState = (service as any).remoteControlState as Map<string, any>;

    const written: string[] = [];
    const mockProcess = {
      kill: () => {},
      write: (data: string) => written.push(data),
    };

    sessions.set("sess_1", { process: mockProcess, meta: { ticketId: "POT-1" } });

    service.startRemoteControl("sess_1", "My Ticket");

    assert.strictEqual(rcState.get("sess_1")?.pending, true);
    assert.strictEqual(rcState.get("sess_1")?.url, undefined);
    assert.ok(written[0].includes("/remote-control"));
    assert.ok(written[0].includes("My Ticket"));
  });

  it("should return null for getRemoteControlState when session has no RC", () => {
    const result = service.getRemoteControlState("sess_nonexistent");
    assert.strictEqual(result, null);
  });

  it("should return state when session has RC pending", () => {
    const sessions = (service as any).sessions as Map<string, any>;
    const rcState = (service as any).remoteControlState as Map<string, any>;

    sessions.set("sess_2", { process: { kill: () => {}, write: () => {} }, meta: {} });
    rcState.set("sess_2", { pending: true, url: undefined });

    const result = service.getRemoteControlState("sess_2");
    assert.deepStrictEqual(result, { pending: true, url: undefined });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd C:/Users/jackd/.config/superpowers/worktrees/potato-cannonP4/feat-remote-control
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/daemon build && node --experimental-test-module-mocks --test dist/services/session/__tests__/session.service.test.js 2>&1 | grep -E "✓|✖|FAIL|PASS"
```

Expected: FAIL (methods don't exist yet)

**Step 3: Implement**

In `apps/daemon/src/services/session/types.ts`, add:

```typescript
export interface RemoteControlState {
  pending: boolean;
  url?: string;
}
```

In `apps/daemon/src/services/session/session.service.ts`:

1. Add private field after `private sessions`:
```typescript
private remoteControlState: Map<string, RemoteControlState> = new Map();
```

2. Add public methods (after `stopSession`):
```typescript
startRemoteControl(sessionId: string, ticketTitle: string): boolean {
  const session = this.sessions.get(sessionId);
  if (!session) return false;

  // Double-click guard: don't re-inject if RC is already pending or active
  const existing = this.remoteControlState.get(sessionId);
  if (existing?.pending || existing?.url) return false;

  this.remoteControlState.set(sessionId, { pending: true });
  // Sanitize title: strip quotes and newlines, truncate to 50 chars
  const safeName = ticketTitle.replace(/["\n\r]/g, " ").slice(0, 50);
  session.process.write(`/remote-control "${safeName}"\r`);
  return true;
}

getRemoteControlState(sessionId: string): RemoteControlState | null {
  return this.remoteControlState.get(sessionId) ?? null;
}
```

3. In the existing `proc.onData` handler inside `spawnClaudeSession`, add URL scanning **before** the per-line loop (on the raw `data` buffer so it catches plain terminal text, not just JSON-parsed lines):

```typescript
proc.onData((data: string) => {
  // Scan for remote-control URL in raw PTY output (BEFORE per-line loop)
  if (this.remoteControlState.get(sessionId)?.pending) {
    const stripped = data.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
    const match = stripped.match(/https:\/\/claude\.ai\/code\/[^\s]{1,150}/);
    if (match) {
      const url = match[0];
      this.remoteControlState.set(sessionId, { pending: false, url });
      eventBus.emit("session:remote-control-url", {
        sessionId,
        ticketId: meta.ticketId,
        projectId: meta.projectId,
        url,
      });
    }
  }

  const lines = data.split("\n").filter(Boolean);
  // ... rest of existing per-line loop unchanged
```

**Important:** The URL scanner runs on the full `data` chunk before the `split("\n")` line. The `/remote-control` command outputs plain terminal text (not JSON), which lands in the `catch` branch of the per-line loop — it would be missed if the scanner were placed inside the try/catch. Placing it before the loop ensures it sees all PTY output. The regex quantifier `{1,150}` caps matched URL length to avoid garbage matches.

4. In the PTY `onExit` handler (where `exitResolver` is called), add cleanup:
```typescript
this.remoteControlState.delete(sessionId);
```

**Step 4: Run test to verify it passes**

```bash
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/daemon build && node --experimental-test-module-mocks --test dist/services/session/__tests__/session.service.test.js 2>&1 | grep -E "✓|✖|FAIL|PASS"
```

Expected: PASS (new tests pass, existing tests still pass)

**Step 5: Commit**

```bash
cd C:/Users/jackd/.config/superpowers/worktrees/potato-cannonP4/feat-remote-control
git add apps/daemon/src/services/session/session.service.ts apps/daemon/src/services/session/types.ts apps/daemon/src/services/session/__tests__/session.service.test.ts
git commit -m "feat: add startRemoteControl and URL scanning to SessionService"
```

---

## Task 2: Add remote-control event types to EventBus

**Depends on:** Task 1
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/utils/event-bus.ts`

**Purpose:** The `EventName` type and `forwardEvents` array gate all SSE broadcasts. RC events must be added here to reach the frontend.

**Not In Scope:** No new broadcast logic needed — adding to `forwardEvents` is sufficient.

**Step 1: Write the failing test**

There are no unit tests for event-bus.ts (it's a singleton). Verify via integration: the TypeScript compiler will error if we reference an unknown `EventName` in Task 1's `eventBus.emit(...)` call. Run typecheck as the "test":

```bash
cd C:/Users/jackd/.config/superpowers/worktrees/potato-cannonP4/feat-remote-control
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/daemon typecheck 2>&1 | grep "remote-control"
```

Expected: TypeScript error about unknown event name (after Task 1 adds the emit call)

**Step 2: Implement**

In `apps/daemon/src/utils/event-bus.ts`:

1. Add to `EventName` type:
```typescript
| "session:remote-control-url"
| "session:remote-control-cleared"
```

2. Add to `forwardEvents` array:
```typescript
"session:remote-control-url",
"session:remote-control-cleared",
```

**Step 3: Verify typecheck passes**

```bash
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/daemon typecheck 2>&1 | tail -5
```

Expected: No errors

**Step 4: Commit**

```bash
git add apps/daemon/src/utils/event-bus.ts
git commit -m "feat: add session:remote-control-url/cleared event types to EventBus"
```

---

## Task 3: Add API endpoints for remote control

**Depends on:** Task 1, Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/routes/sessions.routes.ts`

**Purpose:** Expose HTTP endpoints so the frontend can trigger RC start and query current RC state.

**Not In Scope:** No authentication — daemon is local-only.

**Gotchas:** The session must be active (in `sessionService.sessions` map) to write to PTY stdin. If the session exists in DB but not in memory (e.g., daemon restarted mid-session), `startRemoteControl` returns false — return 409.

**Step 1: Write the failing test**

No route-level test file exists for sessions routes. Add manually to verify via curl after implementation. Skip automated test for this task (routes are integration-tested by running the daemon).

**Step 2: Implement**

First, add a top-level import at the top of `apps/daemon/src/server/routes/sessions.routes.ts` (if not already present):

```typescript
import { getActiveSessionForTicket } from '../../stores/session.store.js';
```

Then add two routes inside `registerSessionRoutes` before the closing brace:

```typescript
// Get remote control state for a ticket
app.get('/api/tickets/:projectId/:ticketId/remote-control', (req: Request, res: Response) => {
  const { ticketId } = req.params;

  const activeSession = getActiveSessionForTicket(ticketId);
  if (!activeSession) {
    return res.json({ pending: false, url: null });
  }

  const state = sessionService.getRemoteControlState(activeSession.id);
  res.json({
    sessionId: activeSession.id,
    pending: state?.pending ?? false,
    url: state?.url ?? null,
  });
});

// Start remote control for a ticket's active session
app.post('/api/tickets/:projectId/:ticketId/remote-control/start', async (req: Request, res: Response) => {
  const { ticketId } = req.params;
  const { ticketTitle } = req.body as { ticketTitle?: string };

  const activeSession = getActiveSessionForTicket(ticketId);
  if (!activeSession) {
    return res.status(409).json({ error: 'No active session for this ticket' });
  }

  const started = sessionService.startRemoteControl(activeSession.id, ticketTitle ?? ticketId);
  if (!started) {
    // startRemoteControl returns false if session not in memory OR if RC already active
    return res.status(409).json({ error: 'Cannot start remote control — session not running or RC already active' });
  }

  res.json({ ok: true, sessionId: activeSession.id });
});
```

**Step 3: Build and smoke test**

```bash
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/daemon build 2>&1 | tail -5
```

Expected: No errors

**Step 4: Commit**

```bash
git add apps/daemon/src/server/routes/sessions.routes.ts
git commit -m "feat: add GET/POST remote-control endpoints for tickets"
```

---

## Task 4: Add frontend API client methods

**Depends on:** Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/api/client.ts`

**Purpose:** Frontend needs typed API methods to call the two new endpoints.

**Step 1: Implement**

In `apps/frontend/src/api/client.ts`, add to the `api` object (e.g., near session methods):

```typescript
// ============ Remote Control ============

getRemoteControl: (projectId: string, ticketId: string) =>
  request<{ sessionId?: string; pending: boolean; url: string | null }>(
    `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/remote-control`
  ),

startRemoteControl: (projectId: string, ticketId: string, ticketTitle: string) =>
  request<{ ok: boolean; sessionId: string }>(
    `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/remote-control/start`,
    {
      method: 'POST',
      body: JSON.stringify({ ticketTitle }),
    }
  ),
```

**Step 2: Typecheck**

```bash
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/frontend typecheck 2>&1 | tail -5
```

Expected: No errors

**Step 3: Commit**

```bash
git add apps/frontend/src/api/client.ts
git commit -m "feat: add getRemoteControl and startRemoteControl API client methods"
```

---

## Task 5: Wire SSE events and add useRemoteControl hook

**Depends on:** Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/hooks/useSSE.ts`

**Purpose:** Add SSE event handling for `session:remote-control-url` and `session:remote-control-cleared`, plus a hook components can use to react to RC state changes.

**Step 1: Write the failing test**

The `useSSE.ts` hooks don't have unit tests (they use `window.addEventListener`). The TypeScript type additions serve as compile-time verification. Run typecheck as the gate.

**Step 2: Implement**

In `apps/frontend/src/hooks/useSSE.ts`:

1. Add to `SSEEventType`:
```typescript
| 'session:remote-control-url'
| 'session:remote-control-cleared'
```

2. In the `onopen` handler inside `connect()`, after the existing reconnect delay reset, add:
```typescript
// Notify RC components to re-fetch state (recovers from SSE dropout during RC startup)
window.dispatchEvent(new CustomEvent('sse:reconnected'))
```

3. Inside the `connect()` function (after existing event listeners), add:
```typescript
eventSource.addEventListener('session:remote-control-url', (e) => {
  try {
    const data = JSON.parse(e.data) as SSEEventData
    window.dispatchEvent(new CustomEvent('sse:remote-control-url', { detail: data }))
  } catch {
    // Ignore parse errors
  }
})

eventSource.addEventListener('session:remote-control-cleared', (e) => {
  try {
    const data = JSON.parse(e.data) as SSEEventData
    window.dispatchEvent(new CustomEvent('sse:remote-control-cleared', { detail: data }))
  } catch {
    // Ignore parse errors
  }
})
```

3. Add hook at the bottom of the file:
```typescript
// Hook for subscribing to remote control URL events
export function useRemoteControlSSE(
  ticketId: string | undefined,
  onUrl: (url: string) => void,
  onCleared: () => void,
) {
  useEffect(() => {
    if (!ticketId) return

    const urlHandler = (e: CustomEvent<SSEEventData>) => {
      const data = e.detail as { ticketId?: string; url?: string }
      if (data.ticketId === ticketId && data.url) {
        onUrl(data.url)
      }
    }

    const clearedHandler = (e: CustomEvent<SSEEventData>) => {
      const data = e.detail as { ticketId?: string }
      if (data.ticketId === ticketId) {
        onCleared()
      }
    }

    window.addEventListener('sse:remote-control-url', urlHandler as EventListener)
    window.addEventListener('sse:remote-control-cleared', clearedHandler as EventListener)
    return () => {
      window.removeEventListener('sse:remote-control-url', urlHandler as EventListener)
      window.removeEventListener('sse:remote-control-cleared', clearedHandler as EventListener)
    }
  }, [ticketId, onUrl, onCleared])
}
```

**Step 3: Typecheck**

```bash
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/frontend typecheck 2>&1 | tail -5
```

Expected: No errors

**Step 4: Commit**

```bash
git add apps/frontend/src/hooks/useSSE.ts
git commit -m "feat: add remote-control SSE event handling and useRemoteControlSSE hook"
```

---

## Task 6: Create RemoteControlButton component and wire into ActivityTab

**Depends on:** Task 5
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/components/ticket-detail/RemoteControlButton.tsx`
- Modify: `apps/frontend/src/components/ticket-detail/ActivityTab.tsx`

**Purpose:** The visible UI — button in ActivityTab that drives the full state machine.

**Not In Scope:** Stop button, mobile layout changes beyond what Tailwind provides automatically.

**Gotchas:**
- `useRemoteControlSSE` callbacks must be wrapped in `useCallback` to prevent infinite re-renders.
- On mount, fetch initial RC state via `api.getRemoteControl()` — needed if user opens the panel after RC was already started.
- The button should be hidden (not just disabled) when `ticket.archived` is true.

**Step 1: Write the failing test**

Frontend tests use Vitest. There are no existing tests for `ActivityTab`. Add a minimal smoke test for the new component:

Create `apps/frontend/src/components/ticket-detail/RemoteControlButton.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RemoteControlButton } from './RemoteControlButton'

vi.mock('@/api/client', () => ({
  api: {
    getRemoteControl: vi.fn().mockResolvedValue({ pending: false, url: null }),
    startRemoteControl: vi.fn().mockResolvedValue({ ok: true, sessionId: 'sess_1' }),
  },
}))

vi.mock('@/hooks/useSSE', () => ({
  useRemoteControlSSE: vi.fn(),
}))

describe('RemoteControlButton', () => {
  it('renders disabled when no active session', () => {
    render(
      <RemoteControlButton
        projectId="proj_1"
        ticketId="POT-1"
        ticketTitle="My Ticket"
        hasActiveSession={false}
      />
    )
    const btn = screen.getByRole('button', { name: /remote control/i })
    expect(btn).toBeDisabled()
  })

  it('renders enabled when active session exists', () => {
    render(
      <RemoteControlButton
        projectId="proj_1"
        ticketId="POT-1"
        ticketTitle="My Ticket"
        hasActiveSession={true}
      />
    )
    const btn = screen.getByRole('button', { name: /start remote control/i })
    expect(btn).not.toBeDisabled()
  })
})
```

**Step 2: Run test to verify it fails**

```bash
cd C:/Users/jackd/.config/superpowers/worktrees/potato-cannonP4/feat-remote-control
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/frontend test -- --run RemoteControlButton 2>&1 | tail -10
```

Expected: FAIL (component doesn't exist)

**Step 3: Implement the component**

Create `apps/frontend/src/components/ticket-detail/RemoteControlButton.tsx`:

```typescript
import { useState, useEffect, useCallback } from 'react'
import { Monitor, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/api/client'
import { useRemoteControlSSE } from '@/hooks/useSSE'
import { cn } from '@/lib/utils'

interface RemoteControlButtonProps {
  projectId: string
  ticketId: string
  ticketTitle: string
  hasActiveSession: boolean
}

type RCState = 'idle' | 'pending' | 'active'

export function RemoteControlButton({
  projectId,
  ticketId,
  ticketTitle,
  hasActiveSession,
}: RemoteControlButtonProps) {
  const [state, setState] = useState<RCState>('idle')
  const [url, setUrl] = useState<string | null>(null)

  // Fetch initial state on mount (in case RC was started before panel opened)
  useEffect(() => {
    if (!hasActiveSession) {
      setState('idle')
      setUrl(null)
      return
    }
    api.getRemoteControl(projectId, ticketId).then((data) => {
      if (data.url) {
        setUrl(data.url)
        setState('active')
      } else if (data.pending) {
        setState('pending')
      }
    }).catch(() => {})
  }, [projectId, ticketId, hasActiveSession])

  const handleUrl = useCallback((newUrl: string) => {
    setUrl(newUrl)
    setState('active')
  }, [])

  const handleCleared = useCallback(() => {
    setUrl(null)
    setState('idle')
  }, [])

  useRemoteControlSSE(ticketId, handleUrl, handleCleared)

  // Re-fetch RC state on SSE reconnect (recovers from dropout during RC startup)
  useEffect(() => {
    if (!hasActiveSession) return
    const onReconnect = () => {
      api.getRemoteControl(projectId, ticketId).then((data) => {
        if (data.url) { setUrl(data.url); setState('active') }
        else if (data.pending) { setState('pending') }
        else { setState('idle'); setUrl(null) }
      }).catch(() => {})
    }
    window.addEventListener('sse:reconnected', onReconnect)
    return () => window.removeEventListener('sse:reconnected', onReconnect)
  }, [projectId, ticketId, hasActiveSession])

  const handleStart = async () => {
    setState('pending')
    try {
      await api.startRemoteControl(projectId, ticketId, ticketTitle)
    } catch {
      setState('idle')
    }
  }

  if (state === 'active' && url) {
    return (
      <div className="flex items-center gap-2">
        <Monitor className="h-4 w-4 text-accent flex-shrink-0" />
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "text-sm text-accent hover:underline flex items-center gap-1",
          )}
        >
          Open in Claude.ai
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    )
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!hasActiveSession || state === 'pending'}
      onClick={handleStart}
      className="gap-2"
    >
      {state === 'pending' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Monitor className="h-4 w-4" />
      )}
      {state === 'pending' ? 'Connecting…' : 'Start Remote Control'}
    </Button>
  )
}
```

**Step 4: Wire into ActivityTab**

In `apps/frontend/src/components/ticket-detail/ActivityTab.tsx`, add the button to the top of the activity area. Find the `RestartPhaseButton` usage (near the top of the returned JSX) and add `RemoteControlButton` alongside it.

Import at top of file:
```typescript
import { RemoteControlButton } from './RemoteControlButton'
```

Add a `hasActiveSession` prop or derive it. The `ActivityTab` doesn't currently receive session state directly — use `useQuery` to check via the existing sessions query, or pass `hasActiveSession` as a prop from `TicketDetailPanel`.

The simplest approach: add a TanStack Query call in `ActivityTab` for the active session:

```typescript
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

// Inside ActivityTab component:
const { data: rcData } = useQuery({
  queryKey: ['remote-control', projectId, ticketId],
  queryFn: () => api.getRemoteControl(projectId, ticketId),
  refetchInterval: false,
})

// hasActiveSession derived from appStore using the existing isTicketProcessing selector
// Note: processingTickets is a Map — use the selector, not bracket notation
const hasActiveSession = useAppStore((s) => s.isTicketProcessing(projectId, ticketId))
```

Add `RemoteControlButton` in the JSX near the `RestartPhaseButton`:

```tsx
<div className="flex items-center gap-2 px-4 pt-3">
  <RemoteControlButton
    projectId={projectId}
    ticketId={ticketId}
    ticketTitle={/* pass from parent or derive */}
    hasActiveSession={hasActiveSession}
  />
</div>
```

**Note:** `ticketTitle` needs to flow down from the parent. In `ActivityTab`, add a `ticketTitle?: string` prop and pass it from `TicketDetailPanel`:
```typescript
// In TicketDetailPanel, in the ActivityTab usage:
<ActivityTab
  projectId={currentProjectId!}
  ticketId={ticket.id}
  currentPhase={ticket.phase}
  history={ticket.history}
  archived={ticket.archived}
  ticketTitle={ticket.title}  // add this
/>
```

**Step 5: Run test to verify it passes**

```bash
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/frontend test -- --run RemoteControlButton 2>&1 | tail -10
```

Expected: PASS

**Step 6: Run full test suite**

```bash
/c/Users/jackd/AppData/Roaming/npm/pnpm test 2>&1 | grep -E "✓|✖|FAIL|PASS|failing" | tail -20
```

Expected: Same failures as baseline (2 pre-existing), no new failures

**Step 7: Commit**

```bash
git add apps/frontend/src/components/ticket-detail/RemoteControlButton.tsx \
        apps/frontend/src/components/ticket-detail/RemoteControlButton.test.tsx \
        apps/frontend/src/components/ticket-detail/ActivityTab.tsx \
        apps/frontend/src/components/ticket-detail/TicketDetailPanel.tsx
git commit -m "feat: add RemoteControlButton component and wire into ActivityTab"
```

---

## Task 7: Emit session:remote-control-cleared on PTY exit

**Depends on:** Task 1
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`

**Purpose:** When the PTY exits, any active RC URL becomes invalid. The frontend must be notified to reset the button.

**Not In Scope:** Clearing on daemon restart (in-memory state is cleared automatically when the process dies).

**Gotchas:** The `meta` object containing `ticketId` and `projectId` is captured in the closure of `spawnClaudeSession`. Use it directly.

**Step 1: Implement**

In `apps/daemon/src/services/session/session.service.ts`, find the PTY `onExit` handler (where `exitResolver()` is called and `this.sessions.delete(sessionId)` happens). Add before the delete:

```typescript
// Clear remote control state and notify frontend
if (this.remoteControlState.has(sessionId)) {
  this.remoteControlState.delete(sessionId);
  eventBus.emit("session:remote-control-cleared", {
    sessionId,
    ticketId: meta.ticketId,
    projectId: meta.projectId,
  });
}
```

**Step 2: Build and verify**

```bash
/c/Users/jackd/AppData/Roaming/npm/pnpm --filter @potato-cannon/daemon build 2>&1 | tail -5
```

Expected: No errors

**Step 3: Commit**

```bash
git add apps/daemon/src/services/session/session.service.ts
git commit -m "feat: emit session:remote-control-cleared on PTY exit"
```

---

## Execution Order

Tasks can be executed with these dependencies:
```
1 (SessionService state) → 2 (event types) → 3 (API routes) → 4 (API client) → 5 (SSE hook) → 6 (UI)
                                           → 7 (clear on exit)  [parallel with 3+]
```

Tasks 3 and 7 can run in parallel after Task 2.
Tasks 4, 5, 6 must run sequentially after Task 3.

---

---

## Verification Record

| Pass | Verdict | Key Findings |
|------|---------|-------------|
| Checklist | PASS | All 8 items pass. Minor: Task 6 needs `useAppStore` import added; Task 3 self-corrects dynamic import. |
| Draft | PASS | Coherent structure. Notes: Task 7 diagram branch label wrong (fixed inline), Task 3 conflicting import examples (fixed). |
| Feasibility | PASS | All file paths verified. Fix required: use `isTicketProcessing` selector, not bracket notation on Map (fixed). |
| Completeness | BLOCKED → PASS | **Fixed:** URL scanner moved before per-line loop on raw `data` buffer; URL length cap added (`{1,150}`); double-click guard added to `startRemoteControl`; Task 3 dynamic import removed. |
| Risk | BLOCKED → PASS | **Fixed:** SSE reconnect recovery added — `onopen` dispatches `sse:reconnected`; `RemoteControlButton` listens and re-fetches RC state. |
| Optimality | PASS | In-memory Map justified, `useRemoteControlSSE` hook consistent with existing patterns, `sse:reconnected` approach optimal. |

**Verified:** 2026-03-09 | **Model:** claude-sonnet-4-6 | **Status:** Approved for implementation
