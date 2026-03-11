import stripAnsi from 'strip-ansi'
import type { SessionLogEntry } from '@potato-cannon/shared'

const NOISY_KEYS = new Set(['signature'])
const KNOWN_ENTRY_TYPES = new Set([
  'session_start',
  'session_end',
  'assistant',
  'user',
  'system',
  'rate_limit_event',
  'result',
  'raw',
  'output',
])

function stripNoisyFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripNoisyFields(item)) as T
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const input = value as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(input)) {
    if (NOISY_KEYS.has(key)) continue
    cleaned[key] = stripNoisyFields(nested)
  }
  return cleaned as T
}

function cleanRawContent(content: string): string {
  const withoutAnsi = stripAnsi(content)
  // Drop all control bytes from PTY chunks (including CR) before JSON reconstruction.
  return withoutAnsi.replace(/[\u0000-\u001F\u007F]/g, '')
}

function hasNonWhitespace(text: string): boolean {
  return text.replace(/\s/g, '').length > 0
}

function looksLikeJsonChunk(text: string): boolean {
  return text.includes('{') || text.includes('}') || text.includes('"type"')
}

function findBalancedJsonObjectEnd(buffer: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < buffer.length; i += 1) {
    const char = buffer[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

function consumeJsonObjects(buffer: string): {
  objects: Array<Record<string, unknown>>
  remainder: string
} {
  const objects: Array<Record<string, unknown>> = []
  let working = buffer

  while (true) {
    const objectStart = working.indexOf('{')
    if (objectStart === -1) {
      return { objects, remainder: '' }
    }

    if (objectStart > 0) {
      working = working.slice(objectStart)
    }

    const objectEnd = findBalancedJsonObjectEnd(working, 0)
    if (objectEnd === -1) {
      return { objects, remainder: working }
    }

    const candidate = working.slice(0, objectEnd + 1)
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      objects.push(parsed)
      working = working.slice(objectEnd + 1)
    } catch {
      // Drop one char and keep scanning to recover from malformed fragments.
      working = working.slice(1)
    }
  }
}

function toSessionLogEntry(
  parsed: Record<string, unknown>,
  fallbackTimestamp?: string,
): SessionLogEntry | null {
  if (typeof parsed.type !== 'string' || !KNOWN_ENTRY_TYPES.has(parsed.type)) return null
  const cleanedUnknown = stripNoisyFields(parsed) as Record<string, unknown>
  if (typeof cleanedUnknown.type !== 'string') return null
  const cleaned = cleanedUnknown as unknown as SessionLogEntry
  if (!cleaned.timestamp && fallbackTimestamp) {
    cleaned.timestamp = fallbackTimestamp
  }
  return cleaned
}

export function normalizeTranscriptEntries(
  entries: SessionLogEntry[],
): SessionLogEntry[] {
  const normalized: SessionLogEntry[] = []
  let buffer = ''
  let bufferTimestamp: string | undefined

  for (const entry of entries) {
    if (entry.type !== 'raw') {
      normalized.push(stripNoisyFields(entry))
      continue
    }

    const raw = cleanRawContent(entry.content ?? '')
    if (!hasNonWhitespace(raw)) {
      continue
    }
    if (!buffer && !looksLikeJsonChunk(raw)) {
      normalized.push({
        type: 'raw',
        timestamp: entry.timestamp,
        content: raw,
      })
      continue
    }

    if (!bufferTimestamp) {
      bufferTimestamp = entry.timestamp
    }
    buffer += raw

    const { objects, remainder } = consumeJsonObjects(buffer)
    buffer = remainder

    for (const parsed of objects) {
      const nextEntry = toSessionLogEntry(parsed, bufferTimestamp)
      if (nextEntry) {
        normalized.push(nextEntry)
      }
    }

    if (!buffer) {
      bufferTimestamp = undefined
    }
  }

  return normalized
}
