import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigurePage } from './ConfigurePage'

const mockUpdateMutate = vi.fn()
const mockDeleteMutateAsync = vi.fn()
const projectsData: Array<{
  id: string
  slug: string
  displayName: string
  path: string
  template: { name: string; version: string }
  providerOverride: string | null
}> = [
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

describe('ConfigurePage p4 connection overrides', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(projectsData[0] as any).vcsType = 'perforce'
    ;(projectsData[0] as any).p4UseEnvVars = true
    ;(projectsData[0] as any).p4Port = undefined
    ;(projectsData[0] as any).p4User = undefined
  })

  afterEach(() => {
    delete (projectsData[0] as any).vcsType
    delete (projectsData[0] as any).p4UseEnvVars
    delete (projectsData[0] as any).p4Port
    delete (projectsData[0] as any).p4User
  })

  it('calls updateProject when the env-var toggle is unchecked', async () => {
    render(<ConfigurePage projectId="project-1" />)

    const checkbox = await screen.findByRole('checkbox', {
      name: /use environment variables for p4port and p4user/i,
    })
    fireEvent.click(checkbox)

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'project-1',
        updates: { p4UseEnvVars: false },
      })
    })
  })

  it('calls updateProject with p4Port on blur when override is active', async () => {
    ;(projectsData[0] as any).p4UseEnvVars = false
    render(<ConfigurePage projectId="project-1" />)

    const portInput = await screen.findByPlaceholderText('ssl:perforce.company.com:1666')
    fireEvent.change(portInput, { target: { value: 'ssl:p4.example.com:1666' } })
    fireEvent.blur(portInput)

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'project-1',
        updates: { p4Port: 'ssl:p4.example.com:1666' },
      })
    })
  })

  it('calls updateProject with p4User on blur when override is active', async () => {
    ;(projectsData[0] as any).p4UseEnvVars = false
    render(<ConfigurePage projectId="project-1" />)

    const userInput = await screen.findByPlaceholderText('username')
    fireEvent.change(userInput, { target: { value: 'alice' } })
    fireEvent.blur(userInput)

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'project-1',
        updates: { p4User: 'alice' },
      })
    })
  })
})
