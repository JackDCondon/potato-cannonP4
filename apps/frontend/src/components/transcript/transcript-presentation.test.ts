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
