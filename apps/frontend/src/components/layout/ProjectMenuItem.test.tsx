import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectMenuItem } from './ProjectMenuItem'
import { SidebarProvider } from '@/components/ui/sidebar'

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
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

// Mock the icon picker
vi.mock('@/components/configure/ProjectIconPicker', () => ({
  getProjectIcon: () => () => null,
}))

// Mock TanStack Router Link component
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))

// Mock useWorkflows hook — default: no workflows (loading state)
const mockUseWorkflows = vi.fn(() => ({ data: undefined }))
vi.mock('@/hooks/queries', () => ({
  useWorkflows: (...args: any[]) => mockUseWorkflows(...args),
}))

function renderWithProviders(component: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        {component}
      </SidebarProvider>
    </QueryClientProvider>
  )
}

describe('ProjectMenuItem', () => {
  const mockProject = {
    id: 'proj-1',
    slug: 'my-project',
    path: '/path/to/project',
    displayName: 'My Project',
  }

  const mockWorkflow = {
    id: 'wf-1',
    projectId: 'proj-1',
    name: 'Default Board',
    templateName: 'product-development',
    isDefault: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  const mockWorkflow2 = {
    id: 'wf-2',
    projectId: 'proj-1',
    name: 'Secondary Board',
    templateName: 'product-development',
    isDefault: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  it('should render project name', () => {
    mockUseWorkflows.mockReturnValue({ data: undefined })
    renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={false}
        hasActiveSessions={false}
        hasPendingQuestions={false}
      />
    )

    expect(screen.getByText('My Project')).toBeTruthy()
  })

  it('should apply thinking-shimmer class when hasActiveSessions is true', () => {
    mockUseWorkflows.mockReturnValue({ data: undefined })
    const { container } = renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={false}
        hasActiveSessions={true}
        hasPendingQuestions={false}
      />
    )

    expect(container.querySelector('.thinking-shimmer')).toBeTruthy()
  })

  it('should show dot indicator when hasPendingQuestions is true', () => {
    mockUseWorkflows.mockReturnValue({ data: undefined })
    const { container } = renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={false}
        hasActiveSessions={false}
        hasPendingQuestions={true}
      />
    )

    // Look for the dot indicator - a small rounded div with specific styling
    const dotIndicator = container.querySelector('.bg-accent.rounded-full')
    expect(dotIndicator).toBeTruthy()
  })

  it('should apply active styling when isActive is true', () => {
    mockUseWorkflows.mockReturnValue({ data: undefined })
    const { container } = renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={true}
        hasActiveSessions={false}
        hasPendingQuestions={false}
      />
    )

    // The SidebarMenuButton component applies data-active="true" when isActive={true}
    const button = container.querySelector('[data-active="true"]')
    expect(button).toBeTruthy()
  })

  it('should render both shimmer and dot when both conditions are true', () => {
    mockUseWorkflows.mockReturnValue({ data: undefined })
    const { container } = renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={false}
        hasActiveSessions={true}
        hasPendingQuestions={true}
      />
    )

    expect(container.querySelector('.thinking-shimmer')).toBeTruthy()
    expect(container.querySelector('.bg-accent.rounded-full')).toBeTruthy()
  })

  it('should apply project color to text when color is provided', () => {
    mockUseWorkflows.mockReturnValue({ data: undefined })
    const projectWithColor = {
      ...mockProject,
      color: '#FF0000',
    }

    const { container } = renderWithProviders(
      <ProjectMenuItem
        project={projectWithColor}
        isActive={false}
        hasActiveSessions={false}
        hasPendingQuestions={false}
      />
    )

    const spans = container.querySelectorAll('span.flex-1')
    const projectSpan = Array.from(spans).find(s => s.textContent === 'My Project')
    expect(projectSpan).toBeTruthy()
    expect((projectSpan as HTMLElement).style.color).toBe('rgb(255, 0, 0)')
  })

  it('links directly to workflow board when project has a single workflow', () => {
    mockUseWorkflows.mockReturnValue({ data: [mockWorkflow] })
    const { container } = renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={false}
        hasActiveSessions={false}
        hasPendingQuestions={false}
      />
    )

    const link = container.querySelector('a')
    expect(link).toBeTruthy()
    // TanStack Router Link mock renders `to` as an attribute
    const toAttr = link?.getAttribute('to')
    expect(toAttr).toContain('workflows')
    expect(toAttr).toContain('board')
  })

  it('renders workflow children when project has multiple workflows', () => {
    mockUseWorkflows.mockReturnValue({ data: [mockWorkflow, mockWorkflow2] })
    renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={false}
        hasActiveSessions={false}
        hasPendingQuestions={false}
      />
    )

    expect(screen.getByText('Default Board')).toBeTruthy()
    expect(screen.getByText('Secondary Board')).toBeTruthy()
  })

  it('marks the active workflow sub-item when currentWorkflowId matches', () => {
    mockUseWorkflows.mockReturnValue({ data: [mockWorkflow, mockWorkflow2] })
    const { container } = renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={true}
        hasActiveSessions={false}
        hasPendingQuestions={false}
        currentWorkflowId="wf-1"
      />
    )

    const activeSubButton = container.querySelector('[data-active="true"]')
    expect(activeSubButton).toBeTruthy()
  })

  it('shows chevron toggle for multi-workflow projects', () => {
    mockUseWorkflows.mockReturnValue({ data: [mockWorkflow, mockWorkflow2] })
    const { container } = renderWithProviders(
      <ProjectMenuItem
        project={mockProject}
        isActive={false}
        hasActiveSessions={false}
        hasPendingQuestions={false}
      />
    )

    // ChevronRight renders an SVG
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
  })
})
