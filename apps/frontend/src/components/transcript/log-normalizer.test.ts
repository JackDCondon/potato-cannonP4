import { describe, it, expect } from 'vitest'
import type { SessionLogEntry } from '@potato-cannon/shared'
import { normalizeTranscriptEntries } from './log-normalizer'

describe('normalizeTranscriptEntries', () => {
  it('reconstructs assistant events split across raw chunks', () => {
    const rawEntries: SessionLogEntry[] = [
      {
        type: 'raw',
        timestamp: '2026-03-10T06:37:10.696Z',
        content:
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello',
      },
      {
        type: 'raw',
        timestamp: '2026-03-10T06:37:10.697Z',
        content: ' world"}]}}',
      },
    ]

    const normalized = normalizeTranscriptEntries(rawEntries)
    expect(normalized).toHaveLength(1)
    expect(normalized[0].type).toBe('assistant')
    expect(normalized[0].message?.content[0]?.type).toBe('text')
    expect(normalized[0].message?.content[0]?.text).toBe('Hello world')
  })

  it('reconstructs wrapped assistant/user/result envelopes from ANSI-split PTY chunks', () => {
    const rawEntries: SessionLogEntry[] = [
      {
        type: 'raw',
        timestamp: '2026-03-10T06:37:10.696Z',
        content:
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/app.ts"}}]},"conte\r',
      },
      {
        type: 'raw',
        timestamp: '2026-03-10T06:37:10.697Z',
        content: '\u001b[39;120Hxt_management":null}',
      },
      {
        type: 'raw',
        timestamp: '2026-03-10T06:37:10.700Z',
        content:
          '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}}\r',
      },
      {
        type: 'raw',
        timestamp: '2026-03-10T06:37:10.710Z',
        content:
          '{"type":"result","subtype":"success","is_error":false,"result":"done"}',
      },
    ]

    const normalized = normalizeTranscriptEntries(rawEntries)
    expect(normalized.map((e) => e.type)).toEqual(['assistant', 'user', 'result'])
    expect(normalized[0].message?.content[0]?.type).toBe('tool_use')
    expect(normalized[1].message?.content[0]?.type).toBe('tool_result')
    expect(normalized.some((e) => e.type === 'tool_use' || e.type === 'text')).toBe(false)
  })

  it('removes thinking signatures from parsed payloads', () => {
    const rawEntries: SessionLogEntry[] = [
      {
        type: 'raw',
        timestamp: '2026-03-10T06:37:10.696Z',
        content:
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Plan it","signature":"secret-value"},{"type":"text","text":"Done"}]}}',
      },
    ]

    const normalized = normalizeTranscriptEntries(rawEntries)
    const firstBlock = normalized[0].message?.content[0] as unknown as Record<string, unknown>
    expect(firstBlock.type).toBe('thinking')
    expect(firstBlock.signature).toBeUndefined()
    expect(normalized[0].message?.content[1]?.text).toBe('Done')
  })

  it('drops terminal control-only raw events', () => {
    const rawEntries: SessionLogEntry[] = [
      { type: 'raw', timestamp: '2026-03-10T06:37:10.696Z', content: '\u001b[?9001h\u001b[?1004h' },
      { type: 'raw', timestamp: '2026-03-10T06:37:10.697Z', content: '\r' },
    ]

    const normalized = normalizeTranscriptEntries(rawEntries)
    expect(normalized).toHaveLength(0)
  })

  it('keeps non-raw events unchanged', () => {
    const entries: SessionLogEntry[] = [
      { type: 'session_start', timestamp: '2026-03-10T06:37:10.000Z', meta: { phase: 'Refinement' } },
      { type: 'system', subtype: 'init', timestamp: '2026-03-10T06:37:10.111Z' },
    ]

    const normalized = normalizeTranscriptEntries(entries)
    expect(normalized).toHaveLength(2)
    expect(normalized[0].type).toBe('session_start')
    expect(normalized[1].type).toBe('system')
  })
})
