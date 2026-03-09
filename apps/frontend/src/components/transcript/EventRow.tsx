import { useState } from 'react'
import { ChevronRight, ChevronDown, Zap, Check, X, Play, RotateCcw } from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'
import typescript from 'highlight.js/lib/languages/typescript'
import cpp from 'highlight.js/lib/languages/cpp'
import bash from 'highlight.js/lib/languages/bash'
import 'highlight.js/styles/github-dark.css'
import { cn, timeAgo } from '@/lib/utils'

// Register languages once at module load
hljs.registerLanguage('json', json)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('bash', bash)

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single content block within an assistant message */
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  /** text block */
  text?: string
  /** tool_use block */
  name?: string
  id?: string
  input?: Record<string, unknown>
  /** tool_result block */
  tool_use_id?: string
  content?: string | unknown[]
  is_error?: boolean
}

/** An assistant message carrying content blocks */
interface ClaudeMessage {
  content: ContentBlock[]
}

/**
 * The shape of entries returned by GET /api/sessions/:id.
 *
 * The session log stores Claude's native JSON streaming events (one per line)
 * with a `timestamp` field appended. Lines that fail JSON parsing are stored as
 * `{ type: "raw", content, timestamp }`.
 *
 * Supported event types:
 * - `session_start` / `session_end` — daemon lifecycle markers
 * - `system`  — Claude system events (e.g. task_started, task_progress)
 * - `assistant` — Claude's response turn; carries a `message` with content blocks
 * - `user`    — User turn; carries `message.content` with tool_result blocks
 * - `result`  — Final result summary from Claude
 * - `raw`     — Unparseable text line from PTY output
 */
export interface SessionLogEntry {
  type: string
  timestamp: string
  // session lifecycle
  meta?: Record<string, unknown>
  // raw fallback
  content?: string
  // system events
  subtype?: string
  description?: string
  // assistant / user turns
  message?: ClaudeMessage
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function highlight(code: string): string {
  try {
    return hljs.highlightAuto(code, ['json', 'typescript', 'cpp', 'bash']).value
  } catch {
    return escapeHtml(code)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function truncate(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function formatToolSummary(name: string, input: Record<string, unknown>): string {
  const val =
    input.path ??
    input.command ??
    input.file_path ??
    input.pattern ??
    Object.values(input)[0]
  const valStr =
    typeof val === 'string'
      ? val.split(/[/\\]/).pop() ?? val
      : JSON.stringify(val)
  return `${name} → ${truncate(String(valStr ?? ''), 60)}`
}

function blockContent(block: ContentBlock): string {
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) return JSON.stringify(block.content, null, 2)
  return ''
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

function CollapsibleRow({
  icon,
  summary,
  expandedContent,
  isCode,
  open,
  setOpen,
  timestamp,
  isError,
}: CollapsibleRowProps) {
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
        <span className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {rel}
        </span>
      </button>
      {open && (
        <div className="mx-4 mb-2 rounded overflow-auto max-h-96 text-xs">
          {isCode
            ? (
              <pre
                className="p-3 bg-zinc-900 rounded"
                dangerouslySetInnerHTML={{ __html: highlight(expandedContent) }}
              />
            )
            : (
              <p className="p-3 bg-zinc-900 rounded whitespace-pre-wrap text-text-secondary">
                {expandedContent}
              </p>
            )
          }
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface EventRowProps {
  entry: SessionLogEntry
}

export function EventRow({ entry }: EventRowProps) {
  const [open, setOpen] = useState(false)

  // ── Lifecycle markers — rendered elsewhere or suppressed ──────────────────
  if (entry.type === 'session_start' || entry.type === 'session_end') {
    return null
  }

  // ── Result summary — suppress (displayed separately in TranscriptPage) ────
  if (entry.type === 'result') {
    return null
  }

  // ── System: task started ─────────────────────────────────────────────────
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

  // ── System: task progress ────────────────────────────────────────────────
  if (entry.type === 'system' && entry.subtype === 'task_progress') {
    return (
      <div className="flex items-center gap-2 px-4 py-1 text-xs text-text-muted">
        <RotateCcw className="h-3 w-3 shrink-0" />
        <span className="truncate">{entry.description ?? ''}</span>
      </div>
    )
  }

  // ── System: any other subtype — suppress ─────────────────────────────────
  if (entry.type === 'system') {
    return null
  }

  // ── Assistant turn ───────────────────────────────────────────────────────
  if (entry.type === 'assistant' && entry.message) {
    const textBlocks = entry.message.content.filter(b => b.type === 'text')
    const toolBlocks = entry.message.content.filter(b => b.type === 'tool_use')

    if (textBlocks.length === 0 && toolBlocks.length === 0) return null

    return (
      <div className="space-y-0.5">
        {textBlocks.map((block, i) => (
          <CollapsibleRow
            key={`text-${i}`}
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
            key={`tool-${i}`}
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

  // ── User turn (tool results) ─────────────────────────────────────────────
  if (entry.type === 'user' && entry.message) {
    const resultBlocks = entry.message.content.filter(b => b.type === 'tool_result')

    if (resultBlocks.length === 0) return null

    return (
      <div className="space-y-0.5 pl-6">
        {resultBlocks.map((block, i) => {
          const isError = block.is_error === true
          const content = blockContent(block)
          return (
            <CollapsibleRow
              key={`result-${i}`}
              icon={
                isError
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

  // ── Raw / unrecognised ───────────────────────────────────────────────────
  if (entry.type === 'raw') {
    return (
      <div className="px-4 py-0.5 text-xs text-text-muted italic truncate">
        {entry.content}
      </div>
    )
  }

  return null
}
