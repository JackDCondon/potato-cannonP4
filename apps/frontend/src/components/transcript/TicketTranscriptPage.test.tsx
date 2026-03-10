import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TicketTranscriptPage } from './TicketTranscriptPage'
import type { SessionMeta, SessionLogEntry } from '@potato-cannon/shared'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSessions: SessionMeta[] = [
  {
    id: 'session-1',
    ticketId: 'ticket-1',
    phase: 'Refinement',
    agentSource: 'refine-agent',
    status: 'completed',
    startedAt: '2026-03-10T10:00:00Z',
    endedAt: '2026-03-10T10:15:00Z',
  },
  {
    id: 'session-2',
    ticketId: 'ticket-1',
    phase: 'Build',
    agentSource: 'build-agent',
    status: 'completed',
    startedAt: '2026-03-10T10:20:00Z',
    endedAt: '2026-03-10T10:40:00Z',
  },
]

const makeLogEntries = (sessionId: string): SessionLogEntry[] => [
  {
    type: 'assistant',
    timestamp: '2026-03-10T10:01:00Z',
    message: {
      content: [{ type: 'text', text: `Output from ${sessionId}` }],
    },
  },
]

vi.mock('@/hooks/queries', () => ({
  useTicketSessions: vi.fn(() => ({
    data: mockSessions,
    isLoading: false,
    error: null,
  })),
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        swimlaneColors: { Refinement: '#3b82f6', Build: '#10b981' },
      },
    ],
  }),
  useTicket: () => ({
    data: { id: 'ticket-1', title: 'Test Ticket', phase: 'Build' },
  }),
}))

vi.mock('@/api/client', () => ({
  api: {
    getSessionLog: vi.fn((sessionId: string) =>
      Promise.resolve(makeLogEntries(sessionId)),
    ),
  },
}))

vi.mock('@/hooks/useSSE', () => ({
  useSessionOutput: vi.fn(),
  useSessionEnded: vi.fn(),
  useSessionStarted: vi.fn(),
}))

vi.mock('./PhaseDivider', () => ({
  PhaseDivider: ({ phase }: { phase: string }) => (
    <div data-testid="phase-divider">{phase} Phase</div>
  ),
}))

vi.mock('./PhaseHeader', () => ({
  PhaseHeader: ({
    ticketTitle,
    phase,
    isLive,
  }: {
    ticketTitle: string
    phase?: string
    isLive: boolean
  }) => (
    <div data-testid="phase-header">
      {ticketTitle} | {phase} | {isLive ? 'Live' : 'Ended'}
    </div>
  ),
}))

vi.mock('./IdleMarker', () => ({
  IdleMarker: ({ phase }: { phase: string }) => (
    <div data-testid="idle-marker">{phase} phase complete, waiting for next phase</div>
  ),
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function renderPage(overrides?: { projectId?: string; ticketId?: string }) {
  const qc = createQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <TicketTranscriptPage
        projectId={overrides?.projectId ?? 'project-1'}
        ticketId={overrides?.ticketId ?? 'ticket-1'}
      />
    </QueryClientProvider>,
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TicketTranscriptPage', () => {
  it('renders phase dividers between sessions', async () => {
    renderPage()
    await waitFor(() => {
      const dividers = screen.getAllByTestId('phase-divider')
      expect(dividers).toHaveLength(2)
      expect(dividers[0]).toHaveTextContent('Refinement Phase')
      expect(dividers[1]).toHaveTextContent('Build Phase')
    })
  })

  it('renders attempt cards from session logs', async () => {
    renderPage()
    await waitFor(() => {
      const cards = screen.getAllByTestId('attempt-card')
      expect(cards).toHaveLength(2)
      expect(cards[0]).toHaveTextContent('Output from session-1')
      expect(cards[1]).toHaveTextContent('Output from session-2')
    })
  })

  it('shows idle marker after last completed session', async () => {
    renderPage()
    await waitFor(() => {
      const marker = screen.getByTestId('idle-marker')
      expect(marker).toHaveTextContent('waiting for next phase')
    })
  })

  it('renders PhaseHeader with ticket info', async () => {
    renderPage()
    await waitFor(() => {
      const header = screen.getByTestId('phase-header')
      expect(header).toHaveTextContent('Test Ticket')
      expect(header).toHaveTextContent('Build')
    })
  })

  it('renders no attempt cards when sessions have no log entries', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getSessionLog).mockResolvedValue([])
    renderPage()
    await waitFor(() => {
      expect(screen.queryAllByTestId('attempt-card')).toHaveLength(0)
    })
  })

  it('does not show idle marker when last session is still running', async () => {
    const { useTicketSessions } = await import('@/hooks/queries')
    vi.mocked(useTicketSessions).mockReturnValueOnce({
      data: [{ ...mockSessions[0], status: 'running', endedAt: undefined }],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useTicketSessions>)
    renderPage()
    await waitFor(() => {
      expect(screen.getByTestId('phase-divider')).toBeInTheDocument()
    })
  })

  it('renders assistant content reconstructed from raw JSON chunks', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getSessionLog).mockImplementation((sessionId: string) => {
      if (sessionId !== 'session-1') return Promise.resolve([])
      return Promise.resolve([
      {
        type: 'raw',
        timestamp: '2026-03-10T10:01:00Z',
        content:
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello',
      },
      {
        type: 'raw',
        timestamp: '2026-03-10T10:01:01Z',
        content: ' from raw"}]}}',
      },
      ] as SessionLogEntry[])
    })

    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('Hello from raw').length).toBeGreaterThan(0)
    })
  })

  it('hides system and raw markers by default, then shows them when toggled', async () => {
    const user = userEvent.setup()
    const { api } = await import('@/api/client')
    vi.mocked(api.getSessionLog).mockResolvedValue([
      {
        type: 'assistant',
        timestamp: '2026-03-10T10:00:00Z',
        message: { content: [{ type: 'text', text: 'Start' }] },
      },
      {
        type: 'system',
        subtype: 'task_progress',
        description: 'Working',
        timestamp: '2026-03-10T10:00:01Z',
      },
      {
        type: 'raw',
        timestamp: '2026-03-10T10:00:02Z',
        content: 'raw details',
      },
    ] as SessionLogEntry[])

    renderPage()
    await waitFor(() => {
      expect(screen.getAllByTestId('attempt-card').length).toBeGreaterThan(0)
    })
    expect(screen.queryByTestId('system-marker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('raw-marker')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show system events/i }))
    await user.click(screen.getByRole('button', { name: /show raw events/i }))

    await waitFor(() => {
      expect(screen.getAllByTestId('system-marker').length).toBeGreaterThan(0)
    })
  })

  it('expands attempt sections when expand-all toggle is enabled', async () => {
    const user = userEvent.setup()
    renderPage()

    await waitFor(() => {
      expect(screen.getAllByTestId('attempt-card')).toHaveLength(2)
    })

    expect(screen.queryByText(/No tool calls\./i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /expand all details/i }))

    await waitFor(() => {
      expect(screen.getAllByText(/No tool calls\./i).length).toBeGreaterThan(0)
    })
  })
})
