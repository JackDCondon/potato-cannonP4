import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfigurePage } from './ConfigurePage'

const mockUpdateMutate = vi.fn()
const mockDeleteMutateAsync = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/hooks/queries', () => ({
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        slug: 'project-1',
        displayName: 'Project One',
        path: '/tmp/project-1',
        template: { name: 'product-development', version: '1.0.0' },
      },
    ],
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
})
