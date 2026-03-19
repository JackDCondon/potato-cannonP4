import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { WorkflowsSection } from './WorkflowsSection'

const mockCreateWorkflowMutate = vi.fn()
const mockDeleteWorkflowMutate = vi.fn()
const mockUpdateWorkflowMutate = vi.fn()
const mockGetWorkflowDeletePreview = vi.fn()

vi.mock('@/hooks/queries', () => ({
  useWorkflows: () => ({
    data: [
      {
        id: 'wf-default',
        projectId: 'project-1',
        name: 'Default',
        templateName: 'product-development',
        isDefault: true,
        createdAt: '2026-03-11T00:00:00.000Z',
        updatedAt: '2026-03-11T00:00:00.000Z',
      },
      {
        id: 'wf-bug',
        projectId: 'project-1',
        name: 'Bugfix',
        templateName: 'product-development',
        isDefault: false,
        createdAt: '2026-03-11T00:00:00.000Z',
        updatedAt: '2026-03-11T00:00:00.000Z',
      },
    ],
  }),
  useTemplates: () => ({
    data: [{ name: 'product-development', isDefault: true }],
  }),
  useCreateWorkflow: () => ({
    mutate: mockCreateWorkflowMutate,
    isPending: false,
    error: null,
  }),
  useDeleteWorkflow: () => ({
    mutate: mockDeleteWorkflowMutate,
    isPending: false,
  }),
  useUpdateWorkflow: () => ({
    mutate: mockUpdateWorkflowMutate,
    isPending: false,
  }),
}))

vi.mock('@/api/client', () => ({
  api: {
    getWorkflowDeletePreview: (...args: unknown[]) =>
      mockGetWorkflowDeletePreview(...args),
  },
}))

vi.mock('./WorkflowTemplateUpgradePanel', () => ({
  WorkflowTemplateUpgradePanel: () => null,
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

describe('WorkflowsSection delete safeguards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
    mockGetWorkflowDeletePreview.mockResolvedValue({
      workflowId: 'wf-bug',
      ticketCount: 3,
      sampleTicketIds: ['POT-1', 'POT-2'],
      requiresForce: true,
      expectedConfirmation: 'delete-workflow:wf-bug',
    })
  })

  it('shows a destructive modal when deleting a workflow that has tickets', async () => {
    render(
      <WorkflowsSection
        project={{ id: 'project-1', slug: 'project-1', path: '/tmp/project-1' }}
      />,
    )

    fireEvent.click(screen.getAllByTitle('Delete workflow')[0])

    await waitFor(() => {
      expect(
        screen.getByText(/Delete workflow with tickets\?/i),
      ).toBeInTheDocument()
    })
  })

  it('displays ticket count warning copy', async () => {
    render(
      <WorkflowsSection
        project={{ id: 'project-1', slug: 'project-1', path: '/tmp/project-1' }}
      />,
    )

    fireEvent.click(screen.getAllByTitle('Delete workflow')[0])

    await waitFor(() => {
      expect(
        screen.getByText(/currently has 3 ticket\(s\)/i),
      ).toBeInTheDocument()
    })
  })

  it('requires typing the confirmation token before destructive submit', async () => {
    render(
      <WorkflowsSection
        project={{ id: 'project-1', slug: 'project-1', path: '/tmp/project-1' }}
      />,
    )

    fireEvent.click(screen.getAllByTitle('Delete workflow')[0])
    await screen.findByText(/Delete workflow with tickets\?/i)

    const deleteButton = screen.getByRole('button', { name: 'Delete Workflow' })
    expect(deleteButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Delete workflow confirmation'), {
      target: { value: 'delete-workflow:wf-bug' },
    })
    expect(deleteButton).not.toBeDisabled()

    fireEvent.click(deleteButton)
    expect(mockDeleteWorkflowMutate).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        workflowId: 'wf-bug',
        force: true,
        confirmation: 'delete-workflow:wf-bug',
      },
      expect.any(Object),
    )
  })

  it('cancel closes modal without deleting workflow', async () => {
    render(
      <WorkflowsSection
        project={{ id: 'project-1', slug: 'project-1', path: '/tmp/project-1' }}
      />,
    )

    fireEvent.click(screen.getAllByTitle('Delete workflow')[0])
    await screen.findByText(/Delete workflow with tickets\?/i)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(
        screen.queryByText(/Delete workflow with tickets\?/i),
      ).not.toBeInTheDocument()
    })
    expect(mockDeleteWorkflowMutate).not.toHaveBeenCalled()
  })
})

describe('WorkflowsSection change default workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
  })

  it('shows Change Default button when 2+ workflows exist', () => {
    render(
      <WorkflowsSection
        project={{ id: 'project-1', slug: 'project-1', path: '/tmp/project-1' }}
      />,
    )

    expect(screen.getByRole('button', { name: 'Change Default' })).toBeInTheDocument()
  })

  it('opens modal with warning copy and dropdown on click', async () => {
    render(
      <WorkflowsSection
        project={{ id: 'project-1', slug: 'project-1', path: '/tmp/project-1' }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change Default' }))

    await waitFor(() => {
      expect(screen.getByText('Change Default Workflow')).toBeInTheDocument()
      expect(
        screen.getByText(/New tickets will use the selected workflow by default/),
      ).toBeInTheDocument()
    })
  })

  it('confirm button is disabled until a workflow is selected', async () => {
    render(
      <WorkflowsSection
        project={{ id: 'project-1', slug: 'project-1', path: '/tmp/project-1' }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change Default' }))
    await screen.findByText('Change Default Workflow')

    const confirmButton = screen.getByRole('button', { name: 'Change Default' })
    expect(confirmButton).toBeDisabled()
  })
})
