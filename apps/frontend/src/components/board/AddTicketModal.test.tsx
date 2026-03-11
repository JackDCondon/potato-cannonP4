import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { AddTicketModal } from './AddTicketModal'

const mockStoreState = {
  currentProjectId: 'test-project',
  addTicketModalOpen: true,
  closeAddTicketModal: vi.fn(() => {
    mockStoreState.addTicketModalOpen = false
  }),
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  mockStoreState.addTicketModalOpen = true
  mockStoreState.closeAddTicketModal.mockClear()
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
    selector(mockStoreState),
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

  it('does not render a default close icon button', () => {
    render(<AddTicketModal />)

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
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

  it('restores canceled title and description drafts on reopen', async () => {
    render(<AddTicketModal />)

    const titleInput = screen.getByPlaceholderText('Ticket title') as HTMLInputElement
    const descriptionInput = screen.getByPlaceholderText(
      'Ticket description (supports markdown)'
    ) as HTMLTextAreaElement

    fireEvent.change(titleInput, { target: { value: 'Draft title' } })
    fireEvent.change(descriptionInput, { target: { value: 'Draft description' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    const draft = localStorage.getItem('add-ticket-draft:test-project:workflow-1')
    expect(draft).toBeTruthy()

    mockStoreState.addTicketModalOpen = true
    render(<AddTicketModal />)

    await waitFor(() => {
      expect((screen.getAllByPlaceholderText('Ticket title')[0] as HTMLInputElement).value).toBe(
        'Draft title'
      )
    })
    expect(
      (screen.getAllByPlaceholderText('Ticket description (supports markdown)')[0] as HTMLTextAreaElement)
        .value
    ).toBe('Draft description')
  })

  it('clears draft from localStorage after successful create', async () => {
    localStorage.setItem(
      'add-ticket-draft:test-project:workflow-1',
      JSON.stringify({ title: 'Saved title', description: 'Saved description' })
    )

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<AddTicketModal />)

    await waitFor(() => {
      expect((screen.getAllByPlaceholderText('Ticket title')[0] as HTMLInputElement).value).toBe(
        'Saved title'
      )
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem('add-ticket-draft:test-project:workflow-1')).toBeNull()
  })
})
