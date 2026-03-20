import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { EpicBadge } from './EpicBadge'
import type { Brainstorm } from '@potato-cannon/shared'

// Mock the Tooltip to render children directly (avoids Radix portal issues in tests)
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <span>{children}</span>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

function makeBrainstorm(overrides: Partial<Brainstorm> = {}): Brainstorm {
  return {
    id: 'bs-1',
    name: 'Auth Epic',
    status: 'epic',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workflowId: 'wf-1',
    ticketCount: 5,
    activeTicketCount: 2,
    color: '#3b82f6',
    icon: 'rocket',
    ...overrides,
  }
}

describe('EpicBadge', () => {
  it('returns null when brainstorm is undefined', () => {
    const onClick = vi.fn()
    const { container } = render(<EpicBadge brainstorm={undefined} onClick={onClick} />)
    expect(container.innerHTML).toBe('')
  })

  it('applies the epic color from the brainstorm', () => {
    const onClick = vi.fn()
    const brainstorm = makeBrainstorm({ color: '#f43f5e' })
    const { container } = render(<EpicBadge brainstorm={brainstorm} onClick={onClick} />)

    const badge = container.querySelector('span[style]') as HTMLElement
    expect(badge).toBeTruthy()
    expect(badge.style.color).toBe('rgb(244, 63, 94)')
  })

  it('falls back to default color when color is null', () => {
    const onClick = vi.fn()
    const brainstorm = makeBrainstorm({ color: null })
    const { container } = render(<EpicBadge brainstorm={brainstorm} onClick={onClick} />)

    const badge = container.querySelector('span[style]') as HTMLElement
    // Default color is #818cf8 → rgb(129, 140, 248)
    expect(badge.style.color).toBe('rgb(129, 140, 248)')
  })

  it('falls back to Layers icon when icon is null', () => {
    const onClick = vi.fn()
    const brainstorm = makeBrainstorm({ icon: null })
    const { container } = render(<EpicBadge brainstorm={brainstorm} onClick={onClick} />)

    // The Layers icon renders an SVG element
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
  })

  it('renders the chosen icon when a valid icon name is provided', () => {
    const onClick = vi.fn()
    const brainstorm = makeBrainstorm({ icon: 'rocket' })
    const { container } = render(<EpicBadge brainstorm={brainstorm} onClick={onClick} />)

    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
  })

  it('calls onClick when the badge is clicked', () => {
    const onClick = vi.fn()
    const brainstorm = makeBrainstorm()
    const { container } = render(<EpicBadge brainstorm={brainstorm} onClick={onClick} />)

    const badge = container.querySelector('span[style]') as HTMLElement
    fireEvent.click(badge)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders epic name and ticket counts in the tooltip', () => {
    const onClick = vi.fn()
    const brainstorm = makeBrainstorm({ name: 'Auth Epic', ticketCount: 5, activeTicketCount: 2 })
    const { container } = render(<EpicBadge brainstorm={brainstorm} onClick={onClick} />)

    const tooltipContent = container.querySelector('[data-testid="tooltip-content"]')
    expect(tooltipContent).toBeTruthy()
    expect(tooltipContent!.textContent).toContain('Auth Epic')
    expect(tooltipContent!.textContent).toContain('2 of 5 tickets active')
  })

  it('does not render ticket counts when ticketCount is 0', () => {
    const onClick = vi.fn()
    const brainstorm = makeBrainstorm({ ticketCount: 0, activeTicketCount: 0 })
    const { container } = render(<EpicBadge brainstorm={brainstorm} onClick={onClick} />)

    const tooltipContent = container.querySelector('[data-testid="tooltip-content"]')
    expect(tooltipContent).toBeTruthy()
    expect(tooltipContent!.textContent).not.toContain('tickets active')
  })

  it('falls back to Layers icon when icon name is unrecognised', () => {
    const onClick = vi.fn()
    const brainstorm = makeBrainstorm({ icon: 'nonexistent-icon' })
    const { container } = render(<EpicBadge brainstorm={brainstorm} onClick={onClick} />)

    // Should still render an SVG (Layers fallback)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
  })
})
