import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSessionStarted } from './useSSE'

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
