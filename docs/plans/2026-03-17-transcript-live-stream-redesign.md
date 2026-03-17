# Transcript Live Stream Redesign

**Date:** 2026-03-17
**Status:** Design approved
**Scope:** Frontend only — no backend changes required

## Problem

The current transcript view groups events into collapsed "attempt cards" that hide the actual content. Expanding them reveals tool names and truncated results, but not Claude's reasoning or thinking. It's designed for after-the-fact review summaries, not for watching an agent work in real-time.

## Goal

Replace the transcript view with a **text-first event stream** — like watching Claude Code in a terminal or the VSCode plugin. Claude's thinking and reasoning text is the primary content. Inline widgets enrich specific events (tool calls, bash output, file reads) without replacing the text.

## Design

### Core Model

A single scrollable stream of rendered events, read from JSONL (historical) or SSE (live). Every event from Claude's stream-json output maps to a renderer based on its type. No grouping into "attempt cards" — events render in chronological order.

Auto-scroll pinned to bottom while live. Scroll up to detach, "Jump to bottom" button appears.

### Content Hierarchy

1. **Assistant text** — primary content. Claude's reasoning and messages rendered as markdown.
2. **Inline widgets** — inserted at the point they occurred (tool badges, results, bash output, file previews).
3. **System markers** — phase transitions, task events. Thin dividers with labels.

### Widget Specifications

#### Assistant Text Blocks
- Rendered as markdown
- Normal text color, standard font size

#### Thinking/Extended Thinking Blocks
- Muted color (e.g., `text-zinc-400`), slightly smaller or italic
- Visually distinct but still readable
- These are the "Claude is reasoning" moments

#### Tool Call Badges
- Single-line compact bar: icon + tool name + primary argument
- Example: `Read src/services/session.service.ts`
- Muted background (`bg-zinc-800/50`), rounded, small text
- Not expandable — just a marker

#### Tool Result Blocks
- Appears directly after its tool call badge
- Collapsible with toggle — expanded by default during live, collapsed for historical if >20 lines
- Syntax highlighting for code/JSON
- Error results get red left-border accent
- Max-height with scroll for 500+ line outputs

#### Bash Command + Output
- Special case of tool call/result, styled like a terminal
- Dark background, monospace font
- Command as prompt line (`$ pnpm test`), output below
- Same collapsible behavior as tool results

#### File Read Previews
- When tool is `Read` and result has file content
- File path as header, content with line numbers and syntax highlighting
- Truncated to ~30 lines with "show more" expansion

#### System Markers
- Thin divider line with centered label: `── Phase: Build ──`
- Timestamp on right side
- Minimal visual weight

### Layout & Styling

- Full-width single column, max-width ~800px, centered
- Dark background matching app theme
- Comfortable line spacing — reading experience
- Widgets have subtle background differentiation
- No indentation nesting, everything flows vertically

### Multi-Session Tickets

- Each session gets a header divider: agent name, session ID (abbreviated), start time
- All sessions render in one continuous stream, chronologically

### Sticky Header

- Ticket title + current phase badge + live/ended indicator
- Stays at top while scrolling

### No Filtering Toggles

Everything renders. If it came out of Claude, it's in the stream. Filtering can be added later if needed.

## Data Flow

No new backend work. The daemon already emits `session:output` SSE events and stores full JSONL logs.

- **Live:** Subscribe to `useSessionOutput()` hook, append events as they arrive
- **Historical:** Fetch from `GET /api/sessions/:id`, render full array
- Same component handles both — it just maps an array of events to renderers

### Event-to-Renderer Mapping

```
event.type === 'assistant' + text content block       → AssistantTextBlock
event.type === 'assistant' + thinking content block    → ThinkingBlock
event.type === 'assistant' + tool_use content block    → ToolCallBadge
event.type === 'tool_result'                           → ToolResultBlock
  - tool_name === 'Bash'                               → BashBlock
  - tool_name === 'Read'                               → FileReadPreview
event.type === 'system' + phase/task subtype           → SystemMarker
```

## Implementation

### Files to Modify/Replace

- **Replace:** `apps/frontend/src/components/transcript/TicketTranscriptPage.tsx` — rebuild as flat event stream
- **Replace:** `apps/frontend/src/components/transcript/TranscriptAttemptCard.tsx` — remove card grouping
- **Simplify:** `apps/frontend/src/components/transcript/transcript-presentation.ts` — from "group into attempts" to "map event → renderer type"
- **Keep:** `apps/frontend/src/components/transcript/log-normalizer.ts` — still need ANSI stripping

### New Components

```
apps/frontend/src/components/transcript/renderers/
├── AssistantTextBlock.tsx
├── ThinkingBlock.tsx
├── ToolCallBadge.tsx
├── ToolResultBlock.tsx
├── BashBlock.tsx
├── FileReadPreview.tsx
└── SystemMarker.tsx
```

## Out of Scope

- Code diff cards (future enhancement)
- Filtering/search within transcript
- Backend changes
