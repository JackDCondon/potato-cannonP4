import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import type { Ticket } from '@potato-cannon/shared'
import { useSSE, useSessionStarted } from './useSSE'

class MockEventSource {
  static instances: MockEventSource[] = []
  static reset() {
    MockEventSource.instances = []
  }

  url: string
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? new Set<(event: MessageEvent) => void>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  close() {}

  emit(type: string, data: unknown) {
    const event = { data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent
    this.listeners.get(type)?.forEach((listener) => listener(event))
  }
}

describe('useSessionStarted', () => {
  it('fires callback when sse:session-started event dispatched', () => {
    const cb = vi.fn()
    renderHook(() => useSessionStarted(cb))
    const detail = { sessionId: 's1', ticketId: 't1' }
    window.dispatchEvent(new CustomEvent('sse:session-started', { detail }))
    expect(cb).toHaveBeenCalledWith(detail)
  })

  it('does not fire callback after unmount', () => {
    const cb = vi.fn()
    const { unmount } = renderHook(() => useSessionStarted(cb))
    unmount()
    window.dispatchEvent(new CustomEvent('sse:session-started', { detail: { sessionId: 's2' } }))
    expect(cb).not.toHaveBeenCalled()
  })

  it('fires callback with partial data (no ticketId)', () => {
    const cb = vi.fn()
    renderHook(() => useSessionStarted(cb))
    const detail = { sessionId: 's3' }
    window.dispatchEvent(new CustomEvent('sse:session-started', { detail }))
    expect(cb).toHaveBeenCalledWith(detail)
  })
})

describe('useSSE', () => {
  const originalEventSource = globalThis.EventSource

  beforeEach(() => {
    MockEventSource.reset()
    ;(globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
      MockEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    ;(globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
      originalEventSource
  })

  it('updates tickets cache immediately when ticket:updated is received', () => {
    const queryClient = new QueryClient()
    const projectId = 'project-1'
    const ticketId = 'T-1'
    const oldTicket = { id: ticketId, title: 'Demo', phase: 'Build' } as Ticket
    const updatedTicket = { ...oldTicket, phase: 'Shelve' } as Ticket

    queryClient.setQueryData(['tickets', projectId, null], [oldTicket])

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    renderHook(() => useSSE(), { wrapper })

    const eventSource = MockEventSource.instances[0]
    eventSource.emit('ticket:updated', { projectId, ticket: updatedTicket })

    const cached = queryClient.getQueryData<Ticket[]>(['tickets', projectId, null]) ?? []
    expect(cached[0]?.phase).toBe('Shelve')
  })
})
