# Session Transcript Viewer Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Replace the broken RemoteControlButton with a ViewSessionButton that opens a live, syntax-highlighted transcript of the running Claude agent session in a new browser tab.

**Architecture:** The daemon already writes all session events to a per-session JSONL log file and already exposes `GET /api/sessions/:id` (historical) and `GET /api/sessions/:id/live` (SSE). The frontend already receives `session:output` SSE events. This feature is a pure frontend UI surface over existing infrastructure — no new backend work required. The transcript page lives at `/transcript/:sessionId`, opens in a new tab with no app chrome, and merges historical log data with live SSE updates.

**Tech Stack:** React 19, TanStack Router (file-based), TanStack Query, highlight.js (already installed), Tailwind CSS, existing `session:output` SSE, existing `GET /api/sessions/:id` REST endpoint.

**Key Decisions:**
- **Route path `/transcript/$sessionId` not `/sessions/$sessionId`:** `sessions.tsx` already exists for the sessions list view; a new path avoids restructuring the router file tree.
- **No-chrome layout via `__root.tsx` path check:** TanStack Router wraps all routes in `__root.tsx`. Rather than a separate layout file, detect `/transcript/` prefix in the root and render `<Outlet />` directly — minimal change, zero new abstractions.
- **Use existing `GET /api/sessions/:id` for history:** Already implemented in daemon, already tested. No new endpoint needed.
- **Button uses existing RC endpoint for sessionId lookup:** `GET /api/tickets/:projectId/:ticketId/remote-control` already returns `sessionId`. Reuse it rather than adding a new endpoint.
- **Collapsed-by-default rows:** Tool calls and results are verbose (whole file reads). Show a one-line summary; expand on click. Keeps the page scannable.

---

## Task 1: Add `getSessionLog` and `getRemoteControl` to `api/client.ts`

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/api/client.ts`

**Purpose:** Expose two API calls the transcript page and button need. `getRemoteControl` already exists — verify it returns `sessionId`. `getSessionLog` is new.

**Not In Scope:** No new backend endpoints. Both routes already exist on the daemon. `GET /api/sessions/:id` calls `sessionService.getSessionLog()` which returns `Promise<SessionLogEntry[]>` — confirmed correct shape.

**Step 1: Check existing `getRemoteControl` in client.ts**

Read `apps/frontend/src/api/client.ts` and confirm `getRemoteControl(projectId, ticketId)` returns `{ sessionId, pending, url }`. If it doesn't include `sessionId` in the return type, add it.

**Step 2: Verify `getSessionLog` exists (already implemented)**

Read `apps/frontend/src/api/client.ts` and confirm `getSessionLog(sessionId)` already exists with an implementation matching:

```typescript
// Expected — already present around line 226
getSessionLog: async (sessionId: string): Promise<SessionLogEntry[]> => {
  const res = await fetch(`/api/sessions/${sessionId}`)
  if (!res.ok) throw new Error('Session not found')
  return res.json()
},
```

If it doesn't exist, add it. Then ensure `SessionLogEntry` is re-exported from `client.ts` so the new components can import it from `@/api/client`:

```typescript
// In apps/frontend/src/api/client.ts — add this re-export (one line)
// (SessionLogEntry is already imported from @potato-cannon/shared — just re-export it)
export type { SessionLogEntry } from '@potato-cannon/shared'
```

**Do NOT add a duplicate `interface SessionLogEntry`** — the type already exists in the shared package and is already imported by `client.ts`. Adding a second declaration of the same name would cause a TypeScript conflict.

**Step 3: Run typecheck**
```
cd apps/frontend && pnpm typecheck
```
Expected: no new errors.

**Step 4: Commit**
```
git add apps/frontend/src/api/client.ts
git commit -m "feat: add getSessionLog to api client"
```

---

## Task 2: Create `EventRow` component

**Depends on:** Task 1
**Complexity:** complex
**Files:**
- Create: `apps/frontend/src/components/transcript/EventRow.tsx`

**Purpose:** Renders a single log entry as a collapsible row. This is the core rendering logic for the transcript page.

**Not In Scope:** No virtualization — sessions are typically < 500 events. No editing or replying.

**Gotchas:** highlight.js needs to be imported with specific language modules to keep bundle size reasonable. The log contains Claude's JSON stream — `assistant` events have `message.content` arrays with `tool_use` or `text` blocks. Tool results come as `user` events with `tool_result` content.

```tsx
// apps/frontend/src/components/transcript/EventRow.tsx
import { useState } from 'react'
import { ChevronRight, ChevronDown, Zap, Check, X, Play, RotateCcw } from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'
import typescript from 'highlight.js/lib/languages/typescript'
import cpp from 'highlight.js/lib/languages/cpp'
import bash from 'highlight.js/lib/languages/bash'
import 'highlight.js/styles/github-dark.css'
import { cn, timeAgo } from '@/lib/utils'
import type { SessionLogEntry } from '@/api/client'

hljs.registerLanguage('json', json)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('bash', bash)

function highlight(code: string): string {
  try {
    return hljs.highlightAuto(code, ['json', 'typescript', 'cpp', 'bash']).value
  } catch {
    return code
  }
}

function truncate(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function formatToolSummary(name: string, input: Record<string, unknown>): string {
  // Show the most meaningful input param as the summary
  const val = input.path ?? input.command ?? input.file_path ?? input.pattern ?? Object.values(input)[0]
  const valStr = typeof val === 'string' ? val.split(/[\\/]/).pop() ?? val : JSON.stringify(val)
  return `${name} → ${truncate(String(valStr ?? ''), 60)}`
}

interface EventRowProps {
  entry: SessionLogEntry
}

export function EventRow({ entry }: EventRowProps) {
  const [open, setOpen] = useState(false)

  // session_start — not rendered as a row
  if (entry.type === 'session_start') return null

  // system: task_started — section header, always visible, not collapsible
  if (entry.type === 'system' && entry.subtype === 'task_started') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 mt-3 mb-1 border-l-2 border-accent">
        <Play className="h-3 w-3 text-accent shrink-0" />
        <span className="text-xs font-medium text-accent uppercase tracking-wide">
          {entry.description ?? 'Task started'}
        </span>
      </div>
    )
  }

  // system: task_progress — single collapsed line
  if (entry.type === 'system' && entry.subtype === 'task_progress') {
    return (
      <div className="flex items-center gap-2 px-4 py-1 text-xs text-text-muted">
        <RotateCcw className="h-3 w-3 shrink-0" />
        <span className="truncate">{entry.description ?? ''}</span>
      </div>
    )
  }

  // assistant: text content
  if (entry.type === 'assistant' && entry.message) {
    const textBlocks = entry.message.content.filter(b => b.type === 'text')
    const toolBlocks = entry.message.content.filter(b => b.type === 'tool_use')

    return (
      <div className="space-y-0.5">
        {textBlocks.map((block, i) => (
          <CollapsibleRow
            key={i}
            icon={<span className="text-[10px] font-bold text-violet-400">AI</span>}
            summary={truncate(block.text ?? '', 120)}
            expandedContent={block.text ?? ''}
            isCode={false}
            open={open}
            setOpen={setOpen}
            timestamp={entry.timestamp}
          />
        ))}
        {toolBlocks.map((block, i) => (
          <CollapsibleRow
            key={i}
            icon={<Zap className="h-3 w-3 text-yellow-400" />}
            summary={formatToolSummary(block.name ?? '', block.input ?? {})}
            expandedContent={JSON.stringify(block.input, null, 2)}
            isCode
            open={open}
            setOpen={setOpen}
            timestamp={entry.timestamp}
          />
        ))}
      </div>
    )
  }

  // user: tool_result — rendered as paired result, indented under tool_use
  // (handled by parent passing as pairedResult; standalone user messages are rare)
  if (entry.type === 'user' && entry.message) {
    const resultBlocks = entry.message.content.filter(b => b.type === 'tool_result')
    return (
      <div className="space-y-0.5 pl-6">
        {resultBlocks.map((block, i) => {
          const isError = block.is_error === true
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          return (
            <CollapsibleRow
              key={i}
              icon={isError
                ? <X className="h-3 w-3 text-red-400" />
                : <Check className="h-3 w-3 text-green-400" />
              }
              summary={truncate(content, 100)}
              expandedContent={content}
              isCode
              open={open}
              setOpen={setOpen}
              timestamp={entry.timestamp}
              isError={isError}
            />
          )
        })}
      </div>
    )
  }

  // raw — dimmed italic
  if (entry.type === 'raw') {
    return (
      <div className="px-4 py-0.5 text-xs text-text-muted italic truncate">
        {entry.content}
      </div>
    )
  }

  return null
}

interface CollapsibleRowProps {
  icon: React.ReactNode
  summary: string
  expandedContent: string
  isCode: boolean
  open: boolean
  setOpen: (v: boolean) => void
  timestamp: string
  isError?: boolean
}

function CollapsibleRow({ icon, summary, expandedContent, isCode, open, setOpen, timestamp, isError }: CollapsibleRowProps) {
  const rel = timeAgo(timestamp)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center gap-2 px-4 py-1.5 text-xs text-left hover:bg-white/5 transition-colors group',
          isError && 'text-red-300',
        )}
      >
        {open
          ? <ChevronDown className="h-3 w-3 text-text-muted shrink-0" />
          : <ChevronRight className="h-3 w-3 text-text-muted shrink-0" />
        }
        {icon}
        <span className="flex-1 truncate text-text-secondary">{summary}</span>
        <span className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0">{rel}</span>
      </button>
      {open && (
        <div className="mx-4 mb-2 rounded overflow-auto max-h-96 text-xs">
          {isCode
            ? <pre
                className="p-3 bg-zinc-900 rounded"
                dangerouslySetInnerHTML={{ __html: highlight(expandedContent) }}
              />
            : <p className="p-3 bg-zinc-900 rounded whitespace-pre-wrap text-text-secondary">{expandedContent}</p>
          }
        </div>
      )}
    </div>
  )
}

// timeAgo is imported from @/lib/utils — already exported there
```

**Step 1: Write the component** (code above)

**Step 2: Run typecheck**
```
cd apps/frontend && pnpm typecheck
```
Expected: no errors.

**Step 3: Commit**
```
git add apps/frontend/src/components/transcript/EventRow.tsx
git commit -m "feat: add EventRow component for transcript viewer"
```

---

## Task 3: Create `TranscriptPage` component

**Depends on:** Task 2
**Complexity:** complex
**Files:**
- Create: `apps/frontend/src/components/transcript/TranscriptPage.tsx`

**Purpose:** Full-page transcript view. Fetches historical log entries, subscribes to live SSE, renders EventRow list with auto-scroll.

**Gotchas:** The `session:output` SSE event payload is `{ sessionId, projectId, ticketId, event: logEntry }` — the actual log entry is nested under `event`. The live SSE endpoint (`GET /api/sessions/:id/live`) is per-session, but the global SSE (`/events`) also carries `session:output` events filtered by the hook. Use the existing `useSessionOutput` hook from `useSSE.ts` for simplicity.

```tsx
// apps/frontend/src/components/transcript/TranscriptPage.tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Circle, Copy } from 'lucide-react'
import { api } from '@/api/client'
import { EventRow } from './EventRow'
import { useSessionOutput, useSessionEnded } from '@/hooks/useSSE'
import { cn } from '@/lib/utils'
import type { SessionLogEntry } from '@/api/client'

interface TranscriptPageProps {
  sessionId: string
}

export function TranscriptPage({ sessionId }: TranscriptPageProps) {
  const [liveEntries, setLiveEntries] = useState<SessionLogEntry[]>([])
  const [isEnded, setIsEnded] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [totalTokens, setTotalTokens] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Fetch historical log
  const { data: historicalEntries = [], isLoading } = useQuery({
    queryKey: ['session-log', sessionId],
    queryFn: () => api.getSessionLog(sessionId),
    retry: false,
  })

  // Extract session metadata from first session_start entry
  const meta = historicalEntries.find(e => e.type === 'session_start')?.meta as Record<string, string> | undefined
  const ticketTitle = meta?.ticketTitle ?? sessionId
  const phase = meta?.phase ?? ''
  const agentType = meta?.agentType ?? ''

  // Subscribe to live events
  useSessionOutput(useCallback((data: { sessionId: string; event: SessionLogEntry }) => {
    if (data.sessionId !== sessionId) return
    setLiveEntries(prev => [...prev, data.event])
    // Track token usage
    const tokens = (data.event as { usage?: { total_tokens?: number } }).usage?.total_tokens
    if (tokens) setTotalTokens(tokens)
  }, [sessionId]))

  // Detect session end
  useSessionEnded(useCallback((data: { sessionId: string }) => {
    if (data.sessionId === sessionId) setIsEnded(true)
  }, [sessionId]))

  // Auto-scroll (fires on both historical load and live updates)
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [liveEntries, historicalEntries, autoScroll])

  // Detect manual scroll-up to pause auto-scroll
  const onScroll = () => {
    const el = scrollContainerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(atBottom)
  }

  const allEntries = [...historicalEntries, ...liveEntries]

  const copyTranscript = () => {
    const text = allEntries
      .filter(e => e.type !== 'session_start')
      .map(e => {
        if (e.type === 'assistant' && e.message) {
          return e.message.content
            .map(b => b.type === 'text' ? b.text : `[Tool: ${b.name}]`)
            .join('\n')
        }
        if (e.type === 'raw') return e.content
        return null
      })
      .filter(Boolean)
      .join('\n\n')
    navigator.clipboard.writeText(text ?? '')
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-text-primary">
      {/* Fixed header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-zinc-950/80 backdrop-blur shrink-0">
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold truncate">{ticketTitle}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            {phase && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-text-muted font-mono uppercase">
                {phase}{agentType ? ` · ${agentType}` : ''}
              </span>
            )}
            {totalTokens > 0 && (
              <span className="text-[10px] text-text-muted">{totalTokens.toLocaleString()} tokens</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {isEnded ? (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <Circle className="h-2 w-2 fill-zinc-500 text-zinc-500" />
              Ended
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <Circle className="h-2 w-2 fill-green-400 text-green-400 animate-pulse" />
              Live
            </span>
          )}
          <button
            onClick={copyTranscript}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
        </div>
      </header>

      {/* Scrollable event list */}
      <div
        ref={scrollContainerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto py-2"
      >
        {isLoading && (
          <div className="flex justify-center py-12 text-text-muted text-sm">Loading…</div>
        )}
        {allEntries.map((entry, i) => (
          <EventRow key={i} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom pill */}
      {!autoScroll && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <button
            onClick={() => {
              setAutoScroll(true)
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs',
              'bg-zinc-800 text-text-secondary hover:bg-zinc-700 transition-colors shadow-lg',
            )}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Jump to bottom
          </button>
        </div>
      )}
    </div>
  )
}
```

**Step 1: Check `useSessionEnded` exists in `useSSE.ts`**

Run: `grep -n "useSessionEnded\|useSessionOutput" apps/frontend/src/hooks/useSSE.ts`

If `useSessionEnded` doesn't exist, add it following the same pattern as `useSessionOutput`.

**Step 2: Write the component** (code above)

**Step 3: Run typecheck**
```
cd apps/frontend && pnpm typecheck
```

**Step 4: Commit**
```
git add apps/frontend/src/components/transcript/
git commit -m "feat: add TranscriptPage component"
```

---

## Task 4: Create transcript route and update root layout

**Depends on:** Task 3
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/routes/transcript/$sessionId.tsx`
- Modify: `apps/frontend/src/routes/__root.tsx`
- Modify: `apps/frontend/src/routeTree.gen.ts` (auto-generated by TanStack Router — run `pnpm dev:frontend` briefly to trigger regeneration, or run codegen manually)

**Purpose:** Wire the TranscriptPage into the router and skip app chrome for `/transcript/*` routes.

**Gotchas:** TanStack Router auto-generates `routeTree.gen.ts` — do NOT manually edit it. Run the dev server or `pnpm exec tsr generate` to regenerate. The root layout check must use `useLocation()` which is already imported in `__root.tsx`.

**Step 1: Create route file**

```tsx
// apps/frontend/src/routes/transcript/$sessionId.tsx
import { createFileRoute } from '@tanstack/react-router'
import { TranscriptPage } from '@/components/transcript/TranscriptPage'

export const Route = createFileRoute('/transcript/$sessionId')({
  component: TranscriptPageRoute,
})

function TranscriptPageRoute() {
  const { sessionId } = Route.useParams()
  return <TranscriptPage sessionId={sessionId} />
}
```

**Step 2: Update `__root.tsx` to skip chrome for transcript routes**

In `RootLayout`, add AFTER all existing hook calls (`useProjects`, `useAppStore`, `useCurrentProject`) and BEFORE the `return (...)` JSX. Do NOT place this before hook calls — it would violate React's rules of hooks.

```tsx
// IMPORTANT: Place AFTER all useProjects/useAppStore/useCurrentProject calls,
// immediately before the return (...) JSX block:
const location = useLocation()  // useLocation is already imported on line 1
const isTranscript = location.pathname.startsWith('/transcript/')
if (isTranscript) return <Outlet />
```

**Step 3: Regenerate route tree**
```
cd apps/frontend && pnpm exec tsr generate
```
Or start the dev server briefly (`pnpm dev:frontend`) to auto-regenerate.

**Step 4: Run typecheck**
```
cd apps/frontend && pnpm typecheck
```

**Step 5: Commit**
```
git add apps/frontend/src/routes/transcript/ apps/frontend/src/routes/__root.tsx apps/frontend/src/routeTree.gen.ts
git commit -m "feat: add transcript route, skip chrome for /transcript/*"
```

---

## Task 5: Replace RemoteControlButton with ViewSessionButton

**Depends on:** Task 4
**Complexity:** simple
**Files:**
- Create: `apps/frontend/src/components/ticket-detail/ViewSessionButton.tsx`
- Modify: `apps/frontend/src/components/ticket-detail/ActivityTab.tsx`
- Modify (or delete): `apps/frontend/src/components/ticket-detail/RemoteControlButton.tsx`
- Modify (or delete): `apps/frontend/src/components/ticket-detail/RemoteControlButton.test.tsx`
- Modify: `apps/daemon/src/services/session/session.service.ts` (remove debug logs, step 4)

**Purpose:** Simple link button that opens `/transcript/:sessionId` in a new tab. Replaces the broken RC state machine.

**Not In Scope:** Do not remove RC daemon endpoints in this task — leave them in place. Dead code cleanup is a separate concern. Note: `ActivityTab` has no inline RC state — only the button import on line 13 and usage on line 246. The import swap is the complete change needed.

```tsx
// apps/frontend/src/components/ticket-detail/ViewSessionButton.tsx
import { Monitor } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

interface ViewSessionButtonProps {
  projectId: string
  ticketId: string
  hasActiveSession: boolean
}

export function ViewSessionButton({ projectId, ticketId, hasActiveSession }: ViewSessionButtonProps) {
  // Fetch sessionId so we can build the transcript URL
  const { data } = useQuery({
    queryKey: ['active-session', projectId, ticketId],
    queryFn: () => api.getRemoteControl(projectId, ticketId),
    enabled: hasActiveSession,
    staleTime: 10_000,
  })

  const sessionId = data?.sessionId

  if (!hasActiveSession || !sessionId) {
    return (
      <button
        disabled
        className="flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border text-text-muted cursor-not-allowed opacity-50"
      >
        <Monitor className="h-4 w-4" />
        View Session
      </button>
    )
  }

  return (
    <a
      href={`/transcript/${sessionId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
    >
      <Monitor className="h-4 w-4" />
      View Session
    </a>
  )
}
```

**Step 1: Write ViewSessionButton** (code above)

**Step 2: Update ActivityTab import**

In `ActivityTab.tsx`, replace:
```tsx
import { RemoteControlButton } from './RemoteControlButton'
```
with:
```tsx
import { ViewSessionButton } from './ViewSessionButton'
```

And replace the `<RemoteControlButton ... />` usage:
```tsx
<ViewSessionButton
  projectId={projectId}
  ticketId={ticketId}
  hasActiveSession={hasActiveSession}
/>
```

**Step 3: Delete old RC files** (or keep but leave unused — cleaner to delete)
```
git rm apps/frontend/src/components/ticket-detail/RemoteControlButton.tsx
git rm apps/frontend/src/components/ticket-detail/RemoteControlButton.test.tsx
```

**Step 4: Remove debug RC logging from session.service.ts**

In `apps/daemon/src/services/session/session.service.ts`, remove the three temporary debug log lines added during RC investigation:
```typescript
console.log(`[remoteControl] PTY data while pending (${sessionId}): ${JSON.stringify(stripped.slice(0, 200))}`);
console.log(`[remoteControl] URL found for session ${sessionId}: ${url}`);
console.log(`[remoteControl] Sending command to PTY session ${sessionId}: ${JSON.stringify(command)}`);
```

**Step 5: Run typecheck and tests**
```
cd apps/frontend && pnpm typecheck && pnpm test
cd apps/daemon && pnpm typecheck
```
Expected: typecheck passes, no failing tests (RC test file removed).

**Step 6: Commit**
```
git add -A apps/frontend/src/components/ticket-detail/ apps/daemon/src/services/session/session.service.ts
git commit -m "feat: replace RemoteControlButton with ViewSessionButton, remove RC debug logs"
```

---

## Testing

End-to-end smoke test (manual, no automation needed):
1. Start a ticket with an active session
2. Open ticket detail — confirm "View Session" button is visible and enabled
3. Click button — confirm a new browser tab opens at `/transcript/:sessionId`
4. Confirm the transcript page shows historical events from the log
5. Confirm new events appear live as the session runs
6. Scroll up — confirm "Jump to bottom" pill appears
7. Click pill — confirm auto-scroll resumes
8. Expand a tool call row — confirm syntax highlighting renders
9. Session ends — confirm "Ended" badge replaces "Live" indicator
10. Click "Copy" — confirm readable transcript in clipboard

---

## Verification Record

| Pass | Verdict | Issues Found | Fixed |
|------|---------|--------------|-------|
| Plan Verification Checklist | WARN | `getSessionLog` already exists — step said "Add" not "Verify"; Task 6 too granular | ✅ Step updated to "Verify (already exists)"; Task 6 merged into Task 5 |
| Draft | WARN | Dead `pairedResult`/`indentResult` prop pair never used; `session.service.ts` missing from Task 5 Files | ✅ Props removed; file added to Files section |
| Feasibility | WARN | `SessionLogEntry` type would be duplicated — already imported from shared | ✅ Replaced with `export type { SessionLogEntry }` re-export |
| Completeness | WARN | Req 3 endpoint shape unconfirmed; Req 11 inline RC state check | ✅ Confirmed endpoint returns `SessionLogEntry[]`; confirmed `ActivityTab` has no inline RC state; notes added |
| Risk | WARN | Rules of Hooks violation risk in `__root.tsx`; auto-scroll misses historical load | ✅ Explicit "after all hooks" placement instruction added; `historicalEntries` added to `useEffect` dep array |
| Optimality | WARN | `timeAgo` duplicates existing `@/lib/utils` export | ✅ Removed local definition; import from `@/lib/utils` |

**Overall: PASS** — All WARN items resolved. Plan is ready for implementation.
