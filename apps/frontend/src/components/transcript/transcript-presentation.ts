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
