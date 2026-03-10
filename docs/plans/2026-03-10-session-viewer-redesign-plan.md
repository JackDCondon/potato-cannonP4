# Session Viewer Redesign Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Replace the session-scoped transcript viewer with a ticket-level timeline that automatically follows a ticket through all phases, with swimlane-colored phase dividers and clean, collapsible output rendering.

**Architecture:** The frontend gains a new `/transcript/ticket/$ticketId` route backed by a `TicketTranscriptPage` component that fetches all sessions for a ticket, stitches their JSONL logs into one unified entry array with phase dividers, and subscribes to SSE for live updates as new sessions start. The backend adds a single new endpoint to query sessions by ticketId. `EventRow` is overhauled to strip ANSI codes and show collapsed tool calls with a primary-argument summary.

**Tech Stack:** React 19, TanStack Router (file-based), TanStack Query, highlight.js (already installed), strip-ansi (to install), better-sqlite3, Express, SSE via EventBus.

**Key Decisions:**
- **Route structure:** `/transcript/ticket/$ticketId` with `projectId` as a search param — avoids restructuring existing routes, matches how `pending.tsx` currently passes params.
- **Live session detection:** On `session:started` SSE event, invalidate the `ticketSessions` query — no need for a new SSE event type. The new session's output then flows through the existing `useSessionOutput` hook filtered by known sessionIds.
- **ANSI stripping:** Use `strip-ansi` package (not regex) — handles edge cases like partial escape sequences in PTY output. Applied at parse time in `EventRow`, not at write time, so the raw JSONL is preserved.
- **Swimlane colors:** Fetched from project data already in the query cache (via `useProject`) — no new API call needed.
- **Old routes kept:** `/transcript/:sessionId` and `/transcript/pending` are removed since all navigation goes through `ViewSessionButton`, which is updated to the new route. No external links to the old routes exist.

---

## Task 1: Backend — Add ticket sessions endpoint

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/server/routes/sessions.routes.ts`
- Modify: `apps/daemon/src/stores/ticket.store.ts` (or sessions store — wherever sessions are queried)

**Purpose:** The frontend needs to fetch all sessions for a ticket in chronological order to build the unified timeline.

**Not In Scope:** Pagination, filtering by status, or any other query params.

**Gotchas:** Sessions are stored in a `sessions` table. Check if there's already a `getSessionsByTicketId` method in the store before adding one. The session store may live in a separate file from ticket.store.ts — check `apps/daemon/src/stores/`.

**Step 1: Write the failing test**
```typescript
// apps/daemon/src/server/routes/sessions.routes.test.ts (or nearest test file)
// Add to existing test suite:
it('GET /api/projects/:projectId/tickets/:ticketId/sessions returns sessions ordered by startedAt', async () => {
  // seed two sessions for the same ticketId
  // GET /api/projects/proj-1/tickets/ticket-1/sessions
  // expect array of session metadata, ordered by startedAt ascending
  // expect each item has: id, phase, agentType, status, startedAt, endedAt?
});
```

**Step 2: Run test to verify it fails**
```
cd apps/daemon && pnpm test
```
Expected: FAIL (route doesn't exist)

**Step 3: Verify store method already exists**

`apps/daemon/src/stores/session.store.ts` already exports `getSessionsByTicket(ticketId)` as a standalone singleton function (line ~235). No new method needed — use the existing export directly in the route.

**Step 4: Add route**

In `apps/daemon/src/server/routes/sessions.routes.ts`, the file uses `app.get(...)` (not a Router). Add inside the `registerSessionRoutes` function, before the closing brace, importing `getSessionsByTicket` from the session store:
```typescript
// GET /api/projects/:projectId/tickets/:ticketId/sessions
app.get('/api/projects/:projectId/tickets/:ticketId/sessions', (req: Request, res: Response) => {
  const { ticketId } = req.params;
  const sessions = getSessionsByTicket(ticketId);
  // StoredSession has no 'status' field — derive it from endedAt/exitCode for the frontend SessionMeta type
  const result = sessions.map(s => ({
    ...s,
    status: !s.endedAt ? 'running' : (s.exitCode === 0 || s.exitCode == null) ? 'completed' : 'failed',
  }));
  res.json(result);
});
```

> **Note:** `StoredSession` uses `agentSource` (not `agentType`) and has no `status` field. The mapping above derives `status` from `endedAt`/`exitCode`. The frontend `SessionMeta` type must use `agentSource` to match.

Also add the import at the top of the file alongside the existing `getActiveSessionForTicket` import:
```typescript
import { getActiveSessionForTicket, getSessionsByTicket } from '../../stores/session.store.js';
```

**Step 5: Register route on server**

Verify in `apps/daemon/src/server/server.ts` that session routes are mounted at `/api`. If the existing route is mounted as `app.use('/api', sessionRouter)`, no change needed. If it's mounted elsewhere, adjust the path.

**Step 6: Run test to verify it passes**
```
cd apps/daemon && pnpm test
```
Expected: PASS

**Step 7: Commit**
```
git add apps/daemon/src/server/routes/sessions.routes.ts apps/daemon/src/stores/
git commit -m "feat: add GET /api/projects/:projectId/tickets/:ticketId/sessions endpoint"
```

---

## Task 2: Frontend — Install strip-ansi

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/package.json` (implicit — pnpm adds it)
- Modify: `pnpm-lock.yaml` (implicit)

**Purpose:** PTY output contains ANSI escape sequences that render as garbage (`[39;120H`). `strip-ansi` handles all edge cases including partial sequences.

**Step 1: Install**
```
cd apps/frontend && pnpm add strip-ansi
```

**Step 2: Verify import works**
```typescript
// Quick smoke test — paste in browser console or a test file:
import stripAnsi from 'strip-ansi';
console.log(stripAnsi('\u001B[4mHello\u001B[0m')); // → "Hello"
```

**Step 3: Commit**
```
git add apps/frontend/package.json pnpm-lock.yaml
git commit -m "chore: add strip-ansi to frontend dependencies"
```

---

## Task 3: Frontend — API client + query hook for ticket sessions

**Depends on:** Task 1
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/api/client.ts` (add `getTicketSessions`)
- Modify: `apps/frontend/src/hooks/queries.ts` (add `useTicketSessions`)

**Purpose:** The new `TicketTranscriptPage` needs to load all sessions for a ticket and know their metadata (phase, agentType, status) to insert phase dividers.

**Step 1: Write the failing test**
```typescript
// apps/frontend/src/hooks/queries.test.ts (or wherever query hooks are tested)
it('useTicketSessions fetches sessions for a ticket', async () => {
  server.use(
    http.get('/api/projects/p1/tickets/t1/sessions', () =>
      HttpResponse.json([{ id: 's1', phase: 'Build', agentType: 'architect', status: 'completed', startedAt: '...' }])
    )
  );
  const { result } = renderHook(() => useTicketSessions('p1', 't1'));
  await waitFor(() => expect(result.current.data).toHaveLength(1));
});
```

**Step 2: Run test to verify it fails**
```
cd apps/frontend && pnpm test
```
Expected: FAIL

**Step 3: Add API function**

In `apps/frontend/src/api/client.ts`, after the existing session functions (~line 258):
```typescript
getTicketSessions: async (projectId: string, ticketId: string): Promise<SessionMeta[]> => {
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/tickets/${ticketId}/sessions`);
  if (!res.ok) throw new Error('Failed to fetch ticket sessions');
  return res.json();
},
```

**Step 4: Add shared type**

In `packages/shared/src/types/session.types.ts`, add (if not already present):
```typescript
export interface SessionMeta {
  id: string;
  ticketId?: string;
  phase?: string;
  agentSource?: string;  // maps to agent_source DB column via StoredSession.agentSource — NOT agentType
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  endedAt?: string;
}
```

> **Gotcha:** The backend `StoredSession` type uses `agentSource` (not `agentType`). The endpoint in Task 1 returns `StoredSession` objects directly. All frontend code consuming `SessionMeta` must use `agentSource` — update `PhaseDivider`, `TicketTranscriptPage`, and `PhaseHeader` accordingly wherever the plan shows `agentType`.

**Step 5: Add query hook**

In `apps/frontend/src/hooks/queries.ts`, after `useStopSession` (~line 281):
```typescript
export function useTicketSessions(projectId: string | undefined, ticketId: string | undefined) {
  return useQuery({
    queryKey: ['ticketSessions', projectId, ticketId],
    queryFn: () => api.getTicketSessions(projectId!, ticketId!),
    enabled: !!projectId && !!ticketId,
  });
}
```

**Step 6: Run test to verify it passes**
```
cd apps/frontend && pnpm test
```
Expected: PASS

**Step 7: Commit**
```
git add apps/frontend/src/api/client.ts apps/frontend/src/hooks/queries.ts packages/shared/src/types/
git commit -m "feat: add getTicketSessions API + useTicketSessions hook"
```

---

## Task 4: Frontend — EventRow overhaul

**Depends on:** Task 2
**Complexity:** complex
**Files:**
- Modify: `apps/frontend/src/components/transcript/EventRow.tsx`
- Test: `apps/frontend/src/components/transcript/EventRow.test.tsx` (create)

**Purpose:** Fix unreadable output: strip ANSI codes, show collapsed tool calls with primary-arg summary, add red border on error results. Syntax highlighting already works for expanded content — keep it.

**Not In Scope:** Per-tool rich rendering (diff views, file trees) — that's future work per the design. Only the generic collapsed/expanded treatment is in scope here.

**Step 1: Write failing tests**
```typescript
// apps/frontend/src/components/transcript/EventRow.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventRow } from './EventRow';

describe('EventRow', () => {
  it('strips ANSI codes from raw content', () => {
    render(<EventRow entry={{ type: 'raw', content: '\u001B[4mHello\u001B[0m', timestamp: '' }} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByText(/\u001B/)).not.toBeInTheDocument();
  });

  it('shows collapsed tool call with ToolName → primary arg', () => {
    render(<EventRow entry={{
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/index.ts' } }] },
      timestamp: ''
    }} />);
    expect(screen.getByText(/Read/)).toBeInTheDocument();
    expect(screen.getByText(/src\/index\.ts/)).toBeInTheDocument();
    // expanded content not visible by default
    expect(screen.queryByText(/"file_path"/)).not.toBeInTheDocument();
  });

  it('expands tool call on click', async () => {
    render(<EventRow entry={{ /* tool_use entry */ }} />);
    await userEvent.click(screen.getByRole('button', { name: /Read/ }));
    expect(screen.getByText(/"file_path"/)).toBeInTheDocument();
  });

  it('shows red border on error tool result', () => {
    const { container } = render(<EventRow entry={{
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: not found', is_error: true }] },
      timestamp: ''
    }} />);
    expect(container.firstChild).toHaveClass('border-red-500'); // or similar
  });
});
```

**Step 2: Run tests to verify they fail**
```
cd apps/frontend && pnpm test EventRow
```
Expected: FAIL

**Step 3: Implement ANSI stripping**

At the top of `EventRow.tsx`, add:
```typescript
import stripAnsi from 'strip-ansi';
```

Create a helper:
```typescript
function cleanContent(content: string): string {
  return stripAnsi(content);
}
```

Apply `cleanContent()` wherever raw string content is rendered (raw entry type, tool result string content).

**Step 4: Implement collapsed tool call header**

Replace the existing tool_use rendering with a collapsible component. The collapsed state shows:

```typescript
function toolPrimaryArg(name: string, input: Record<string, unknown>): string {
  const fileTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit'];
  const bashTools = ['Bash'];
  if (fileTools.includes(name)) return String(input.file_path ?? input.path ?? '');
  if (bashTools.includes(name)) return String(input.command ?? '').slice(0, 60);
  const firstValue = Object.values(input)[0];
  return firstValue ? String(firstValue).slice(0, 60) : '';
}
```

Collapsed header JSX:
```tsx
<button
  onClick={() => setExpanded(e => !e)}
  className="flex items-center gap-2 text-sm font-mono text-yellow-400/80 hover:text-yellow-300 w-full text-left"
>
  <span>{expanded ? '▼' : '▶'}</span>
  <span>{name}</span>
  {primaryArg && <span className="text-zinc-400">→ {primaryArg}</span>}
</button>
```

**Step 5: Implement error border on tool results**

For `tool_result` entries with `is_error: true`, add `border-l-2 border-red-500` to the row wrapper:
```tsx
<div className={cn('pl-4', entry.is_error && 'border-l-2 border-red-500')}>
```

**Step 6: Run tests to verify they pass**
```
cd apps/frontend && pnpm test EventRow
```
Expected: PASS

**Step 7: Commit**
```
git add apps/frontend/src/components/transcript/EventRow.tsx apps/frontend/src/components/transcript/EventRow.test.tsx
git commit -m "feat: overhaul EventRow — ANSI stripping, collapsed tool calls, error borders"
```

---

## Task 5: Frontend — Phase transition components

**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/components/transcript/PhaseDivider.tsx`
- Create: `apps/frontend/src/components/transcript/PhaseHeader.tsx`
- Create: `apps/frontend/src/components/transcript/IdleMarker.tsx`
- Test: `apps/frontend/src/components/transcript/PhaseDivider.test.tsx` (create)

**Purpose:** Visual components for phase transitions. `PhaseDivider` is the full-width in-stream banner. `PhaseHeader` is the sticky top header. `IdleMarker` is the subtle end-of-session marker.

**Not In Scope:** The logic that decides which color to use — that lives in `TicketTranscriptPage`. These are pure display components that accept a `color` prop.

**Step 1: Write failing tests**
```typescript
// apps/frontend/src/components/transcript/PhaseDivider.test.tsx
import { render, screen } from '@testing-library/react';
import { PhaseDivider } from './PhaseDivider';
import { PhaseHeader } from './PhaseHeader';
import { IdleMarker } from './IdleMarker';

// PhaseDivider tests
it('renders phase name, agent source, and timestamp', () => {
  render(<PhaseDivider phase="Build" agentSource="architect-agent" timestamp="2026-03-10T14:34:00Z" color="#122318" />);
  expect(screen.getByText(/Build/)).toBeInTheDocument();
  expect(screen.getByText(/architect-agent/)).toBeInTheDocument();
});

it('applies swimlane color as background/border', () => {
  const { container } = render(<PhaseDivider phase="Build" agentSource="architect" timestamp="" color="#122318" />);
  expect(container.firstChild).toHaveStyle({ borderColor: '#122318' });
});

// PhaseHeader tests
it('PhaseHeader renders ticket title, phase, and live badge', () => {
  render(<PhaseHeader ticketTitle="My Ticket" phase="Build" isLive={true} />);
  expect(screen.getByText(/My Ticket/)).toBeInTheDocument();
  expect(screen.getByText(/Build/)).toBeInTheDocument();
  expect(screen.getByText(/Live/)).toBeInTheDocument();
});

it('PhaseHeader shows Ended badge when not live', () => {
  render(<PhaseHeader ticketTitle="My Ticket" isLive={false} />);
  expect(screen.getByText(/Ended/)).toBeInTheDocument();
});

// IdleMarker tests
it('IdleMarker renders phase name and waiting message', () => {
  render(<IdleMarker phase="Build" timestamp="2026-03-10T14:34:00Z" />);
  expect(screen.getByText(/Build/)).toBeInTheDocument();
  expect(screen.getByText(/waiting for next phase/)).toBeInTheDocument();
});
```

**Step 2: Run tests to verify they fail**
```
cd apps/frontend && pnpm test PhaseDivider
```
Expected: FAIL

**Step 3: Implement PhaseDivider**
```tsx
// apps/frontend/src/components/transcript/PhaseDivider.tsx
// Note: date-fns is NOT installed — use native toLocaleTimeString (already done below). Do not add a date-fns import.

interface PhaseDividerProps {
  phase: string;
  agentSource?: string;  // was agentType in plan draft — corrected to match StoredSession.agentSource
  timestamp: string;
  color?: string;
}

export function PhaseDivider({ phase, agentSource, timestamp, color }: PhaseDividerProps) {
  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <div
      className="w-full flex items-center gap-3 px-4 py-2 my-2 border-l-4 font-semibold text-sm"
      style={{ borderColor: color ?? '#374151', backgroundColor: color ? `${color}33` : undefined }}
    >
      <span className="text-white">→ {phase} Phase</span>
      {agentSource && <span className="text-zinc-400">· {agentSource}</span>}
      {timeStr && <span className="text-zinc-500 ml-auto">{timeStr}</span>}
    </div>
  );
}
```

**Step 4: Implement PhaseHeader**
```tsx
// apps/frontend/src/components/transcript/PhaseHeader.tsx
interface PhaseHeaderProps {
  ticketTitle: string;
  phase?: string;
  agentSource?: string;  // was agentType in plan draft — corrected to match StoredSession.agentSource
  isLive: boolean;
  totalTokens?: number;
  color?: string;
}

export function PhaseHeader({ ticketTitle, phase, agentSource, isLive, totalTokens, color }: PhaseHeaderProps) {
  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2 border-b border-zinc-700 bg-zinc-900 border-l-4"
      style={{ borderLeftColor: color ?? 'transparent' }}
    >
      <span className="font-semibold text-white truncate">{ticketTitle}</span>
      {phase && <span className="text-zinc-400 text-sm">{phase}</span>}
      {agentSource && <span className="text-zinc-500 text-xs">{agentSource}</span>}
      <div className="ml-auto flex items-center gap-3">
        {totalTokens !== undefined && (
          <span className="text-zinc-500 text-xs">{totalTokens.toLocaleString()} tokens</span>
        )}
        <span className={`text-xs px-2 py-0.5 rounded-full ${isLive ? 'bg-green-900 text-green-400' : 'bg-zinc-700 text-zinc-400'}`}>
          {isLive ? 'Live' : 'Ended'}
        </span>
      </div>
    </div>
  );
}
```

**Step 5: Implement IdleMarker**
```tsx
// apps/frontend/src/components/transcript/IdleMarker.tsx
interface IdleMarkerProps {
  phase: string;
  timestamp: string;
}

export function IdleMarker({ phase, timestamp }: IdleMarkerProps) {
  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <div className="w-full text-center text-zinc-500 text-xs py-3 border-t border-zinc-800 mt-2">
      {phase} phase complete · waiting for next phase · {timeStr}
    </div>
  );
}
```

**Step 6: Run tests to verify they pass**
```
cd apps/frontend && pnpm test PhaseDivider
```
Expected: PASS

**Step 7: Commit**
```
git add apps/frontend/src/components/transcript/PhaseDivider.tsx apps/frontend/src/components/transcript/PhaseHeader.tsx apps/frontend/src/components/transcript/IdleMarker.tsx apps/frontend/src/components/transcript/PhaseDivider.test.tsx
git commit -m "feat: add PhaseDivider, PhaseHeader, IdleMarker components"
```

---

## Task 6: Frontend — TicketTranscriptPage component

**Depends on:** Task 3, Task 4, Task 5, Task 9
**Complexity:** complex
**Files:**
- Create: `apps/frontend/src/components/transcript/TicketTranscriptPage.tsx`
- Test: `apps/frontend/src/components/transcript/TicketTranscriptPage.test.tsx` (create)

**Purpose:** The main viewer. Fetches all sessions for a ticket, stitches logs with phase dividers, subscribes to SSE for new sessions, handles auto-scroll and copy.

**Gotchas:**
- `useSessionOutput` broadcasts ALL session output globally. Filter by checking if the entry's sessionId is in the set of known sessions for this ticket.
- When `session:started` SSE fires, invalidate `['ticketSessions', projectId, ticketId]` in the query client to trigger a refetch — then the new session's entries flow through the existing SSE subscription.
- Swimlane colors come from `useProject(projectId)` which should already be in the query cache if the user navigated from the board. If not, it fetches fresh.
- The `useQueryClient` invalidation approach means we need access to both `queryClient` and the SSE event. Use the existing `useSSE` hook's `session:started` event or add a `useSessionStarted` hook similar to `useSessionEnded`.

**Step 1: Write failing tests**
```typescript
// apps/frontend/src/components/transcript/TicketTranscriptPage.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { TicketTranscriptPage } from './TicketTranscriptPage';

// Mock api.getTicketSessions to return 2 sessions
// Mock api.getSessionLog for each sessionId
// Mock useProject to return project with swimlaneColors

it('renders phase dividers between sessions', async () => {
  // session 1: phase "Refinement", session 2: phase "Build"
  await waitFor(() => {
    expect(screen.getByText(/Refinement Phase/)).toBeInTheDocument();
    expect(screen.getByText(/Build Phase/)).toBeInTheDocument();
  });
});

it('shows idle marker after last completed session', async () => {
  // both sessions status: completed, no live session
  await waitFor(() => {
    expect(screen.getByText(/waiting for next phase/)).toBeInTheDocument();
  });
});

it('shows PhaseHeader with current phase', async () => {
  await waitFor(() => {
    expect(screen.getByText(/Build/)).toBeInTheDocument(); // in sticky header
  });
});
```

**Step 2: Run tests to verify they fail**
```
cd apps/frontend && pnpm test TicketTranscriptPage
```
Expected: FAIL

**Step 3: Implement TicketTranscriptPage**
```tsx
// apps/frontend/src/components/transcript/TicketTranscriptPage.tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTicketSessions } from '@/hooks/queries';
import { useSessionOutput, useSessionEnded, useSessionStarted } from '@/hooks/useSSE';
import { api } from '@/api/client';
import type { SessionLogEntry, SessionMeta } from '@potato-cannon/shared';
import { PhaseHeader } from './PhaseHeader';
import { PhaseDivider } from './PhaseDivider';
import { IdleMarker } from './IdleMarker';
import { EventRow } from './EventRow';

type TimelineEntry =
  | { kind: 'entry'; sessionId: string; entry: SessionLogEntry }
  | { kind: 'phase-divider'; session: SessionMeta }
  | { kind: 'idle'; phase: string; timestamp: string };

interface Props {
  projectId: string;
  ticketId: string;
}

export function TicketTranscriptPage({ projectId, ticketId }: Props) {
  const queryClient = useQueryClient();
  const { data: sessions = [] } = useTicketSessions(projectId, ticketId);
  const [historicalEntries, setHistoricalEntries] = useState<TimelineEntry[]>([]);
  const [liveEntries, setLiveEntries] = useState<TimelineEntry[]>([]);
  const [headerMeta, setHeaderMeta] = useState<{ ticketTitle: string; phase?: string; agentSource?: string; totalTokens?: number; color?: string; isLive: boolean }>({
    ticketTitle: ticketId,
    isLive: false,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const knownSessionIds = useRef<Set<string>>(new Set());

  // Load historical entries whenever sessions list changes
  useEffect(() => {
    if (!sessions.length) return;
    const load = async () => {
      const timeline: TimelineEntry[] = [];
      let lastLog: SessionLogEntry[] = [];
      for (const session of sessions) {
        timeline.push({ kind: 'phase-divider', session });
        const log = await api.getSessionLog(session.id);
        lastLog = log;
        for (const entry of log) {
          timeline.push({ kind: 'entry', sessionId: session.id, entry });
        }
        knownSessionIds.current.add(session.id);
      }
      // Add idle marker if last session is completed and none running
      const lastSession = sessions[sessions.length - 1];
      if (lastSession && lastSession.status !== 'running') {
        timeline.push({ kind: 'idle', phase: lastSession.phase ?? 'Last', timestamp: lastSession.endedAt ?? '' });
      }
      setHistoricalEntries(timeline);

      // Update header from last session — reuse lastLog already fetched in the loop above
      const startEntry = lastLog.find(e => e.type === 'session_start');
      if (startEntry && startEntry.type === 'session_start') {
        setHeaderMeta({
          ticketTitle: startEntry.meta.ticketTitle ?? ticketId,
          phase: lastSession.phase,        // use StoredSession.phase (not log meta)
          agentSource: lastSession.agentSource,  // use StoredSession.agentSource (not agentType)
          isLive: lastSession.status === 'running',
        });
      }
    };
    load();
  }, [sessions, ticketId]);

  // Live output — filter by known sessions for this ticket
  useSessionOutput(useCallback((data: { sessionId: string; entry: SessionLogEntry }) => {
    if (!knownSessionIds.current.has(data.sessionId)) return;
    setLiveEntries(prev => [...prev, { kind: 'entry', sessionId: data.sessionId, entry: data.entry }]);
    setHeaderMeta(m => ({ ...m, isLive: true }));
  }, []));

  // When new session starts, refetch session list (picks up new session + shows new phase divider)
  // useSessionStarted is added in Task 9 (it does NOT exist yet in useSSE.ts)
  useSessionStarted(useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ticketSessions', projectId, ticketId] });
    // Clear idle marker from live entries since a new session started
    setLiveEntries([]);
  }, [queryClient, projectId, ticketId]));

  // When active session ends, update header + append idle marker
  // useSessionEnded already exists in useSSE.ts
  useSessionEnded(useCallback((data: SSEEventData) => {
    const { sessionId } = data as { sessionId?: string };
    if (!sessionId || !knownSessionIds.current.has(sessionId)) return;
    setHeaderMeta(m => ({ ...m, isLive: false }));
    // The sessions refetch will add the idle marker to historicalEntries on next load
    queryClient.invalidateQueries({ queryKey: ['ticketSessions', projectId, ticketId] });
  }, [queryClient, projectId, ticketId]));

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [historicalEntries, liveEntries, autoScroll]);

  const allEntries = [...historicalEntries, ...liveEntries];

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <PhaseHeader {...headerMeta} />
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-1"
        onScroll={e => {
          const el = e.currentTarget;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          setAutoScroll(nearBottom);
        }}
      >
        {allEntries.map((item, i) => {
          if (item.kind === 'phase-divider') {
            return <PhaseDivider key={`div-${i}`} phase={item.session.phase ?? 'Unknown'} agentSource={item.session.agentSource} timestamp={item.session.startedAt} />;
          }
          if (item.kind === 'idle') {
            return <IdleMarker key={`idle-${i}`} phase={item.phase} timestamp={item.timestamp} />;
          }
          return <EventRow key={`${item.sessionId}-${i}`} entry={item.entry} />;
        })}
      </div>
      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
          className="fixed bottom-4 right-4 bg-zinc-700 hover:bg-zinc-600 text-white text-xs px-3 py-1.5 rounded-full"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}
```

**Step 4: Run tests to verify they pass**
```
cd apps/frontend && pnpm test TicketTranscriptPage
```
Expected: PASS

**Step 5: Commit**
```
git add apps/frontend/src/components/transcript/TicketTranscriptPage.tsx apps/frontend/src/components/transcript/TicketTranscriptPage.test.tsx
git commit -m "feat: add TicketTranscriptPage component — ticket-scoped unified timeline"
```

---

## Task 7: Frontend — New route file

**Depends on:** Task 6
**Complexity:** simple
**Files:**
- Create: `apps/frontend/src/routes/transcript/ticket.$ticketId.tsx`
- Modify: `apps/frontend/src/routeTree.gen.ts` (auto-regenerated by Vite — do not edit manually)

**Purpose:** Wire the `TicketTranscriptPage` component into TanStack Router. The route uses `ticketId` from path params and `projectId` from search params, matching the pattern already used in `pending.tsx`.

**Gotchas:** `routeTree.gen.ts` is auto-generated. After creating the route file and running the dev server (or `pnpm build`), the file regenerates automatically. Do not manually edit it.

**Step 1: Create route file**
```tsx
// apps/frontend/src/routes/transcript/ticket.$ticketId.tsx
import { createFileRoute } from '@tanstack/react-router';
import { TicketTranscriptPage } from '@/components/transcript/TicketTranscriptPage';

export const Route = createFileRoute('/transcript/ticket/$ticketId')({
  validateSearch: (search: Record<string, unknown>) => ({
    projectId: String(search.projectId ?? ''),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { ticketId } = Route.useParams();
  const { projectId } = Route.useSearch();
  return <TicketTranscriptPage projectId={projectId} ticketId={ticketId} />;
}
```

**Step 2: Regenerate route tree**
```
cd apps/frontend && pnpm dev
```
TanStack Router Vite plugin regenerates `routeTree.gen.ts` on startup. Verify the new route appears in the file, then stop the dev server.

**Step 3: Verify TypeScript**
```
cd apps/frontend && pnpm typecheck
```
Expected: no errors on the new route file.

**Step 4: Commit**
```
git add apps/frontend/src/routes/transcript/ticket.$ticketId.tsx apps/frontend/src/routeTree.gen.ts
git commit -m "feat: add /transcript/ticket/:ticketId route"
```

---

## Task 8: Frontend — Update ViewSessionButton + remove pending route

**Depends on:** Task 7
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/components/ticket-detail/ViewSessionButton.tsx`
- Delete: `apps/frontend/src/routes/transcript/pending.tsx`
- Delete: `apps/frontend/src/routes/transcript/$sessionId.tsx` (optional — see Gotchas)

**Purpose:** Update the entry point to navigate to the new ticket-level route. Remove the now-unused pending route.

**Gotchas:**
- `ViewSessionButton` currently calls `api.getRemoteControl()` to get a sessionId before navigating. With the new route this is unnecessary — just navigate to `/transcript/ticket/:ticketId?projectId=...` directly.
- Keep the old `$sessionId` route initially (in case any deep links exist elsewhere in the codebase). Run a grep for `/transcript/` usage before deleting it.
- `routeTree.gen.ts` will auto-regenerate when the dev server picks up the deleted files.

**Step 1: Grep for existing usages of old routes**
```
grep -r '/transcript/' apps/frontend/src --include='*.tsx' --include='*.ts'
```
If only `ViewSessionButton` and the route files themselves reference `/transcript/:sessionId` or `/transcript/pending`, it's safe to delete both.

**Step 2: Update ViewSessionButton**

> **Risk note:** The current `ViewSessionButton` uses `window.open(url, '_blank')` to open the transcript in a **new tab**. The replacement below preserves that behaviour using `window.open` with the new hash route. Do NOT switch to `useNavigate` (same-tab navigation) — that would be a breaking UX change that removes the new-tab behaviour users depend on.

Replace the entire component body. Before:
```tsx
// navigates to /transcript/pending or /transcript/:sessionId via window.open (new tab)
```

After:
```tsx
// apps/frontend/src/components/ticket-detail/ViewSessionButton.tsx
import { Monitor } from 'lucide-react';

interface Props {
  projectId: string;
  ticketId: string;
  hasActiveSession?: boolean;
}

export function ViewSessionButton({ projectId, ticketId }: Props) {
  const handleClick = () => {
    const url = `/#/transcript/ticket/${encodeURIComponent(ticketId)}?projectId=${encodeURIComponent(projectId)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
    >
      <Monitor className="h-4 w-4" />
      View Session
    </button>
  );
}
```

**Step 3: Delete pending route**
```
rm apps/frontend/src/routes/transcript/pending.tsx
```

**Step 4: Delete old sessionId route (if no other references)**
```
rm apps/frontend/src/routes/transcript/$sessionId.tsx
```

**Step 5: Regenerate route tree**
```
cd apps/frontend && pnpm dev
```
Verify `routeTree.gen.ts` no longer includes the old routes.

**Step 6: Run all tests**
```
cd apps/frontend && pnpm test
```
Expected: all pass (no references to old route in tests).

**Step 7: Run typecheck**
```
pnpm typecheck
```
Expected: PASS

**Step 8: Commit**
```
git add apps/frontend/src/components/ticket-detail/ViewSessionButton.tsx apps/frontend/src/routeTree.gen.ts
git rm apps/frontend/src/routes/transcript/pending.tsx apps/frontend/src/routes/transcript/'$sessionId'.tsx
git commit -m "feat: update ViewSessionButton to ticket-level route, remove pending + sessionId routes"
```

---

## Task 9: Frontend — Add useSSE session event hooks

**Depends on:** None (parallel with other tasks)
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/hooks/useSSE.ts`

**Purpose:** `TicketTranscriptPage` needs to subscribe to `session:started` and `session:ended` events by name. The existing `useSessionOutput` and `useSessionEnded` hooks only expose callbacks without the sessionId in the `ended` case. Verify what data these hooks expose and add `useSessionStarted` if missing.

**Not In Scope:** Changing how events are emitted on the backend.

**Gotchas:** Check the existing `useSessionEnded` hook signature — if it already provides `sessionId` in the callback data, no change is needed for that hook. Only add what's missing.

**Step 1: Confirmed hook signatures (verified during plan verification)**

- `useSessionOutput(cb)` — `cb` receives `SSEEventData` (includes `sessionId`, `event`, `projectId`, `ticketId`). Exists.
- `useSessionEnded(cb)` — `cb` receives `SSEEventData` (includes `projectId`, `ticketId`). Exists.
- `useSessionStarted` — Does NOT exist. Must be added. The main `useSSE` hook handles `session:started` internally (invalidates queries) but does NOT dispatch a `sse:session-started` window event.

**Step 2: Add useSessionStarted**
```typescript
export function useSessionStarted(callback: (data: { sessionId: string; ticketId?: string }) => void) {
  useEffect(() => {
    const handler = (e: Event) => callback((e as CustomEvent).detail);
    window.addEventListener('sse:session-started', handler);
    return () => window.removeEventListener('sse:session-started', handler);
  }, [callback]);
}
```

Also update the main `useSSE` hook's `session:started` listener (currently at line 103-106) to dispatch a window custom event, since it currently only calls `refetchQueries` and does NOT dispatch `sse:session-started`:
```typescript
eventSource.addEventListener('session:started', (e) => {
  queryClient.refetchQueries({ queryKey: ['sessions'] })
  queryClient.refetchQueries({ queryKey: ['tickets'] })
  try {
    const data = JSON.parse(e.data) as SSEEventData
    window.dispatchEvent(new CustomEvent('sse:session-started', { detail: data }))
  } catch {
    // Ignore parse errors
  }
})
```

> **Risk note:** The current backend `session:started` listener uses `() => { ... }` with no event argument — it is unknown whether the backend currently emits a JSON payload with this event. If the backend emits `session:started` without a data body, `JSON.parse(e.data)` throws and the `sse:session-started` window event is never dispatched, causing `useSessionStarted` callbacks to silently never fire. The `TicketTranscriptPage` fallback is safe (it will simply not clear the idle marker when a new session starts), but it means the page won't react to new sessions until the user refreshes. **Verify that the backend emits `session:started` with a JSON payload containing at least `{ ticketId }` before relying on this hook.** If the backend emits no payload, the `invalidateQueries` call in `TicketTranscriptPage` must instead be triggered from `useSessionEnded` or a polling fallback.

**Step 3: Write and run test for useSessionStarted**
```typescript
// apps/frontend/src/hooks/useSSE.test.ts (or nearest existing test file for hooks)
it('useSessionStarted fires callback when sse:session-started event dispatched', () => {
  const cb = vi.fn();
  renderHook(() => useSessionStarted(cb));
  const detail = { sessionId: 's1', ticketId: 't1' };
  window.dispatchEvent(new CustomEvent('sse:session-started', { detail }));
  expect(cb).toHaveBeenCalledWith(detail);
});
```
```
cd apps/frontend && pnpm test useSSE
```
Expected: PASS

**Step 4: Typecheck**
```
cd apps/frontend && pnpm typecheck
```
Expected: PASS

**Step 5: Commit**
```
git add apps/frontend/src/hooks/useSSE.ts
git commit -m "feat: add useSessionStarted hook, verify session hook data shapes"
```

---

## Execution Order

Tasks with no dependencies can run in parallel:

```
[Task 1: Backend endpoint]  ──┐
[Task 2: strip-ansi]          ├─→ [Task 3: API+hook] ──┐
[Task 5: Phase components]    │                          ├─→ [Task 6: TicketTranscriptPage] → [Task 7: Route] → [Task 8: Navigation]
[Task 9: SSE hooks]           ├──→ [Task 4: EventRow] ──┘              ▲
                              │                                          │
                              └──────────────────────────────────────────┘
```

Parallel set 1: Tasks 1, 2, 5, 9
Parallel set 2: Tasks 3, 4 (after their deps)
Sequential: 6 (needs 3, 4, 5, 9) → 7 → 8

---

## Verification Record

*(Populated after verification passes)*

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | PASS | All requirements (unified timeline, phase dividers, ANSI stripping, live updates, navigation update) addressed |
| Accurate | PASS | All file paths verified; `getSessionsByTicket` exists, `sessions.routes.ts` uses `app.get` (corrected), `useSessionStarted` missing (corrected) |
| Commands valid | PASS | `pnpm test`, `pnpm typecheck`, `pnpm dev` are all correct per CLAUDE.md |
| YAGNI | PASS | Every task maps to a stated requirement |
| Minimal | PASS | Tasks are appropriately scoped; no redundancy |
| Not over-engineered | PASS | Reuses existing SSE infrastructure, existing store methods, existing query patterns |
| Key Decisions documented | PASS | 5 decisions with rationale in header |
| Context sections present | PASS | Purpose/Not In Scope/Gotchas present on all non-trivial tasks |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | CLEAN | 0 | All major sections present; every deliverable has a task; dependencies sketched; Key Decisions with rationale; header template followed |
| Feasibility | EDITED | 9 | Fixed agentType→agentSource throughout (StoredSession uses agentSource); removed unused date-fns import from PhaseDivider; added status derivation note to backend route (StoredSession has no status field) |
| Completeness | EDITED | 2 | Added PhaseHeader+IdleMarker tests to Task 5 test file; added useSessionStarted unit test step to Task 9 |
| Risk | EDITED | 2 | Fixed ViewSessionButton to preserve new-tab behaviour (was silently switching to same-tab navigate); added risk note that session:started may carry no JSON payload, causing useSessionStarted to silently never fire |
| Optimality | EDITED | 3 | Added Task 9 to Task 6 depends-on (Task 6 calls useSessionStarted which Task 9 creates); fixed double-fetch of lastSession log in TicketTranscriptPage sample code (cache log in loop, reuse for header); updated execution order diagram to show Task 9 → Task 6 dependency |
