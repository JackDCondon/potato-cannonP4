import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ActivityTab } from './ActivityTab'

// ── SSE hooks ──────────────────────────────────────────────────────────────
vi.mock('@/hooks/useSSE', () => ({
  useSessionOutput: vi.fn(),
  useTicketMessage: vi.fn(),
  useSessionEnded: vi.fn(),
}))

// ── API client ─────────────────────────────────────────────────────────────
const mockGetTicketMessages = vi.fn()
const mockGetTicketPending = vi.fn()
const mockGetTicket = vi.fn()
const mockSendTicketInput = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    getTicketMessages: (...args: unknown[]) => mockGetTicketMessages(...args),
    getTicketPending: (...args: unknown[]) => mockGetTicketPending(...args),
    getTicket: (...args: unknown[]) => mockGetTicket(...args),
    sendTicketInput: (...args: unknown[]) => mockSendTicketInput(...args),
  },
  ApiError: class ApiError extends Error {},
  isStaleTicketInputPayload: () => false,
  isTicketLifecycleConflictPayload: () => false,
}))

// ── appStore ───────────────────────────────────────────────────────────────
const mockIsTicketProcessing = vi.fn()
const mockIsTicketPending = vi.fn()

vi.mock('@/stores/appStore', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      isTicketProcessing: mockIsTicketProcessing,
      isTicketPending: mockIsTicketPending,
    }),
}))

// ── Child components that would pull in heavy deps ─────────────────────────
vi.mock('./ArtifactViewerFull', () => ({ ArtifactViewerFull: () => null }))
vi.mock('./TaskList', () => ({ TaskList: () => null }))
vi.mock('./RestartPhaseButton', () => ({ RestartPhaseButton: () => null }))
vi.mock('./ViewSessionButton', () => ({ ViewSessionButton: () => null }))
vi.mock('@/lib/markdown', () => ({ renderMarkdown: (s: string) => s }))
vi.mock('@/lib/waiting-indicator', () => ({
  getWaitingIndicatorLabel: () => 'Thinking…',
  isAwaitingUserInput: () => false,
}))

// ── jsdom stubs ────────────────────────────────────────────────────────────
window.HTMLElement.prototype.scrollIntoView = vi.fn()

// ── Helpers ────────────────────────────────────────────────────────────────
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('ActivityTab — ticket-pending polling when session is suspended', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockIsTicketProcessing.mockReturnValue(false)
    mockIsTicketPending.mockReturnValue(true) // suspended: has pending question, no active session
    mockGetTicketMessages.mockResolvedValue({ messages: [] })
    mockGetTicket.mockResolvedValue({ phase: 'Refinement' })
    mockGetTicketPending.mockResolvedValue({
      question: {
        questionId: 'q-suspended-123',
        ticketGeneration: 1,
        question: 'What level of logging do you want?',
        options: null,
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('continues polling ticket-pending when isPendingTicket is true but no active session', async () => {
    const qc = makeQueryClient()
    render(
      <ActivityTab projectId="proj-1" ticketId="GAM-6" />,
      { wrapper: wrapper(qc) },
    )

    // Let initial fetch resolve
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    const callsAfterMount = mockGetTicketPending.mock.calls.length
    expect(callsAfterMount).toBeGreaterThanOrEqual(1)

    // Advance 2100ms — should trigger a refetch when isPendingTicket=true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })

    expect(mockGetTicketPending.mock.calls.length).toBeGreaterThan(callsAfterMount)
  })
})
