import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AgentCard } from './AgentCard'
import type { TemplateAgent } from '@potato-cannon/shared'

vi.mock('@/api/client', () => ({
  api: {
    getAgentPrompt: vi.fn(),
  },
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: any) => (
    <select value={value} onChange={(event) => onValueChange?.(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: any) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
}))

function renderExpandedCard(overrides: Partial<TemplateAgent> = {}) {
  const onChange = vi.fn()
  const agent: TemplateAgent = {
    id: 'agent-1',
    type: 'refinement/primary',
    role: 'primary',
    modelTier: { simple: 'low', standard: 'mid', complex: 'high' },
    ...overrides,
  }

  render(
    <AgentCard
      agent={agent}
      templateName="product-development"
      onChange={onChange}
      onDelete={vi.fn()}
    />,
  )

  const expandButtons = screen.getAllByRole('button', { name: /refinement\/primary/i })
  fireEvent.click(expandButtons[0])
  return { onChange }
}

describe('AgentCard model tier routing', () => {
  beforeEach(() => {
    cleanup()
  })

  it('renders Tier Routing controls with low, mid, high options', () => {
    renderExpandedCard()

    expect(screen.getByText('Tier Routing')).toBeInTheDocument()
    expect(screen.queryByText('Model Routing')).not.toBeInTheDocument()

    expect(screen.getAllByRole('option', { name: 'low' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('option', { name: 'mid' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('option', { name: 'high' }).length).toBeGreaterThan(0)
  })

  it('writes updates to agent.modelTier instead of agent.model', () => {
    const { onChange } = renderExpandedCard()

    const simpleRow = screen.getByText(/simple/i).closest('div')
    expect(simpleRow).toBeTruthy()

    const simpleSelect = within(simpleRow as HTMLElement).getByRole('combobox')
    fireEvent.change(simpleSelect, { target: { value: 'high' } })

    expect(onChange).toHaveBeenCalled()
    const nextAgent = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]
    expect(nextAgent.modelTier).toEqual({ simple: 'high', standard: 'mid', complex: 'high' })
    expect(nextAgent.model).toBeUndefined()
  })
})
