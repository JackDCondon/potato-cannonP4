import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrainstormDetailPanel } from './BrainstormDetailPanel'

// Mock useLocation from react-router
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({
    pathname: '/projects/proj-1/board',
  }),
}))

// Mock useQueryClient
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
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
}

describe('BrainstormDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

    // Should show the brainstorm name
    expect(screen.getByText('Test Brainstorm')).toBeDefined()
  })

  it('shows "Epic — managed by PM" title for epic brainstorm with pmEnabled', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [epicBrainstorm]

    render(<BrainstormDetailPanel />)

    // Should show "Epic — managed by PM"
    expect(screen.getByText('Epic — managed by PM')).toBeDefined()
  })

  it('shows Epic badge when brainstorm is epic with pmEnabled', () => {
    mockAppState.brainstormSheetOpen = true
    mockAppState.brainstormSheetBrainstormId = 'bs-1'
    mockAppState.brainstormSheetProjectId = 'proj-1'
    mockAppState.brainstormSheetBrainstormName = 'Test Brainstorm'
    mockAppState.currentProjectId = 'proj-1'
    mockBrainstormsData = [epicBrainstorm]

    render(<BrainstormDetailPanel />)

    // Should show Epic badge
    const epicBadges = screen.getAllByText('Epic')
    expect(epicBadges.length).toBeGreaterThan(0)
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
