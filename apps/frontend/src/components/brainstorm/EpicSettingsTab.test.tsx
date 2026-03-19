import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { EpicSettingsTab } from './EpicSettingsTab'
import type { Brainstorm } from '@potato-cannon/shared'

// Mock sonner toast
const mockToastError = vi.fn()
const mockToastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}))

// Mock api client
const mockUpdateBrainstorm = vi.fn()
const mockGetBoardSettings = vi.fn()
const mockUpdateBoardPmSettings = vi.fn()
const mockResetBoardPmSettings = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    updateBrainstorm: (...args: unknown[]) => mockUpdateBrainstorm(...args),
    getBoardSettings: (...args: unknown[]) => mockGetBoardSettings(...args),
    updateBoardPmSettings: (...args: unknown[]) => mockUpdateBoardPmSettings(...args),
    resetBoardPmSettings: (...args: unknown[]) => mockResetBoardPmSettings(...args),
  },
}))

// Mock sub-components that are complex (SettingsSection renders children as-is)
vi.mock('@/components/configure/SettingsSection', () => ({
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid={`settings-section-${title.replace(/\s+/g, '-').toLowerCase()}`}>
      <h3>{title}</h3>
      {children}
    </div>
  ),
}))

vi.mock('@/components/configure/PmModeSelector', () => ({
  PmModeSelector: ({ value }: { value: string }) => (
    <div data-testid="pm-mode-selector">PM Mode: {value}</div>
  ),
}))

vi.mock('@/components/configure/PmAlertToggles', () => ({
  PmAlertToggles: () => <div data-testid="pm-alert-toggles">Alert Toggles</div>,
}))

function makeBrainstorm(overrides: Partial<Brainstorm> = {}): Brainstorm {
  return {
    id: 'bs-1',
    projectId: 'proj-1',
    name: 'Auth Epic',
    status: 'epic',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    color: '#3b82f6',
    icon: 'rocket',
    workflowId: null,
    ...overrides,
  }
}

describe('EpicSettingsTab', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBoardSettings.mockResolvedValue({
      pmConfig: {
        mode: 'passive',
        polling: { intervalMinutes: 5, stuckThresholdMinutes: 30, alertCooldownMinutes: 15 },
        alerts: { stuckTickets: true, emptyPhases: true, sessionErrors: true },
      },
    })
  })

  it('renders color swatches from EPIC_BADGE_COLORS', () => {
    const brainstorm = makeBrainstorm()
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    // Should render the "Epic Color" section title
    expect(screen.getByText('Epic Color')).toBeTruthy()

    // Should have color buttons (10 swatches)
    const colorButtons = screen.getAllByTitle(/^#/)
    expect(colorButtons.length).toBe(10)
  })

  it('renders icon grid from EPIC_BADGE_ICONS', () => {
    const brainstorm = makeBrainstorm()
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    const epicIconHeaders = screen.getAllByText('Epic Icon')
    expect(epicIconHeaders.length).toBeGreaterThanOrEqual(1)

    // Should have icon buttons — each icon name appears as a title attribute
    const codeIcons = screen.getAllByTitle('code')
    expect(codeIcons.length).toBeGreaterThanOrEqual(1)
    const rocketIcons = screen.getAllByTitle('rocket')
    expect(rocketIcons.length).toBeGreaterThanOrEqual(1)
  })

  it('calls updateBrainstorm API when a color swatch is clicked', async () => {
    mockUpdateBrainstorm.mockResolvedValue({})
    const brainstorm = makeBrainstorm({ color: '#3b82f6' })
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    // Click a different color swatch (e.g. Emerald #10b981)
    const emeraldSwatches = screen.getAllByTitle('#10b981')
    fireEvent.click(emeraldSwatches[0])

    await waitFor(() => {
      expect(mockUpdateBrainstorm).toHaveBeenCalledWith('proj-1', 'bs-1', { color: '#10b981' })
    })

    // After the API call resolves, the callback should fire
    await waitFor(() => {
      expect(onUpdated).toHaveBeenCalled()
    }, { timeout: 3000 })
  })

  it('does not call API when clicking the already-selected color', async () => {
    const brainstorm = makeBrainstorm({ color: '#3b82f6' })
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    const blueSwatches = screen.getAllByTitle('#3b82f6')
    fireEvent.click(blueSwatches[0])

    // Should not call API since it's the same color
    expect(mockUpdateBrainstorm).not.toHaveBeenCalled()
  })

  it('calls updateBrainstorm API when an icon is clicked', async () => {
    mockUpdateBrainstorm.mockResolvedValue({})
    const brainstorm = makeBrainstorm({ icon: 'rocket' })
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    // Click a different icon
    const bugIcons = screen.getAllByTitle('bug')
    fireEvent.click(bugIcons[0])

    await waitFor(() => {
      expect(mockUpdateBrainstorm).toHaveBeenCalledWith('proj-1', 'bs-1', { icon: 'bug' })
    })
  })

  it('shows error toast when color update fails', async () => {
    mockUpdateBrainstorm.mockRejectedValue(new Error('Network error'))
    const brainstorm = makeBrainstorm({ color: '#3b82f6' })
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    const emeraldSwatches = screen.getAllByTitle('#10b981')
    fireEvent.click(emeraldSwatches[0])

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Network error')
    })
  })

  it('shows error toast when icon update fails', async () => {
    mockUpdateBrainstorm.mockRejectedValue(new Error('Server error'))
    const brainstorm = makeBrainstorm({ icon: 'rocket' })
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    const bugIcons = screen.getAllByTitle('bug')
    fireEvent.click(bugIcons[0])

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Server error')
    })
  })

  it('renders PM Mode section when brainstorm has a workflowId', async () => {
    const brainstorm = makeBrainstorm({ workflowId: 'wf-1' })
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    await waitFor(() => {
      expect(screen.getByText('PM Mode')).toBeTruthy()
    })

    expect(screen.getByTestId('pm-mode-selector')).toBeTruthy()
    expect(screen.getByText('Save PM Settings')).toBeTruthy()
    expect(screen.getByText('Reset to Defaults')).toBeTruthy()
  })

  it('does not render PM Mode section when brainstorm has no workflowId', () => {
    const brainstorm = makeBrainstorm({ workflowId: null })
    const onUpdated = vi.fn()
    render(<EpicSettingsTab projectId="proj-1" brainstorm={brainstorm} onBrainstormUpdated={onUpdated} />)

    expect(screen.queryByTestId('settings-section-pm-mode')).toBeNull()
    expect(screen.queryByTestId('pm-mode-selector')).toBeNull()
  })
})
