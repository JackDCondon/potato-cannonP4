# Transcript Live Stream Redesign — Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Replace the card-based transcript view with a text-first event stream that shows Claude's thinking, reasoning, and tool usage inline — like watching Claude Code in VSCode or terminal.

**Architecture:** Flatten the event-to-render pipeline. Instead of grouping events into "attempt cards", each `SessionLogEntry` content block maps directly to a renderer component. The page remains a single scrollable stream with SSE for live and REST for historical, using the same component for both.

**Tech Stack:** React 19, Tailwind CSS 4, `marked` + `highlight.js` for markdown, Lucide icons, existing SSE hooks.

**Key Decisions:**
- **Flat stream vs card grouping:** Flat stream — cards hide the text that makes the view useful. Each content block renders independently.
- **Presentation layer rewrite vs modify:** Full rewrite of `transcript-presentation.ts` — the attempt-grouping algorithm is the core problem. New output type is a flat array of render items, one per content block.
- **Markdown rendering:** Use existing `renderMarkdown()` from `@/lib/markdown.ts` with `dangerouslySetInnerHTML` — already has highlight.js and DOMPurify configured.
- **No new dependencies:** Everything needed (marked, highlight.js, strip-ansi, lucide-react) is already installed.
- **Collapsible without Radix:** Simple `useState` toggle with CSS `max-height` transition — no need to add `@radix-ui/react-collapsible` for this.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `apps/frontend/src/components/transcript/transcript-presentation.ts` | Map `SessionLogEntry[]` to flat `StreamItem[]` array (one item per content block) | Rewrite |
| `apps/frontend/src/components/transcript/transcript-presentation.test.ts` | Tests for new flat mapping logic | Rewrite |
| `apps/frontend/src/components/transcript/renderers/AssistantTextBlock.tsx` | Render assistant text as markdown | Create |
| `apps/frontend/src/components/transcript/renderers/ThinkingBlock.tsx` | Render thinking/extended_thinking blocks in muted style | Create |
| `apps/frontend/src/components/transcript/renderers/ToolCallBadge.tsx` | Compact single-line tool invocation marker | Create |
| `apps/frontend/src/components/transcript/renderers/ToolResultBlock.tsx` | Collapsible tool result with syntax highlighting | Create |
| `apps/frontend/src/components/transcript/renderers/BashBlock.tsx` | Terminal-styled command + output block | Create |
| `apps/frontend/src/components/transcript/renderers/FileReadPreview.tsx` | File content preview with line numbers | Create |
| `apps/frontend/src/components/transcript/renderers/SystemMarker.tsx` | Thin divider for system events | Create |
| `apps/frontend/src/components/transcript/renderers/index.ts` | Barrel export for all renderers | Create |
| `apps/frontend/src/components/transcript/StreamItemRenderer.tsx` | Switch component mapping `StreamItem` → renderer | Create |
| `apps/frontend/src/components/transcript/TicketTranscriptPage.tsx` | Simplified page: fetch, normalize, flatten, render stream | Rewrite |
| `apps/frontend/src/components/transcript/TicketTranscriptPage.test.tsx` | Tests for new page component | Rewrite |
| `apps/frontend/src/components/transcript/TranscriptAttemptCard.tsx` | Old card-based renderer — no longer imported | Delete |
| `apps/frontend/src/components/transcript/log-normalizer.ts` | PTY chunk reconstruction — unchanged | Keep |
| `apps/frontend/src/components/transcript/log-normalizer.test.ts` | Normalizer tests — unchanged | Keep |
| `apps/frontend/src/components/transcript/PhaseHeader.tsx` | Sticky header — unchanged | Keep |
| `apps/frontend/src/components/transcript/PhaseDivider.tsx` | Session boundary divider — unchanged | Keep |
| `apps/frontend/src/components/transcript/IdleMarker.tsx` | End-of-phase marker — unchanged | Keep |

---

## Task 1: Rewrite transcript-presentation.ts — new flat StreamItem types and mapper

**Depends on:** None
**Complexity:** standard
**Files:**
- Rewrite: `apps/frontend/src/components/transcript/transcript-presentation.ts`
- Rewrite: `apps/frontend/src/components/transcript/transcript-presentation.test.ts`

**Purpose:** Replace the attempt-grouping algorithm with a flat mapper that produces one `StreamItem` per content block. This is the foundation — every renderer depends on these types.

**Not In Scope:** Rendering components. This task only produces the data types and mapping function.

**Step 1: Write the failing tests**

Replace `transcript-presentation.test.ts` with tests for the new flat mapping:

```typescript
import { describe, it, expect } from 'vitest'
import { flattenToStreamItems, type StreamItem } from './transcript-presentation'
import type { SessionLogEntry } from '@potato-cannon/shared'

describe('flattenToStreamItems', () => {
  it('maps assistant text blocks to AssistantText items', () => {
    const entries: SessionLogEntry[] = [{
      type: 'assistant',
      timestamp: '2026-03-10T10:00:00Z',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    }]
    const items = flattenToStreamItems(entries)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'assistant-text',
      text: 'Hello world',
      timestamp: '2026-03-10T10:00:00Z',
    })
  })

  it('maps tool_use blocks to ToolCall items', () => {
    const entries: SessionLogEntry[] = [{
      type: 'assistant',
      timestamp: '2026-03-10T10:00:00Z',
      message: { content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/src/foo.ts' },
      }] },
    }]
    const items = flattenToStreamItems(entries)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'tool-call',
      toolName: 'Read',
      toolInput: { file_path: '/src/foo.ts' },
    })
  })

  it('maps tool_result blocks to ToolResult items', () => {
    const entries: SessionLogEntry[] = [{
      type: 'user',
      timestamp: '2026-03-10T10:00:01Z',
      message: { content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'file contents here',
        is_error: false,
      }] },
    }]
    const items = flattenToStreamItems(entries)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'tool-result',
      toolUseId: 'tool-1',
      content: 'file contents here',
      isError: false,
    })
  })

  it('maps Bash tool calls with special kind', () => {
    const entries: SessionLogEntry[] = [{
      type: 'assistant',
      timestamp: '2026-03-10T10:00:00Z',
      message: { content: [{
        type: 'tool_use',
        id: 'tool-2',
        name: 'Bash',
        input: { command: 'pnpm test' },
      }] },
    }]
    const items = flattenToStreamItems(entries)
    expect(items[0]).toMatchObject({ kind: 'tool-call', toolName: 'Bash' })
  })

  it('maps system events to system-marker items', () => {
    const entries: SessionLogEntry[] = [{
      type: 'system',
      subtype: 'task_started',
      description: 'Starting task 1',
      timestamp: '2026-03-10T10:00:00Z',
    }]
    const items = flattenToStreamItems(entries)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'system-marker',
      label: 'task started',
      details: 'Starting task 1',
    })
  })

  it('skips session_start, session_end, and result entries', () => {
    const entries: SessionLogEntry[] = [
      { type: 'session_start', timestamp: '2026-03-10T10:00:00Z' },
      { type: 'session_end', timestamp: '2026-03-10T10:00:01Z' },
      { type: 'result', timestamp: '2026-03-10T10:00:02Z' },
    ]
    const items = flattenToStreamItems(entries)
    expect(items).toHaveLength(0)
  })

  it('handles mixed content blocks in a single assistant entry', () => {
    const entries: SessionLogEntry[] = [{
      type: 'assistant',
      timestamp: '2026-03-10T10:00:00Z',
      message: { content: [
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/foo.ts' } },
      ] },
    }]
    const items = flattenToStreamItems(entries)
    expect(items).toHaveLength(2)
    expect(items[0].kind).toBe('assistant-text')
    expect(items[1].kind).toBe('tool-call')
  })

  it('maps thinking content blocks to ThinkingItem', () => {
    const entries: SessionLogEntry[] = [{
      type: 'assistant',
      timestamp: '2026-03-10T10:00:00Z',
      message: { content: [{
        type: 'thinking' as any,
        thinking: 'Let me reason about this...',
      }] },
    }]
    const items = flattenToStreamItems(entries)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'thinking',
      text: 'Let me reason about this...',
    })
  })

  it('maps raw entries to raw items', () => {
    const entries: SessionLogEntry[] = [{
      type: 'raw',
      timestamp: '2026-03-10T10:00:00Z',
      content: 'some raw output',
    }]
    const items = flattenToStreamItems(entries)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'raw', content: 'some raw output' })
  })

  it('derives tool-result toolName from preceding tool-call', () => {
    const entries: SessionLogEntry[] = [
      {
        type: 'assistant',
        timestamp: '2026-03-10T10:00:00Z',
        message: { content: [{
          type: 'tool_use', id: 'tool-1', name: 'Read',
          input: { file_path: '/foo.ts' },
        }] },
      },
      {
        type: 'user',
        timestamp: '2026-03-10T10:00:01Z',
        message: { content: [{
          type: 'tool_result', tool_use_id: 'tool-1',
          content: 'file data', is_error: false,
        }] },
      },
    ]
    const items = flattenToStreamItems(entries)
    expect(items[1]).toMatchObject({
      kind: 'tool-result',
      toolName: 'Read',
      toolUseId: 'tool-1',
    })
  })
})
```

**Step 2: Run tests to verify failure**

```bash
cd apps/frontend && pnpm test -- --run src/components/transcript/transcript-presentation.test.ts
```

Expected: FAIL (flattenToStreamItems doesn't exist)

**Step 3: Write the implementation**

Replace `transcript-presentation.ts`:

```typescript
import stripAnsi from 'strip-ansi'
import type { SessionLogContentBlock, SessionLogEntry } from '@potato-cannon/shared'

// ─── Stream Item Types ──────────────────────────────────────────────────────

export interface AssistantTextItem {
  kind: 'assistant-text'
  id: string
  timestamp?: string
  text: string
}

export interface ThinkingItem {
  kind: 'thinking'
  id: string
  timestamp?: string
  text: string
}

export interface ToolCallItem {
  kind: 'tool-call'
  id: string
  timestamp?: string
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
}

export interface ToolResultItem {
  kind: 'tool-result'
  id: string
  timestamp?: string
  toolUseId?: string
  toolName?: string
  content: string
  isError: boolean
}

export interface SystemMarkerItem {
  kind: 'system-marker'
  id: string
  timestamp?: string
  level: 'info' | 'warning' | 'error'
  label: string
  details?: string
}

export interface RawItem {
  kind: 'raw'
  id: string
  timestamp?: string
  content: string
}

export type StreamItem =
  | AssistantTextItem
  | ThinkingItem
  | ToolCallItem
  | ToolResultItem
  | SystemMarkerItem
  | RawItem

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanText(text: string): string {
  return stripAnsi(text).trim()
}

function blockContent(block: SessionLogContentBlock): string {
  if (typeof block.content === 'string') return cleanText(block.content)
  if (Array.isArray(block.content)) return JSON.stringify(block.content, null, 2)
  return ''
}

// ─── Mapper ─────────────────────────────────────────────────────────────────

const SKIP_TYPES = new Set(['session_start', 'session_end', 'result'])

export function flattenToStreamItems(entries: SessionLogEntry[]): StreamItem[] {
  const items: StreamItem[] = []
  let counter = 0
  // Track tool_use id → tool name so we can label results
  const toolNameMap = new Map<string, string>()

  for (const entry of entries) {
    if (SKIP_TYPES.has(entry.type)) continue

    // ── Assistant / User turns with content blocks ──
    if ((entry.type === 'assistant' || entry.type === 'user') && entry.message) {
      for (const block of entry.message.content) {
        const id = `stream-${counter++}`

        if (block.type === 'text') {
          const text = cleanText(block.text ?? '')
          if (!text) continue
          items.push({
            kind: 'assistant-text',
            id,
            timestamp: entry.timestamp,
            text,
          })
          continue
        }

        // Handle thinking/extended_thinking blocks (cast needed — shared types
        // don't include 'thinking' yet but Claude streams them)
        if ((block as any).type === 'thinking' || (block as any).type === 'extended_thinking') {
          const text = cleanText((block as any).thinking ?? (block as any).text ?? '')
          if (!text) continue
          items.push({
            kind: 'thinking',
            id,
            timestamp: entry.timestamp,
            text,
          })
          continue
        }

        if (block.type === 'tool_use') {
          const toolName = block.name ?? 'Unknown'
          const toolUseId = block.id ?? id
          toolNameMap.set(toolUseId, toolName)
          items.push({
            kind: 'tool-call',
            id,
            timestamp: entry.timestamp,
            toolUseId,
            toolName,
            toolInput: block.input ?? {},
          })
          continue
        }

        if (block.type === 'tool_result') {
          const toolUseId = block.tool_use_id
          items.push({
            kind: 'tool-result',
            id,
            timestamp: entry.timestamp,
            toolUseId,
            toolName: toolUseId ? toolNameMap.get(toolUseId) : undefined,
            content: blockContent(block),
            isError: block.is_error === true,
          })
          continue
        }
      }
      continue
    }

    // ── System events ──
    if (entry.type === 'system' || entry.type === 'rate_limit_event') {
      const subtype = entry.subtype ?? 'event'
      const isWarn = subtype.includes('limit')
      const isErr = subtype.includes('error') || subtype.includes('fail')
      items.push({
        kind: 'system-marker',
        id: `stream-${counter++}`,
        timestamp: entry.timestamp,
        level: isErr ? 'error' : isWarn ? 'warning' : 'info',
        label: subtype.replace(/_/g, ' '),
        details: entry.description,
      })
      continue
    }

    // ── Raw entries ──
    if (entry.type === 'raw') {
      const content = cleanText(entry.content ?? '')
      if (!content) continue
      items.push({
        kind: 'raw',
        id: `stream-${counter++}`,
        timestamp: entry.timestamp,
        content,
      })
      continue
    }
  }

  return items
}
```

**Step 4: Run tests to verify pass**

```bash
cd apps/frontend && pnpm test -- --run src/components/transcript/transcript-presentation.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/frontend/src/components/transcript/transcript-presentation.ts apps/frontend/src/components/transcript/transcript-presentation.test.ts
git commit -m "refactor(transcript): rewrite presentation layer as flat stream item mapper"
```

---

## Task 2: Create renderer components

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/components/transcript/renderers/AssistantTextBlock.tsx`
- Create: `apps/frontend/src/components/transcript/renderers/ThinkingBlock.tsx`
- Create: `apps/frontend/src/components/transcript/renderers/ToolCallBadge.tsx`
- Create: `apps/frontend/src/components/transcript/renderers/ToolResultBlock.tsx`
- Create: `apps/frontend/src/components/transcript/renderers/BashBlock.tsx`
- Create: `apps/frontend/src/components/transcript/renderers/FileReadPreview.tsx`
- Create: `apps/frontend/src/components/transcript/renderers/SystemMarker.tsx`
- Create: `apps/frontend/src/components/transcript/renderers/index.ts`

**Purpose:** Build the individual visual components that render each stream item type.

**Gotchas:**
- `renderMarkdown()` returns sanitized HTML string — must use `dangerouslySetInnerHTML`
- `highlight.js` is already configured with json, typescript, cpp, bash languages
- Use existing Tailwind theme variables (`text-text-primary`, `bg-bg-tertiary`, `text-accent-yellow`, etc.) — not raw zinc colors
- `toolPrimaryArg()` helper from the old `TranscriptAttemptCard.tsx` should be moved here

**Step 1: Create all renderer files**

`renderers/AssistantTextBlock.tsx`:
```tsx
import { renderMarkdown } from '@/lib/markdown'
import type { AssistantTextItem } from '../transcript-presentation'

export function AssistantTextBlock({ item }: { item: AssistantTextItem }) {
  const html = renderMarkdown(item.text)
  return (
    <div
      className="prose prose-invert prose-sm max-w-none px-1 py-1 text-text-primary leading-relaxed [&_pre]:bg-bg-tertiary [&_pre]:border [&_pre]:border-border/50 [&_pre]:rounded [&_code]:text-xs"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
```

`renderers/ThinkingBlock.tsx`:
```tsx
import type { ThinkingItem } from '../transcript-presentation'

export function ThinkingBlock({ item }: { item: ThinkingItem }) {
  return (
    <div className="px-1 py-1 text-sm text-text-muted italic leading-relaxed whitespace-pre-wrap">
      {item.text}
    </div>
  )
}
```

`renderers/ToolCallBadge.tsx`:
```tsx
import { Wrench } from 'lucide-react'
import type { ToolCallItem } from '../transcript-presentation'

function toolPrimaryArg(name: string, input: Record<string, unknown>): string {
  const fileTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit']
  if (fileTools.includes(name)) return String(input.file_path ?? input.path ?? '')
  if (name === 'Bash') return String(input.command ?? '').slice(0, 80)
  if (name === 'Grep' || name === 'Glob') return String(input.pattern ?? '').slice(0, 80)
  return String(Object.values(input)[0] ?? '').slice(0, 80)
}

export function ToolCallBadge({ item }: { item: ToolCallItem }) {
  const arg = toolPrimaryArg(item.toolName, item.toolInput)
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 my-1 rounded bg-bg-tertiary/40 border border-border/30 text-xs">
      <Wrench className="h-3 w-3 text-accent-yellow shrink-0" />
      <span className="font-mono font-medium text-accent-yellow">{item.toolName}</span>
      {arg && <span className="text-text-muted truncate">{arg}</span>}
    </div>
  )
}
```

`renderers/ToolResultBlock.tsx`:
```tsx
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolResultItem } from '../transcript-presentation'

interface Props {
  item: ToolResultItem
  defaultExpanded?: boolean
}

export function ToolResultBlock({ item, defaultExpanded }: Props) {
  const lineCount = item.content.split('\n').length
  const isLong = lineCount > 20
  const [expanded, setExpanded] = useState(defaultExpanded ?? !isLong)

  return (
    <div className={cn(
      'my-1 rounded border text-xs',
      item.isError
        ? 'border-accent-red/30 bg-accent-red/5'
        : 'border-border/30 bg-bg-tertiary/20',
    )}>
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-1 px-2 py-1 text-left text-text-muted hover:text-text-secondary transition-colors"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" />
          : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span>{item.toolName ? `${item.toolName} result` : 'Tool result'}</span>
        {isLong && !expanded && (
          <span className="ml-auto text-text-muted">{lineCount} lines</span>
        )}
      </button>
      {expanded && (
        <pre className={cn(
          'px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto border-t',
          item.isError ? 'text-accent-red border-accent-red/20' : 'text-text-secondary border-border/20',
        )}>
          {item.content || '(empty result)'}
        </pre>
      )}
    </div>
  )
}
```

`renderers/BashBlock.tsx`:
```tsx
import { useState } from 'react'
import { Terminal, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolCallItem, ToolResultItem } from '../transcript-presentation'

interface Props {
  call: ToolCallItem
  result?: ToolResultItem
  defaultExpanded?: boolean
}

export function BashBlock({ call, result, defaultExpanded }: Props) {
  const command = String(call.toolInput.command ?? '')
  const output = result?.content ?? ''
  const lineCount = output.split('\n').length
  const isLong = lineCount > 20
  const [expanded, setExpanded] = useState(defaultExpanded ?? !isLong)

  return (
    <div className={cn(
      'my-1 rounded border font-mono text-xs',
      result?.isError
        ? 'border-accent-red/30 bg-zinc-900/80'
        : 'border-border/30 bg-zinc-900/80',
    )}>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Terminal className="h-3 w-3 text-accent-green shrink-0" />
        <span className="text-accent-green">$</span>
        <span className="text-text-primary truncate">{command}</span>
      </div>
      {output && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            className="w-full flex items-center gap-1 px-2 py-0.5 text-left text-text-muted hover:text-text-secondary transition-colors border-t border-border/20"
          >
            {expanded
              ? <ChevronDown className="h-3 w-3 shrink-0" />
              : <ChevronRight className="h-3 w-3 shrink-0" />}
            <span>output</span>
            {isLong && !expanded && (
              <span className="ml-auto">{lineCount} lines</span>
            )}
          </button>
          {expanded && (
            <pre className={cn(
              'px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto border-t border-border/20',
              result?.isError ? 'text-accent-red' : 'text-text-muted',
            )}>
              {output}
            </pre>
          )}
        </>
      )}
    </div>
  )
}
```

`renderers/FileReadPreview.tsx`:
```tsx
import { useState } from 'react'
import { FileText, ChevronDown, ChevronRight } from 'lucide-react'
import type { ToolCallItem, ToolResultItem } from '../transcript-presentation'

interface Props {
  call: ToolCallItem
  result?: ToolResultItem
  defaultExpanded?: boolean
}

export function FileReadPreview({ call, result, defaultExpanded }: Props) {
  const filePath = String(call.toolInput.file_path ?? call.toolInput.path ?? '')
  const content = result?.content ?? ''
  const lines = content.split('\n')
  const isLong = lines.length > 30
  const [expanded, setExpanded] = useState(defaultExpanded ?? !isLong)
  const [showAll, setShowAll] = useState(false)

  const displayLines = !showAll && isLong ? lines.slice(0, 30) : lines

  return (
    <div className="my-1 rounded border border-border/30 bg-bg-tertiary/20 text-xs">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-text-secondary hover:text-text-primary transition-colors"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" />
          : <ChevronRight className="h-3 w-3 shrink-0" />}
        <FileText className="h-3 w-3 shrink-0 text-accent" />
        <span className="font-mono truncate">{filePath}</span>
        <span className="ml-auto text-text-muted">{lines.length} lines</span>
      </button>
      {expanded && (
        <div className="border-t border-border/20">
          <pre className="px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto text-text-secondary">
            {displayLines.map((line, i) => (
              <div key={i} className="flex">
                <span className="select-none text-text-muted/50 w-8 text-right pr-2 shrink-0">{i + 1}</span>
                <span>{line}</span>
              </div>
            ))}
          </pre>
          {isLong && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full px-2 py-1 text-center text-accent text-xs hover:underline border-t border-border/20"
            >
              Show all {lines.length} lines
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

`renderers/SystemMarker.tsx`:
```tsx
import { cn, formatTime } from '@/lib/utils'
import type { SystemMarkerItem } from '../transcript-presentation'

export function SystemMarker({ item }: { item: SystemMarkerItem }) {
  const tone =
    item.level === 'error'
      ? 'text-accent-red border-accent-red/20'
      : item.level === 'warning'
        ? 'text-accent-yellow border-accent-yellow/20'
        : 'text-text-muted border-border/30'

  return (
    <div className={cn('flex items-center gap-2 my-3 text-xs', tone)}>
      <div className="flex-1 border-t border-current/20" />
      <span className="uppercase tracking-wide font-medium whitespace-nowrap">
        {item.label}
      </span>
      {item.details && (
        <span className="text-text-muted">{item.details}</span>
      )}
      {item.timestamp && (
        <span className="text-text-muted">{formatTime(item.timestamp)}</span>
      )}
      <div className="flex-1 border-t border-current/20" />
    </div>
  )
}
```

`renderers/index.ts`:
```typescript
export { AssistantTextBlock } from './AssistantTextBlock'
export { ThinkingBlock } from './ThinkingBlock'
export { ToolCallBadge } from './ToolCallBadge'
export { ToolResultBlock } from './ToolResultBlock'
export { BashBlock } from './BashBlock'
export { FileReadPreview } from './FileReadPreview'
export { SystemMarker } from './SystemMarker'
```

**Step 2: Verify the frontend compiles**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: PASS (no type errors)

**Step 3: Commit**

```bash
git add apps/frontend/src/components/transcript/renderers/
git commit -m "feat(transcript): add stream item renderer components"
```

---

## Task 3: Create StreamItemRenderer switch component

**Depends on:** Task 1, Task 2
**Complexity:** simple
**Files:**
- Create: `apps/frontend/src/components/transcript/StreamItemRenderer.tsx`

**Purpose:** Single component that takes a `StreamItem` and renders the correct widget. Handles the special case of Bash and Read tool calls needing their results paired.

**Gotchas:** Bash and FileRead are compound widgets — they need both the tool-call and the following tool-result. The renderer receives a flat stream, so it uses a lookahead pattern: the page pre-pairs them before passing to this component.

**Step 1: Write the component**

```tsx
import type { StreamItem, ToolCallItem, ToolResultItem } from './transcript-presentation'
import {
  AssistantTextBlock,
  ThinkingBlock,
  ToolCallBadge,
  ToolResultBlock,
  BashBlock,
  FileReadPreview,
  SystemMarker,
} from './renderers'

interface Props {
  item: StreamItem
  /** For tool-call items, the paired result (if next item is a matching result) */
  pairedResult?: ToolResultItem
  /** Whether tool results should default to expanded */
  defaultExpanded?: boolean
}

export function StreamItemRenderer({ item, pairedResult, defaultExpanded }: Props) {
  switch (item.kind) {
    case 'assistant-text':
      return <AssistantTextBlock item={item} />

    case 'thinking':
      return <ThinkingBlock item={item} />

    case 'tool-call': {
      // Bash and Read get compound widgets
      if (item.toolName === 'Bash') {
        return <BashBlock call={item} result={pairedResult} defaultExpanded={defaultExpanded} />
      }
      if (item.toolName === 'Read') {
        return <FileReadPreview call={item} result={pairedResult} defaultExpanded={defaultExpanded} />
      }
      return <ToolCallBadge item={item} />
    }

    case 'tool-result':
      // Standalone result (not paired with a Bash/Read call above)
      return <ToolResultBlock item={item} defaultExpanded={defaultExpanded} />

    case 'system-marker':
      return <SystemMarker item={item} />

    case 'raw':
      return (
        <pre className="px-2 py-1 my-1 text-xs text-text-muted whitespace-pre-wrap font-mono">
          {item.content}
        </pre>
      )

    default:
      return null
  }
}
```

**Step 2: Verify compilation**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: PASS

**Step 3: Commit**

```bash
git add apps/frontend/src/components/transcript/StreamItemRenderer.tsx
git commit -m "feat(transcript): add StreamItemRenderer switch component"
```

---

## Task 4: Rewrite TicketTranscriptPage to use stream rendering

**Depends on:** Task 1, Task 3
**Complexity:** standard
**Files:**
- Rewrite: `apps/frontend/src/components/transcript/TicketTranscriptPage.tsx`
- Delete: `apps/frontend/src/components/transcript/TranscriptAttemptCard.tsx`

**Purpose:** Replace the card-based rendering with the flat stream. Keep the same data-fetching pattern (load historical via REST, append live via SSE), but render through `StreamItemRenderer` instead of `TranscriptAttemptCard`.

**Not In Scope:** Changing SSE hooks, data fetching, or the normalizer.

**Step 1: Rewrite TicketTranscriptPage.tsx**

```tsx
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTicketSessions, useProjects, useTicket } from '@/hooks/queries'
import { useSessionOutput, useSessionEnded, useSessionStarted } from '@/hooks/useSSE'
import { api } from '@/api/client'
import type { SessionLogEntry, SessionMeta } from '@potato-cannon/shared'
import { PhaseHeader } from './PhaseHeader'
import { PhaseDivider } from './PhaseDivider'
import { IdleMarker } from './IdleMarker'
import { normalizeTranscriptEntries } from './log-normalizer'
import { flattenToStreamItems, type StreamItem, type ToolResultItem } from './transcript-presentation'
import { StreamItemRenderer } from './StreamItemRenderer'

// ─── Types ───────────────────────────────────────────────────────────────────

type TimelineEntry =
  | { kind: 'phase-divider'; session: SessionMeta }
  | { kind: 'entry'; sessionId: string; entry: SessionLogEntry }
  | { kind: 'idle'; phase: string; timestamp: string }

type RenderTimelineEntry =
  | { kind: 'phase-divider'; session: SessionMeta }
  | { kind: 'idle'; phase: string; timestamp: string }
  | { kind: 'stream-item'; sessionId: string; item: StreamItem }

interface Props {
  projectId: string
  ticketId: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function phaseColor(
  swimlaneColors: Record<string, string> | undefined,
  phase: string | undefined,
): string | undefined {
  if (!swimlaneColors || !phase) return undefined
  return swimlaneColors[phase]
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TicketTranscriptPage({ projectId, ticketId }: Props) {
  const queryClient = useQueryClient()
  const { data: sessions = [] } = useTicketSessions(projectId, ticketId)
  const { data: projects } = useProjects()
  const { data: ticket } = useTicket(projectId, ticketId)

  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [liveEntries, setLiveEntries] = useState<TimelineEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)

  const scrollRef = useRef<HTMLDivElement>(null)
  const knownSessionIds = useRef<Set<string>>(new Set())

  // ── Derived state ──────────────────────────────────────────────────────────

  const project = useMemo(
    () => projects?.find((p) => p.id === projectId),
    [projects, projectId],
  )
  const swimlaneColors = project?.swimlaneColors

  const lastSession = sessions[sessions.length - 1] as SessionMeta | undefined
  const isLive = lastSession?.status === 'running'
  const currentPhase = lastSession?.phase ?? ticket?.phase

  // ── Load historical session logs ───────────────────────────────────────────

  useEffect(() => {
    if (sessions.length === 0) {
      setTimeline([])
      return
    }

    let cancelled = false
    const ids = new Set(sessions.map((s) => s.id))
    knownSessionIds.current = ids

    async function loadAll() {
      const built: TimelineEntry[] = []
      for (const session of sessions) {
        built.push({ kind: 'phase-divider', session })
        try {
          const log = await api.getSessionLog(session.id)
          const normalizedLog = normalizeTranscriptEntries(log)
          for (const entry of normalizedLog) {
            built.push({ kind: 'entry', sessionId: session.id, entry })
          }
        } catch {
          // Session log may not be available yet
        }
      }

      const last = sessions[sessions.length - 1]
      if (last && last.status !== 'running') {
        built.push({
          kind: 'idle',
          phase: last.phase ?? 'Unknown',
          timestamp: last.endedAt ?? last.startedAt,
        })
      }

      if (!cancelled) {
        setTimeline(built)
        setLiveEntries([])
      }
    }

    loadAll()
    return () => { cancelled = true }
  }, [sessions])

  // ── SSE handlers ───────────────────────────────────────────────────────────

  useSessionStarted(
    useCallback(
      (data: { sessionId: string; ticketId?: string }) => {
        if (data.ticketId === ticketId) {
          queryClient.invalidateQueries({
            queryKey: ['ticketSessions', projectId, ticketId],
          })
        }
      },
      [queryClient, projectId, ticketId],
    ),
  )

  useSessionOutput(
    useCallback(
      (data: Record<string, unknown>) => {
        const sid = data.sessionId as string | undefined
        if (!sid || !knownSessionIds.current.has(sid)) return

        const event = data.event as SessionLogEntry | undefined
        if (!event) return
        const normalized = normalizeTranscriptEntries([event])
        if (normalized.length === 0) return

        setLiveEntries((prev) => [
          ...prev,
          ...normalized.map((entry) => ({ kind: 'entry' as const, sessionId: sid, entry })),
        ])
      },
      [],
    ),
  )

  useSessionEnded(
    useCallback(
      (data: Record<string, unknown>) => {
        if (data.ticketId === ticketId) {
          queryClient.invalidateQueries({
            queryKey: ['ticketSessions', projectId, ticketId],
          })
        }
      },
      [queryClient, projectId, ticketId],
    ),
  )

  // ── Build render timeline ──────────────────────────────────────────────────

  const combinedTimeline = useMemo(
    () => [...timeline, ...liveEntries],
    [timeline, liveEntries],
  )

  const renderTimeline = useMemo(() => {
    const rendered: RenderTimelineEntry[] = []
    let pendingSessionId: string | null = null
    let pendingEntries: SessionLogEntry[] = []

    const flushPending = () => {
      if (!pendingSessionId || pendingEntries.length === 0) {
        pendingSessionId = null
        pendingEntries = []
        return
      }
      const items = flattenToStreamItems(pendingEntries)
      for (const item of items) {
        rendered.push({ kind: 'stream-item', sessionId: pendingSessionId, item })
      }
      pendingSessionId = null
      pendingEntries = []
    }

    for (const item of combinedTimeline) {
      if (item.kind === 'entry') {
        if (!pendingSessionId) {
          pendingSessionId = item.sessionId
        } else if (pendingSessionId !== item.sessionId) {
          flushPending()
          pendingSessionId = item.sessionId
        }
        pendingEntries.push(item.entry)
        continue
      }

      flushPending()
      rendered.push(item)
    }

    flushPending()
    return rendered
  }, [combinedTimeline])

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [renderTimeline, autoScroll])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setAutoScroll(atBottom)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      <PhaseHeader
        ticketTitle={ticket?.title ?? ticketId}
        phase={currentPhase}
        agentSource={lastSession?.agentSource}
        isLive={isLive}
        color={phaseColor(swimlaneColors, currentPhase)}
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-[800px] mx-auto px-4 py-4">
          {renderTimeline.map((item, i) => {
            switch (item.kind) {
              case 'phase-divider':
                return (
                  <PhaseDivider
                    key={`divider-${item.session.id}`}
                    phase={item.session.phase ?? 'Unknown'}
                    agentSource={item.session.agentSource}
                    timestamp={item.session.startedAt}
                    color={phaseColor(swimlaneColors, item.session.phase)}
                  />
                )
              case 'idle':
                return (
                  <IdleMarker
                    key={`idle-${item.phase}`}
                    phase={item.phase}
                    timestamp={item.timestamp}
                  />
                )
              case 'stream-item': {
                const streamItem = item.item
                // Pair Bash/Read tool-calls with their matching result (scan forward by toolUseId)
                let pairedResult: ToolResultItem | undefined
                if (streamItem.kind === 'tool-call' && (streamItem.toolName === 'Bash' || streamItem.toolName === 'Read')) {
                  for (let j = i + 1; j < renderTimeline.length && j < i + 20; j++) {
                    const candidate = renderTimeline[j]
                    if (candidate?.kind === 'stream-item' && candidate.item.kind === 'tool-result' && candidate.item.toolUseId === streamItem.toolUseId) {
                      pairedResult = candidate.item
                      break
                    }
                  }
                }
                // Skip tool-results that were already paired with a Bash/Read call above
                if (streamItem.kind === 'tool-result' && streamItem.toolUseId) {
                  const isPaired = renderTimeline.slice(Math.max(0, i - 20), i).some(
                    (prev) => prev.kind === 'stream-item' && prev.item.kind === 'tool-call' &&
                      (prev.item.toolName === 'Bash' || prev.item.toolName === 'Read') &&
                      prev.item.toolUseId === streamItem.toolUseId
                  )
                  if (isPaired) return null
                }
                return (
                  <StreamItemRenderer
                    key={`${item.sessionId}-${streamItem.id}`}
                    item={streamItem}
                    pairedResult={pairedResult}
                    defaultExpanded={isLive}
                  />
                )
              }
            }
          })}
        </div>
      </div>

      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true)
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
          }}
          className="fixed bottom-4 right-4 bg-zinc-700 hover:bg-zinc-600 text-white text-xs px-3 py-1.5 rounded-full shadow-lg"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  )
}
```

**Step 2: Delete the old attempt card component**

```bash
rm apps/frontend/src/components/transcript/TranscriptAttemptCard.tsx
```

**Step 3: Verify compilation**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: PASS

**Step 4: Commit**

```bash
git add apps/frontend/src/components/transcript/TicketTranscriptPage.tsx
git rm apps/frontend/src/components/transcript/TranscriptAttemptCard.tsx
git commit -m "feat(transcript): replace card-based view with text-first stream"
```

---

## Task 5: Rewrite page tests

**Depends on:** Task 4
**Complexity:** simple
**Files:**
- Rewrite: `apps/frontend/src/components/transcript/TicketTranscriptPage.test.tsx`

**Purpose:** Update tests to validate the new stream rendering instead of attempt cards.

**Step 1: Rewrite the test file**

```typescript
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TicketTranscriptPage } from './TicketTranscriptPage'
import type { SessionMeta, SessionLogEntry } from '@potato-cannon/shared'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSessions: SessionMeta[] = [
  {
    id: 'session-1',
    ticketId: 'ticket-1',
    phase: 'Refinement',
    agentSource: 'refine-agent',
    status: 'completed',
    startedAt: '2026-03-10T10:00:00Z',
    endedAt: '2026-03-10T10:15:00Z',
  },
  {
    id: 'session-2',
    ticketId: 'ticket-1',
    phase: 'Build',
    agentSource: 'build-agent',
    status: 'completed',
    startedAt: '2026-03-10T10:20:00Z',
    endedAt: '2026-03-10T10:40:00Z',
  },
]

const makeLogEntries = (sessionId: string): SessionLogEntry[] => [
  {
    type: 'assistant',
    timestamp: '2026-03-10T10:01:00Z',
    message: {
      content: [{ type: 'text', text: `Output from ${sessionId}` }],
    },
  },
]

vi.mock('@/hooks/queries', () => ({
  useTicketSessions: vi.fn(() => ({
    data: mockSessions,
    isLoading: false,
    error: null,
  })),
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        swimlaneColors: { Refinement: '#3b82f6', Build: '#10b981' },
      },
    ],
  }),
  useTicket: () => ({
    data: { id: 'ticket-1', title: 'Test Ticket', phase: 'Build' },
  }),
}))

vi.mock('@/api/client', () => ({
  api: {
    getSessionLog: vi.fn((sessionId: string) =>
      Promise.resolve(makeLogEntries(sessionId)),
    ),
  },
}))

vi.mock('@/hooks/useSSE', () => ({
  useSessionOutput: vi.fn(),
  useSessionEnded: vi.fn(),
  useSessionStarted: vi.fn(),
}))

vi.mock('./PhaseDivider', () => ({
  PhaseDivider: ({ phase }: { phase: string }) => (
    <div data-testid="phase-divider">{phase} Phase</div>
  ),
}))

vi.mock('./PhaseHeader', () => ({
  PhaseHeader: ({
    ticketTitle,
    phase,
    isLive,
  }: {
    ticketTitle: string
    phase?: string
    isLive: boolean
  }) => (
    <div data-testid="phase-header">
      {ticketTitle} | {phase} | {isLive ? 'Live' : 'Ended'}
    </div>
  ),
}))

vi.mock('./IdleMarker', () => ({
  IdleMarker: ({ phase }: { phase: string }) => (
    <div data-testid="idle-marker">{phase} phase complete, waiting for next phase</div>
  ),
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function renderPage(overrides?: { projectId?: string; ticketId?: string }) {
  const qc = createQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <TicketTranscriptPage
        projectId={overrides?.projectId ?? 'project-1'}
        ticketId={overrides?.ticketId ?? 'ticket-1'}
      />
    </QueryClientProvider>,
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TicketTranscriptPage', () => {
  it('renders phase dividers between sessions', async () => {
    renderPage()
    await waitFor(() => {
      const dividers = screen.getAllByTestId('phase-divider')
      expect(dividers).toHaveLength(2)
      expect(dividers[0]).toHaveTextContent('Refinement Phase')
      expect(dividers[1]).toHaveTextContent('Build Phase')
    })
  })

  it('renders assistant text as stream content', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Output from session-1')).toBeInTheDocument()
      expect(screen.getByText('Output from session-2')).toBeInTheDocument()
    })
  })

  it('shows idle marker after last completed session', async () => {
    renderPage()
    await waitFor(() => {
      const marker = screen.getByTestId('idle-marker')
      expect(marker).toHaveTextContent('waiting for next phase')
    })
  })

  it('renders PhaseHeader with ticket info', async () => {
    renderPage()
    await waitFor(() => {
      const header = screen.getByTestId('phase-header')
      expect(header).toHaveTextContent('Test Ticket')
      expect(header).toHaveTextContent('Build')
    })
  })

  it('renders no content when sessions have no log entries', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getSessionLog).mockResolvedValue([])
    renderPage()
    await waitFor(() => {
      expect(screen.queryByText(/Output from/)).not.toBeInTheDocument()
    })
  })

  it('renders tool call badges inline', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getSessionLog).mockResolvedValue([
      {
        type: 'assistant',
        timestamp: '2026-03-10T10:01:00Z',
        message: {
          content: [
            { type: 'text', text: 'Let me check that file.' },
            { type: 'tool_use', id: 'tool-1', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      },
    ] as SessionLogEntry[])

    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Let me check that file.')).toBeInTheDocument()
      expect(screen.getByText('Grep')).toBeInTheDocument()
    })
  })

  it('renders reconstructed content from raw JSON chunks', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getSessionLog).mockImplementation((sessionId: string) => {
      if (sessionId !== 'session-1') return Promise.resolve([])
      return Promise.resolve([
        {
          type: 'raw',
          timestamp: '2026-03-10T10:01:00Z',
          content:
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello',
        },
        {
          type: 'raw',
          timestamp: '2026-03-10T10:01:01Z',
          content: ' from raw"}]}}',
        },
      ] as SessionLogEntry[])
    })

    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Hello from raw')).toBeInTheDocument()
    })
  })
})
```

**Step 2: Run tests**

```bash
cd apps/frontend && pnpm test -- --run src/components/transcript/TicketTranscriptPage.test.tsx
```

Expected: PASS

**Step 3: Commit**

```bash
git add apps/frontend/src/components/transcript/TicketTranscriptPage.test.tsx
git commit -m "test(transcript): update page tests for stream-based rendering"
```

---

## Task 6: Remove old EventRow.tsx and clean up dead imports

**Depends on:** Task 4
**Complexity:** simple
**Files:**
- Delete: `apps/frontend/src/components/transcript/EventRow.tsx`
- Delete: `apps/frontend/src/components/transcript/EventRow.test.tsx`
- Modify: `apps/frontend/src/components/transcript/TranscriptPage.tsx` (if it imports EventRow — check if still used)

**Purpose:** Clean up dead code from the old card-based renderer.

**Gotchas:** `TranscriptPage.tsx` is the legacy single-session view. Check if it's still referenced by any route. If so, leave it but update its imports. If orphaned, delete it.

**Step 1: Check if TranscriptPage.tsx is referenced**

```bash
cd apps/frontend && grep -r "TranscriptPage" src/routes/ src/components/ --include="*.tsx" --include="*.ts" -l
```

If `TranscriptPage.tsx` is referenced by a route, update it to use the new stream rendering. If not, delete it.

**Step 2: Delete dead files**

```bash
rm apps/frontend/src/components/transcript/EventRow.tsx
rm apps/frontend/src/components/transcript/EventRow.test.tsx
```

**Step 3: Verify compilation**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: PASS

**Step 4: Commit**

```bash
git rm apps/frontend/src/components/transcript/EventRow.tsx apps/frontend/src/components/transcript/EventRow.test.tsx
git commit -m "chore(transcript): remove unused EventRow and legacy card components"
```

---

## Task 7: Run full test suite and verify

**Depends on:** Task 5, Task 6
**Complexity:** simple
**Files:** None (verification only)

**Purpose:** Ensure nothing is broken across the entire frontend.

**Step 1: Run all frontend tests**

```bash
cd apps/frontend && pnpm test -- --run
```

Expected: PASS

**Step 2: Run typecheck**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: PASS

**Step 3: Visual verification**

Start the dev server and navigate to a ticket transcript page to confirm:
- Assistant text renders as readable markdown
- Tool call badges appear inline
- Tool results are collapsible
- Bash commands show terminal styling
- System markers render as thin dividers
- Auto-scroll works during live sessions
- Historical sessions load and render correctly

```bash
pnpm dev
```

Navigate to: `http://localhost:5173/transcript/ticket/GAM-2?projectId=<projectId>` (replace with actual ticket/project IDs)

---

## Verification Record

| Pass | Verdict | Key Findings |
|------|---------|-------------|
| Plan Verification Checklist | PASS | All paths verified, commands valid, YAGNI respected |
| Draft | PASS_WITH_NOTES | Minor: merge duplicate `@/lib/utils` imports in SystemMarker — **fixed** |
| Feasibility | PASS_WITH_NOTES | ThinkingItem dead code (shared types lack `thinking`) — **fixed with `as any` cast** |
| Completeness | FAIL → PASS | Two gaps fixed: (1) added thinking block handler to mapper, (2) added line numbers to FileReadPreview |
| Risk | PASS_WITH_NOTES | Multi-tool pairing could miss non-adjacent results — **fixed with forward scan by toolUseId**; `TranscriptPage.tsx` confirmed orphaned, should be deleted in Task 6 |
| Optimality | PASS_WITH_NOTES | Collapsible pattern duplicated across BashBlock/FileReadPreview/ToolResultBlock — acceptable given distinct visual styles |

**Fixes applied after verification:**
1. Added `thinking`/`extended_thinking` handler to `flattenToStreamItems` mapper (Task 1)
2. Added test case for thinking blocks (Task 1)
3. Added line numbers to `FileReadPreview` component (Task 2)
4. Merged duplicate `@/lib/utils` imports in `SystemMarker` (Task 2)
5. Replaced i+1 lookahead with forward scan (up to 20 items) for Bash/Read result pairing (Task 4)
