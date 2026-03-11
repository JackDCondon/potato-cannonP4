import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useTicketSessions } from './queries'

vi.mock('@/api/client', () => ({
  api: {
    getTicketSessions: vi.fn(),
  },
}))

import { api } from '@/api/client'

const mockedGetTicketSessions = vi.mocked(api.getTicketSessions)

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
  }
}

describe('useTicketSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches sessions for a ticket', async () => {
    mockedGetTicketSessions.mockResolvedValue([
      {
        id: 's1',
        phase: 'Build',
        agentSource: 'architect',
        status: 'completed',
        startedAt: '2026-03-10T00:00:00Z',
        continuityMode: 'handoff',
        continuityReason: 'packet_available',
        continuityScope: 'same_lifecycle',
        continuitySummary: 'handoff(same_lifecycle): turns=1, highlights=1, questions=0',
      },
    ])

    const { result } = renderHook(
      () => useTicketSessions('p1', 't1'),
      { wrapper: createWrapper() }
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockedGetTicketSessions).toHaveBeenCalledWith('p1', 't1')
    expect(result.current.data).toHaveLength(1)
    expect(result.current.data![0].agentSource).toBe('architect')
    expect(result.current.data![0].continuityMode).toBe('handoff')
    expect(result.current.data![0].continuityReason).toBe('packet_available')
    expect(result.current.data![0].continuityScope).toBe('same_lifecycle')
    expect(result.current.data![0].continuitySummary).toContain('handoff')
  })

  it('is disabled when projectId is undefined', () => {
    const { result } = renderHook(
      () => useTicketSessions(undefined, 't1'),
      { wrapper: createWrapper() }
    )

    expect(result.current.fetchStatus).toBe('idle')
    expect(mockedGetTicketSessions).not.toHaveBeenCalled()
  })

  it('is disabled when ticketId is undefined', () => {
    const { result } = renderHook(
      () => useTicketSessions('p1', undefined),
      { wrapper: createWrapper() }
    )

    expect(result.current.fetchStatus).toBe('idle')
    expect(mockedGetTicketSessions).not.toHaveBeenCalled()
  })
})
