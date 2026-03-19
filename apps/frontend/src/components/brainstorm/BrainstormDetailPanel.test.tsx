import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrainstormDetailPanel } from './BrainstormDetailPanel'

// Mock useLocation from react-router
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({
    pathname: '/projects/proj-1/board',
  }),
}))

// Mock tanstack query
let mockBoardSettingsData: any = null

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
  useQuery: () => ({
    data: mockBoardSettingsData,
    isLoading: false,
  }),
}))

// Mock appStore
const createMockAppState = () => ({
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
}

describe('BrainstormDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAppState = createMockAppState()
    mockBrainstormsData = []
    mockBoardSettingsData = null
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

    // Should show the brainstorm name
    expect(screen.getByText('Test Brainstorm')).toBeDefined()
  })

  it('shows PM mode badge for epic brainstorm with pmEnabled', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [epicBrainstorm]
    mockBoardSettingsData = { pmConfig: { mode: 'watching' } }

    render(<BrainstormDetailPanel />)

    // Should show brainstorm name (not replaced)
    expect(screen.getAllByText('Test Brainstorm').length).toBeGreaterThan(0)
    // Should show PM mode badge
    expect(screen.getByText('watching')).toBeDefined()
  })

  it('shows passive as default PM mode when board settings not loaded', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [epicBrainstorm]
    mockBoardSettingsData = null

    render(<BrainstormDetailPanel />)

    expect(screen.getByText('passive')).toBeDefined()
  })

  it('does not show Epic badge for regular brainstorm', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [baseBrainstorm]

    const { container } = render(<BrainstormDetailPanel />)

    // Find the badge element (they have data-slot="badge")
    const badges = container.querySelectorAll('[data-slot="badge"]')
    expect(badges.length).toBe(0)
  })
})
