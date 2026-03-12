import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigurePage } from './ConfigurePage'

const mockUpdateMutate = vi.fn()
const mockDeleteMutateAsync = vi.fn()
const projectsData = [
  {
    id: 'project-1',
    slug: 'project-1',
    displayName: 'Project One',
    path: '/tmp/project-1',
    template: { name: 'product-development', version: '1.0.0' },
    providerOverride: null,
  },
]

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: {
    getGlobalConfig: vi.fn().mockResolvedValue({
      perforce: { mcpServerPath: '' },
      ai: {
        defaultProvider: 'anthropic',
        providers: [
          { id: 'anthropic', models: { low: 'haiku', mid: 'sonnet', high: 'opus' } },
          { id: 'openai', models: { low: 'gpt-4o-mini', mid: 'gpt-4.1', high: 'o3' } },
        ],
      },
    }),
  },
}))

vi.mock('@/hooks/queries', () => ({
  useProjects: () => ({
    data: projectsData,
  }),
  useUpdateProject: () => ({
    mutate: mockUpdateMutate,
    isPending: false,
  }),
  useDeleteProject: () => ({
    mutateAsync: mockDeleteMutateAsync,
  }),
}))

vi.mock('./ProjectIconPicker', () => ({
  ProjectIconPicker: () => <div>ProjectIconPicker</div>,
}))

vi.mock('./ProjectColorPicker', () => ({
  ProjectColorPicker: () => <div>ProjectColorPicker</div>,
}))

vi.mock('./WorkflowsSection', () => ({
  WorkflowsSection: () => <div>Workflows Section</div>,
}))

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

describe('ConfigurePage workflow-first surface', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('does not render the project Template selector section', () => {
    render(<ConfigurePage projectId="project-1" />)
    expect(screen.queryByText('Template')).not.toBeInTheDocument()
  })

  it('keeps workflow controls visible', () => {
    render(<ConfigurePage projectId="project-1" />)
    expect(screen.getAllByText('Workflows Section').length).toBeGreaterThan(0)
  })

  it('renders provider override selector', async () => {
    render(<ConfigurePage projectId="project-1" />)

    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toBeInTheDocument()
    })

    expect(screen.getAllByText(/Inherited \(anthropic\)/).length).toBeGreaterThan(0)
  })

  it('saves provider override', async () => {
    render(<ConfigurePage projectId="project-1" />)

    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getAllByRole('option', { name: 'openai' }).length).toBeGreaterThan(0)
    })

    const select = screen.getByLabelText('Provider') as HTMLSelectElement
    await waitFor(() => {
      expect(select).not.toBeDisabled()
    })
    fireEvent.change(select, { target: { value: 'openai' } })
    fireEvent.blur(select)

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'project-1',
        updates: { providerOverride: 'openai' },
      })
    })

  })

  it('clears provider override back to inherited', async () => {
    projectsData[0].providerOverride = 'openai'
    render(<ConfigurePage projectId="project-1" />)

    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toBeInTheDocument()
    })

    const select = screen.getByLabelText('Provider') as HTMLSelectElement
    await waitFor(() => {
      expect(select).not.toBeDisabled()
    })

    fireEvent.change(select, { target: { value: '__inherit__' } })
    fireEvent.blur(select)

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'project-1',
        updates: { providerOverride: null },
      })
    })

    projectsData[0].providerOverride = null
  })
})
