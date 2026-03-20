import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_PM_CONFIG } from '@potato-cannon/shared'
import { BoardSettingsPage } from './BoardSettingsPage'

const STORAGE_KEY = 'potato-board-pm-defaults'

const mockGetBoardSettings = vi.fn().mockResolvedValue({ pmConfig: DEFAULT_PM_CONFIG })
const mockUpdateBoardPmSettings = vi.fn()
const mockResetBoardPmSettings = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    getBoardSettings: (...args: unknown[]) => mockGetBoardSettings(...args),
    updateBoardPmSettings: (...args: unknown[]) => mockUpdateBoardPmSettings(...args),
    resetBoardPmSettings: (...args: unknown[]) => mockResetBoardPmSettings(...args),
  },
}))

describe('BoardSettingsPage PM defaults', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    vi.clearAllMocks()
    mockGetBoardSettings.mockResolvedValue({ pmConfig: DEFAULT_PM_CONFIG })
  })

  it('loads DEFAULT_PM_CONFIG when localStorage is empty', async () => {
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /passive/i })).toHaveClass('border-accent')
    })
    expect(mockGetBoardSettings).not.toHaveBeenCalled()
  })

  it('loads saved config from localStorage on mount', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_PM_CONFIG, mode: 'watching' }))
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /watching/i })).toHaveClass('border-accent')
    })
  })

  it('writes to localStorage when PM mode changes', async () => {
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)

    fireEvent.click(await screen.findByRole('button', { name: /executing/i }))

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.mode).toBe('executing')
    })
  })

  it('does not render a Save Board Settings button', () => {
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)
    expect(screen.queryByRole('button', { name: /save board settings/i })).not.toBeInTheDocument()
  })

  it('does not render a Reset to Defaults button', () => {
    render(<BoardSettingsPage projectId="project-1" workflowId="workflow-1" />)
    expect(screen.queryByRole('button', { name: /reset to defaults/i })).not.toBeInTheDocument()
  })
})
