import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { WorkflowTemplateUpgradePanel } from './WorkflowTemplateUpgradePanel'

const mockStatus = vi.fn()
const mockUpgradeMutate = vi.fn()

vi.mock('@/hooks/queries', () => ({
  useWorkflowTemplateStatus: (...args: unknown[]) => mockStatus(...args),
  useUpgradeWorkflowTemplate: () => ({
    mutate: mockUpgradeMutate,
    isPending: false,
  }),
}))

vi.mock('@/components/ChangelogModal', () => ({
  ChangelogModal: ({ workflowId }: { workflowId: string }) => (
    <div>Changelog for {workflowId}</div>
  ),
}))

describe('WorkflowTemplateUpgradePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
  })

  it('shows workflow current and available versions with upgrade action when available', () => {
    mockStatus.mockReturnValue({
      data: {
        current: '1.0.0',
        available: '1.1.0',
        upgradeType: 'minor',
      },
      isLoading: false,
    })

    render(
      <WorkflowTemplateUpgradePanel
        projectId="project-1"
        workflowId="workflow-1"
        workflowName="Default"
      />,
    )

    expect(screen.getByText('v1.0.0 -> v1.1.0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upgrade/i })).toBeInTheDocument()
  })

  it('hides upgrade action when no update is available', () => {
    mockStatus.mockReturnValue({
      data: {
        current: '1.1.0',
        available: '1.1.0',
        upgradeType: null,
      },
      isLoading: false,
    })

    render(
      <WorkflowTemplateUpgradePanel
        projectId="project-1"
        workflowId="workflow-1"
        workflowName="Default"
      />,
    )

    expect(screen.getByText('v1.1.0')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument()
  })

  it('opens changelog for the selected workflow', () => {
    mockStatus.mockReturnValue({
      data: {
        current: '1.0.0',
        available: '1.1.0',
        upgradeType: 'minor',
      },
      isLoading: false,
    })

    render(
      <WorkflowTemplateUpgradePanel
        projectId="project-1"
        workflowId="workflow-abc"
        workflowName="Bugfix"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /changelog/i }))
    expect(screen.getByText('Changelog for workflow-abc')).toBeInTheDocument()
  })
})
