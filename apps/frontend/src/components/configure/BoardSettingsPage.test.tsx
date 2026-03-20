import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  DEFAULT_CHAT_NOTIFICATION_POLICY,
  DEFAULT_PM_CONFIG,
} from '@potato-cannon/shared'
import { BoardSettingsPage } from './BoardSettingsPage'

const STORAGE_KEY = 'potato-board-pm-defaults'

const mockGetBoardSettings = vi.fn().mockResolvedValue({
  pmConfig: DEFAULT_PM_CONFIG,
  chatNotificationPolicy: DEFAULT_CHAT_NOTIFICATION_POLICY,
})
const mockUpdateBoardPmSettings = vi.fn()
const mockUpdateBoardNotificationSettings = vi.fn().mockImplementation(
  async (_projectId: string, _workflowId: string, policy: unknown) => ({
    chatNotificationPolicy: policy,
    settings: {},
  }),
)
const mockResetBoardPmSettings = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    getBoardSettings: (...args: unknown[]) => mockGetBoardSettings(...args),
    updateBoardPmSettings: (...args: unknown[]) => mockUpdateBoardPmSettings(...args),
    updateBoardNotificationSettings: (...args: unknown[]) =>
      mockUpdateBoardNotificationSettings(...args),
    resetBoardPmSettings: (...args: unknown[]) => mockResetBoardPmSettings(...args),
  },
}))

describe('BoardSettingsPage', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    vi.clearAllMocks()
    mockGetBoardSettings.mockResolvedValue({
      pmConfig: DEFAULT_PM_CONFIG,
      chatNotificationPolicy: DEFAULT_CHAT_NOTIFICATION_POLICY,
    })
  })

  it('keeps PM defaults browser-local while loading phone policy from the backend', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_PM_CONFIG, mode: 'watching' }))

    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)

    await waitFor(() => {
      expect(mockGetBoardSettings).toHaveBeenCalledWith('project-1', 'workflow-1')
    })

    expect(screen.getByRole('button', { name: /watching/i })).toHaveClass('border-accent')
    expect(mockUpdateBoardPmSettings).not.toHaveBeenCalled()
  })

  it('writes PM mode changes to localStorage only', async () => {
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)

    fireEvent.click(await screen.findByRole('button', { name: /executing/i }))

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.mode).toBe('executing')
    })

    expect(mockUpdateBoardPmSettings).not.toHaveBeenCalled()
  })

  it('saves phone notification toggles through the board settings API', async () => {
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)

    const builderUpdatesSwitch = await screen.findByRole('switch', { name: /builder updates/i })
    expect(builderUpdatesSwitch).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(builderUpdatesSwitch)

    await waitFor(() => {
      expect(mockUpdateBoardNotificationSettings).toHaveBeenCalledTimes(1)
    })

    const savedPolicy = mockUpdateBoardNotificationSettings.mock.calls[0][2]
    expect(savedPolicy).toMatchObject({
      categories: {
        ...DEFAULT_CHAT_NOTIFICATION_POLICY.categories,
        builder_updates: false,
      },
    })
  })

  it('renders collapsible sections and keeps advanced settings collapsed by default', async () => {
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)

    expect(screen.queryByLabelText(/poll interval/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /advanced/i }))

    expect(await screen.findByLabelText(/poll interval/i)).toBeInTheDocument()
  })

  it('shows a local-only badge for PM defaults and a saved-to-board badge for phone notifications', async () => {
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)

    expect(await screen.findByText(/saved to board/i)).toBeInTheDocument()
    expect(screen.getAllByText(/local only/i)).toHaveLength(2)
  })
})
