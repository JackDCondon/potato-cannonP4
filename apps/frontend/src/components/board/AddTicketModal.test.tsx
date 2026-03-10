import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { AddTicketModal } from './AddTicketModal'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Mock external dependencies
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({
    pathname: '/projects/test-project/workflows/workflow-1/board',
  }),
}))

vi.mock('@/hooks/queries', () => ({
  useProjects: () => ({
    data: [{ id: 'test-project', slug: 'test-project' }],
  }),
}))

vi.mock('@/stores/appStore', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentProjectId: 'test-project',
      addTicketModalOpen: true,
      closeAddTicketModal: vi.fn(),
    }),
}))

vi.mock('@/api/client', () => ({
  api: {
    createTicket: vi.fn(),
  },
}))

// Mock window.matchMedia (needed for Radix UI Dialog)
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

describe('AddTicketModal', () => {
  it('renders the title input with autoComplete="off"', () => {
    render(<AddTicketModal />)

    const titleInput = screen.getByPlaceholderText('Ticket title') as HTMLInputElement
    expect(titleInput.getAttribute('autocomplete')).toBe('off')
  })

  it('includes workflowId in request body when creating from a workflow board', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<AddTicketModal />)

    const [titleInput] = screen.getAllByPlaceholderText('Ticket title')
    fireEvent.change(titleInput, {
      target: { value: 'My ticket' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [, options] = fetchMock.mock.calls[0]
    expect(options?.body).toBeDefined()
    expect(JSON.parse(options.body as string)).toMatchObject({
      title: 'My ticket',
      workflowId: 'workflow-1',
    })
  })
})
