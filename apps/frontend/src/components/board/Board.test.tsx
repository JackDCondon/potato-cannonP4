import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { Board } from './Board'

// Mock all external dependencies
vi.mock('@/hooks/queries', () => ({
  useTickets: () => ({ data: [], isLoading: false, error: null }),
  useProjectPhases: () => ({ data: ['Ideas', 'Build', 'Done'] }),
  useTemplate: () => ({ data: { phases: [] } }),
  useProjects: () => ({
    data: [{ id: 'test-project', template: { name: 'product-development' } }]
  }),
  useUpdateTicket: () => ({ mutate: vi.fn() }),
  useToggleDisabledPhase: () => ({ mutate: vi.fn() }),
  useUpdateProject: () => ({ mutate: vi.fn() })
}))

vi.mock('@/stores/appStore', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      boardViewMode: 'kanban',
      openAddTicketModal: vi.fn(),
      showArchivedTickets: false
    })
}))

vi.mock('@/components/TemplateUpgradeBanner', () => ({
  TemplateUpgradeBanner: () => null
}))

vi.mock('./ArchivedSwimlane', () => ({
  ArchivedSwimlane: () => null
}))

vi.mock('./BoardColumn', () => ({
  BoardColumn: ({ phase }: { phase: string }) => (
    <div data-testid={`board-column-${phase}`}>{phase}</div>
  )
}))

vi.mock('./BrainstormColumn', () => ({
  BrainstormColumn: () => (
    <div data-testid="brainstorm-column">Brainstorm</div>
  )
}))

vi.mock('./TicketCard', () => ({
  TicketCard: () => null
}))

vi.mock('./ViewToggle', () => ({
  ViewToggle: () => null
}))

vi.mock('./TableView', () => ({
  TableView: () => null
}))

// Mock window.matchMedia (needed for Radix UI components)
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
    dispatchEvent: vi.fn()
  }))
})

describe('Board - Kanban view brainstorm column', () => {
  it('does not apply sticky positioning classes to the brainstorm column wrapper', () => {
    const { getByTestId } = render(<Board projectId="test-project" />)

    const brainstormEl = getByTestId('brainstorm-column')
    const wrapper = brainstormEl.parentElement!

    // The wrapper should NOT have any sticky-related classes
    expect(wrapper.className).not.toMatch(/sticky/)
    expect(wrapper.className).not.toMatch(/sm:left-4/)
    expect(wrapper.className).not.toMatch(/sm:z-10/)
    expect(wrapper.className).not.toMatch(/sm:bg-bg-primary/)
    expect(wrapper.className).not.toMatch(/sm:pr-4/)

    // The wrapper should still have shrink-0
    expect(wrapper.className).toMatch(/shrink-0/)
  })
})
