import stripAnsi from 'strip-ansi'
import type { SessionLogContentBlock, SessionLogEntry } from '@potato-cannon/shared'

export interface TranscriptPresentationOptions {
  showSystemEvents: boolean
  showRawEvents: boolean
}

export interface AttemptCard {
  kind: 'attempt'
  id: string
  startedAt?: string
  assistantTextBlocks: string[]
  toolUses: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
  toolResults: Array<{
    toolUseId?: string
    content: string
    isError: boolean
  }>
  status: 'success' | 'error' | 'in-progress'
  hasErrors: boolean
  summary: string
}

export interface SystemMarker {
  kind: 'system'
  id: string
  timestamp?: string
  level: 'info' | 'warning' | 'error'
  label: string
  details?: string
}

export interface RawMarker {
  kind: 'raw'
  id: string
  timestamp?: string
  content: string
}

export type TranscriptRenderableItem = AttemptCard | SystemMarker | RawMarker

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function cleanText(text: string): string {
  return stripAnsi(text).trim()
}

function blockContent(block: SessionLogContentBlock): string {
  if (typeof block.content === 'string') return cleanText(block.content)
  if (Array.isArray(block.content)) return JSON.stringify(block.content, null, 2)
  return ''
}

function createAttempt(index: number, timestamp?: string): AttemptCard {
  return {
    kind: 'attempt',
    id: `attempt-${index}`,
    startedAt: timestamp,
    assistantTextBlocks: [],
    toolUses: [],
    toolResults: [],
    status: 'in-progress',
    hasErrors: false,
    summary: 'Assistant activity',
  }
}

function updateAttemptDerivedState(attempt: AttemptCard): AttemptCard {
  const hasErrors = attempt.toolResults.some((r) => r.isError)
  const hasPendingTools = attempt.toolUses.length > attempt.toolResults.length
  const summaryText = attempt.assistantTextBlocks.find(Boolean)
  const summaryTool = attempt.toolUses[0]?.name

  attempt.hasErrors = hasErrors
  attempt.status = hasErrors ? 'error' : hasPendingTools ? 'in-progress' : 'success'
  if (summaryText) {
    attempt.summary = truncate(summaryText, 140)
  } else if (summaryTool) {
    attempt.summary = `Tool activity: ${summaryTool}`
  } else if (attempt.toolResults.length > 0) {
    attempt.summary = 'Tool results received'
  }

  return attempt
}

function toSystemMarker(entry: SessionLogEntry, index: number): SystemMarker {
  const subtype = entry.subtype ?? 'event'
  const isWarn = subtype.includes('limit')
  const isErr = subtype.includes('error') || subtype.includes('fail')
  return {
    kind: 'system',
    id: `system-${index}`,
    timestamp: entry.timestamp,
    level: isErr ? 'error' : isWarn ? 'warning' : 'info',
    label: subtype.replace(/_/g, ' '),
    details: entry.description,
  }
}

function shouldHideSystemEntry(entry: SessionLogEntry): boolean {
  if (entry.subtype === 'init') return true
  return true
}

export function buildTranscriptRenderableItems(
  entries: SessionLogEntry[],
  options: TranscriptPresentationOptions,
): TranscriptRenderableItem[] {
  const renderable: TranscriptRenderableItem[] = []
  let currentAttempt: AttemptCard | null = null
  let attemptCount = 0

  const flushAttempt = () => {
    if (!currentAttempt) return
    renderable.push(updateAttemptDerivedState(currentAttempt))
    currentAttempt = null
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry.type === 'session_start' || entry.type === 'session_end' || entry.type === 'result') {
      continue
    }

    if (entry.type === 'assistant' && entry.message) {
      const textBlocks = entry.message.content.filter((b) => b.type === 'text')
      const toolBlocks = entry.message.content.filter((b) => b.type === 'tool_use')
      const startsNewNarrativeTurn = textBlocks.length > 0

      if (
        startsNewNarrativeTurn &&
        currentAttempt &&
        (currentAttempt.assistantTextBlocks.length > 0 || currentAttempt.toolUses.length > 0 || currentAttempt.toolResults.length > 0)
      ) {
        flushAttempt()
      }
      if (!currentAttempt) {
        currentAttempt = createAttempt(attemptCount, entry.timestamp)
        attemptCount += 1
      }

      for (const block of textBlocks) {
        const text = cleanText(block.text ?? '')
        if (text) currentAttempt.assistantTextBlocks.push(text)
      }
      for (const block of toolBlocks) {
        currentAttempt.toolUses.push({
          id: block.id ?? `${currentAttempt.id}-tool-${currentAttempt.toolUses.length}`,
          name: block.name ?? 'Unknown',
          input: block.input ?? {},
        })
      }
      continue
    }

    if (entry.type === 'user' && entry.message) {
      const resultBlocks = entry.message.content.filter((b) => b.type === 'tool_result')
      if (resultBlocks.length === 0) continue

      if (!currentAttempt) {
        currentAttempt = createAttempt(attemptCount, entry.timestamp)
        attemptCount += 1
      }

      for (const block of resultBlocks) {
        currentAttempt.toolResults.push({
          toolUseId: block.tool_use_id,
          content: blockContent(block),
          isError: block.is_error === true,
        })
      }
      continue
    }

    if (entry.type === 'system' || entry.type === 'rate_limit_event') {
      flushAttempt()
      if (!options.showSystemEvents && shouldHideSystemEntry(entry)) {
        continue
      }
      renderable.push(toSystemMarker(entry, i))
      continue
    }

    if (entry.type === 'raw') {
      const cleaned = cleanText(entry.content ?? '')
      if (!cleaned) continue
      if (!options.showRawEvents) continue
      flushAttempt()
      renderable.push({
        kind: 'raw',
        id: `raw-${i}`,
        timestamp: entry.timestamp,
        content: cleaned,
      })
      continue
    }
  }

  flushAttempt()
  return renderable
}
