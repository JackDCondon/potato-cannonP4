import { describe, it, expect } from 'vitest'
import type { SessionLogEntry } from '@potato-cannon/shared'
import { buildTranscriptRenderableItems } from './transcript-presentation'

describe('buildTranscriptRenderableItems', () => {
  it('groups assistant + tool use + tool result into one attempt card', () => {
    const entries: SessionLogEntry[] = [
      {
        type: 'assistant',
        timestamp: '2026-03-10T10:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Reading files' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/app.ts' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-10T10:00:01Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      },
    ]

    const renderables = buildTranscriptRenderableItems(entries, {
      showSystemEvents: false,
      showRawEvents: false,
    })
    expect(renderables).toHaveLength(1)
    expect(renderables[0].kind).toBe('attempt')
    if (renderables[0].kind === 'attempt') {
      expect(renderables[0].assistantTextBlocks[0]).toBe('Reading files')
      expect(renderables[0].toolUses).toHaveLength(1)
      expect(renderables[0].toolResults).toHaveLength(1)
      expect(renderables[0].status).toBe('success')
    }
  })

  it('keeps multiple tool calls and results in same attempt until next assistant turn', () => {
    const entries: SessionLogEntry[] = [
      {
        type: 'assistant',
        timestamp: '2026-03-10T10:00:00Z',
        message: {
          content: [{ type: 'text', text: 'I will inspect files' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-10T10:00:01Z',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.ts' } },
            { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'b.ts' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-10T10:00:02Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'A', is_error: false },
            { type: 'tool_result', tool_use_id: 'b', content: 'B', is_error: false },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-10T10:00:03Z',
        message: {
          content: [{ type: 'text', text: 'Next attempt' }],
        },
      },
    ]

    const renderables = buildTranscriptRenderableItems(entries, {
      showSystemEvents: false,
      showRawEvents: false,
    })
    expect(renderables).toHaveLength(2)
    expect(renderables[0].kind).toBe('attempt')
    expect(renderables[1].kind).toBe('attempt')
    if (renderables[0].kind === 'attempt') {
      expect(renderables[0].toolUses).toHaveLength(2)
      expect(renderables[0].toolResults).toHaveLength(2)
    }
  })

  it('handles orphan tool result safely and marks error attempts', () => {
    const entries: SessionLogEntry[] = [
      {
        type: 'user',
        timestamp: '2026-03-10T10:00:00Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }],
        },
      },
    ]

    const renderables = buildTranscriptRenderableItems(entries, {
      showSystemEvents: false,
      showRawEvents: false,
    })
    expect(renderables).toHaveLength(1)
    expect(renderables[0].kind).toBe('attempt')
    if (renderables[0].kind === 'attempt') {
      expect(renderables[0].status).toBe('error')
      expect(renderables[0].hasErrors).toBe(true)
    }
  })

  it('hides noisy system/raw events by default and shows them when toggled', () => {
    const entries: SessionLogEntry[] = [
      { type: 'system', subtype: 'init', timestamp: '2026-03-10T10:00:00Z' },
      { type: 'system', subtype: 'task_progress', description: 'Doing work', timestamp: '2026-03-10T10:00:01Z' },
      { type: 'raw', timestamp: '2026-03-10T10:00:02Z', content: 'raw details' },
    ]

    const hidden = buildTranscriptRenderableItems(entries, {
      showSystemEvents: false,
      showRawEvents: false,
    })
    expect(hidden).toHaveLength(0)

    const visible = buildTranscriptRenderableItems(entries, {
      showSystemEvents: true,
      showRawEvents: true,
    })
    expect(visible.some((r) => r.kind === 'system')).toBe(true)
    expect(visible.some((r) => r.kind === 'raw')).toBe(true)
  })
})

