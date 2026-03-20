import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { BrainstormDetailPanel } from './BrainstormDetailPanel'

// Mock useLocation from react-router
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({
    pathname: '/projects/proj-1/board',
  }),
}))

// Mock tanstack query
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}))

// Mock appStore
const createMockAppState = (): {
  brainstormSheetOpen: boolean
  brainstormSheetBrainstormId: string | null
  brainstormSheetProjectId: string | null
  brainstormSheetBrainstormName: string | null
  brainstormSheetIsCreating: boolean
  currentProjectId: string | null
  closeBrainstormSheet: ReturnType<typeof vi.fn>
  openBrainstormSheet: ReturnType<typeof vi.fn>
} => ({
  brainstormSheetOpen: false,
  brainstormSheetBrainstormId: null,
  brainstormSheetProjectId: null,
  brainstormSheetBrainstormName: null,
  brainstormSheetIsCreating: false,
  currentProjectId: null,
  closeBrainstormSheet: vi.fn(),
  openBrainstormSheet: vi.fn(),
})

let mockAppState = createMockAppState()

vi.mock('@/stores/appStore', () => ({
  useAppStore: (selector: any) => selector(mockAppState),
}))

// Mock useBrainstorms
let mockBrainstormsData: any[] = []

vi.mock('@/hooks/queries', () => ({
  useBrainstorms: () => ({
    data: mockBrainstormsData,
    isLoading: false,
  }),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

const mockGetBoardSettings = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    getBoardSettings: (...args: unknown[]) => mockGetBoardSettings(...args),
    updateBrainstorm: vi.fn(),
    createBrainstorm: vi.fn(),
  },
}))

// Mock BrainstormChat, BrainstormNewForm, BrainstormArtifactsTab
vi.mock('./BrainstormChat', () => ({
  BrainstormChat: () => <div data-testid="brainstorm-chat">BrainstormChat</div>,
}))

vi.mock('./BrainstormNewForm', () => ({
  BrainstormNewForm: () => <div data-testid="brainstorm-new-form">BrainstormNewForm</div>,
}))

vi.mock('./BrainstormArtifactsTab', () => ({
  BrainstormArtifactsTab: () => <div data-testid="brainstorm-artifacts-tab">BrainstormArtifactsTab</div>,
}))

const baseBrainstorm = {
  id: 'bs-1',
  name: 'Test Brainstorm',
  status: 'active' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  hasActiveSession: false,
  pmEnabled: false,
}

const epicBrainstorm = {
  ...baseBrainstorm,
  status: 'epic' as const,
  pmEnabled: true,
  workflowId: 'wf-1',
  pmConfig: {
    mode: 'watching' as const,
    polling: {
      intervalMinutes: 5,
      stuckThresholdMinutes: 30,
      alertCooldownMinutes: 15,
    },
    alerts: {
      stuckTickets: true,
      emptyPhases: true,
      sessionErrors: true,
    },
  },
}

describe('BrainstormDetailPanel', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockGetBoardSettings.mockResolvedValue({
      pmConfig: {
        mode: 'watching',
        polling: {
          intervalMinutes: 5,
          stuckThresholdMinutes: 30,
          alertCooldownMinutes: 15,
        },
        alerts: {
          stuckTickets: true,
          emptyPhases: true,
          sessionErrors: true,
        },
      },
      chatNotificationPolicy: null,
    })
    mockAppState = createMockAppState()
    mockBrainstormsData = []
  })

  it('does not render when panel is closed', () => {
    mockAppState.brainstormSheetOpen = false
    const { container } = render(<BrainstormDetailPanel />)
    const panel = container.querySelector('[data-open="false"]')
    expect(panel).toBeDefined()
  })

  it('shows title for regular active brainstorm', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [baseBrainstorm]

    render(<BrainstormDetailPanel />)

    expect(screen.getByText('Test Brainstorm')).toBeDefined()
  })

  it('shows the brainstorm title and epic badges for pm-enabled epic brainstorms', async () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [epicBrainstorm]

    render(<BrainstormDetailPanel />)

    expect(screen.getByText('Test Brainstorm')).toBeDefined()
    expect(screen.queryByText(/managed by pm/i)).toBeNull()
    expect(screen.getByText('Epic')).toBeDefined()
    await waitFor(() => {
      expect(screen.getByText('watching')).toBeDefined()
    })
  })

  it('shows passive as default PM mode when board settings not loaded', async () => {
    mockGetBoardSettings.mockRejectedValue(new Error('offline'))
    const passiveEpicBrainstorm = {
      ...epicBrainstorm,
      pmConfig: null,
    }

    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [passiveEpicBrainstorm]

    render(<BrainstormDetailPanel />)

    await waitFor(() => {
      expect(screen.getByText('passive')).toBeDefined()
    })
  })

  it('prefers saved board PM mode over stale brainstorm PM mode in the header badge', async () => {
    mockGetBoardSettings.mockResolvedValue({
      pmConfig: {
        ...epicBrainstorm.pmConfig,
        mode: 'executing',
      },
      chatNotificationPolicy: null,
    })

    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [epicBrainstorm]

    render(<BrainstormDetailPanel />)

    await waitFor(() => {
      expect(mockGetBoardSettings).toHaveBeenCalledWith('proj-1', 'wf-1')
    })

    await waitFor(() => {
      expect(screen.getByText('executing')).toBeDefined()
    })
  })

  it('shows Brainstorm badge when status is not epic', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [baseBrainstorm]

    render(<BrainstormDetailPanel />)

    expect(screen.getByText('Brainstorm')).toBeDefined()
    expect(screen.queryByText('Epic')).toBeNull()
  })

  it('shows Epic badge but not Brainstorm badge when status is epic', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [epicBrainstorm]

    render(<BrainstormDetailPanel />)

    expect(screen.getByText('Epic')).toBeDefined()
    expect(screen.queryByText('Brainstorm')).toBeNull()
  })

  it('renders a resize handle when panel is open', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [baseBrainstorm]

    render(<BrainstormDetailPanel />)

    expect(screen.getByRole('separator', { name: /resize brainstorm detail panel/i })).toBeDefined()
  })

  it('applies --panel-width CSS variable to panel element', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [baseBrainstorm]

    const { container } = render(<BrainstormDetailPanel />)

    const panel = container.querySelector('.brainstorm-detail-panel')
    expect(panel?.getAttribute('style')).toContain('--panel-width')
  })
})
