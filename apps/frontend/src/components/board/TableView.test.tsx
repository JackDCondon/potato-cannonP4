import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TableView } from './TableView'

// Mock queries
vi.mock('@/hooks/queries', () => ({
  useTickets: () => ({
    data: [
      {
        id: 'POT-1',
        title: 'Pending Ticket',
        phase: 'Build',
        updatedAt: '2026-01-01T00:00:00.000Z',
        archived: false,
      },
      {
        id: 'POT-2',
        title: 'Normal Ticket',
        phase: 'Build',
        updatedAt: '2026-01-01T00:00:00.000Z',
        archived: false,
      },
    ],
  }),
  useProjectPhases: () => ({ data: ['Ideas', 'Build', 'Done'] }),
  useProjects: () => ({ data: [{ id: 'proj-1', template: { name: 'product-development' } }] }),
  useTemplate: () => ({ data: { phases: [{ name: 'Build' }] } }),
  useUpdateTicket: () => ({ mutate: vi.fn() }),
}))

// Mock appStore
const mockIsTicketProcessing = vi.fn().mockReturnValue(false)
const mockIsTicketPending = vi.fn().mockImplementation((_projectId: string, ticketId: string) => {
  return ticketId === 'POT-1'
})
const mockOpenTicketSheet = vi.fn()

vi.mock('@/stores/appStore', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      openTicketSheet: mockOpenTicketSheet,
      isTicketProcessing: mockIsTicketProcessing,
      isTicketPending: mockIsTicketPending,
    }
    return selector(state)
  },
}))

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

describe('TableView - Pending Badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('should show amber ? badge for pending tickets', () => {
    render(<TableView projectId="proj-1" />)

    const badges = screen.getAllByLabelText('Waiting for human input')
    expect(badges.length).toBe(1)
    expect(badges[0].className).toContain('text-amber-400')
  })

  it('should not show amber ? badge for non-pending tickets', () => {
    // POT-2 is not pending per our mock
    render(<TableView projectId="proj-1" />)

    // Only one badge should exist (for POT-1)
    const badges = screen.getAllByLabelText('Waiting for human input')
    expect(badges.length).toBe(1)
  })
})
