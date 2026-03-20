import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { SessionsTab } from './SessionsTab'
import type { Session } from '@potato-cannon/shared'

// Mock all hooks used by SessionsTab
vi.mock('@/hooks/queries', () => ({
  useSessions: vi.fn(),
  useStopSession: vi.fn(),
  useSessionLog: vi.fn(),
}))

// Mock Dialog component to avoid Radix portal issues in tests
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: () => null,
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { useSessions, useStopSession, useSessionLog } from '@/hooks/queries'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess_aabbccdd11223344',
    projectId: 'proj-1',
    ticketId: 'ticket-1',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:05:00.000Z',
    ...overrides,
  }
}

describe('SessionsTab token display', () => {
  beforeEach(() => {
    vi.mocked(useStopSession).mockReturnValue({ mutate: vi.fn() } as any)
    vi.mocked(useSessionLog).mockReturnValue({ data: [], isLoading: false } as any)
  })

  it('shows token count when inputTokens and outputTokens are set', () => {
    const session = makeSession({ inputTokens: 8400, outputTokens: 1200 })
    vi.mocked(useSessions).mockReturnValue({ data: [session], isLoading: false } as any)

    const { container } = render(<SessionsTab ticketId="ticket-1" />)
    expect(container.textContent).toContain('9.6k tokens')
  })

  it('does not show tokens text when inputTokens and outputTokens are absent', () => {
    const session = makeSession()
    vi.mocked(useSessions).mockReturnValue({ data: [session], isLoading: false } as any)

    const { container } = render(<SessionsTab ticketId="ticket-1" />)
    expect(container.textContent).not.toContain('tokens')
  })
})
