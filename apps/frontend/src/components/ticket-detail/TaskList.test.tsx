import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TaskList } from './TaskList'
import type { Task } from '@potato-cannon/shared'

// Mock the API
vi.mock('@/api/client', () => ({
  api: {
    getTicketTasks: vi.fn(),
  },
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const makeTasks = (overrides: Partial<Task>[]): Task[] =>
  overrides.map((o, i) => ({
    id: `t${i}`,
    ticketId: 'ticket1',
    displayNumber: i + 1,
    phase: 'Build',
    status: 'pending',
    attemptCount: 0,
    description: `Task ${i + 1}`,
    complexity: 'standard',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...o,
  }))

describe('TaskList', () => {
  it('hides cancelled tasks', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getTicketTasks).mockResolvedValue(
      makeTasks([{ status: 'pending' }, { status: 'cancelled', description: 'Hidden task' }])
    )
    render(<TaskList projectId="p1" ticketId="t1" currentPhase="Build" />, { wrapper })
    expect(await screen.findByText('Task 1')).toBeInTheDocument()
    expect(screen.queryByText('Hidden task')).toBeNull()
  })

  it('shows in_progress task with accent style', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getTicketTasks).mockResolvedValue(
      makeTasks([{ status: 'in_progress', description: 'Active task' }])
    )
    render(<TaskList projectId="p1" ticketId="t1" currentPhase="Build" />, { wrapper })
    const el = await screen.findByText('Active task')
    expect(el.className).toContain('text-accent')
  })

  it('shows failed task with destructive style', async () => {
    const { api } = await import('@/api/client')
    vi.mocked(api.getTicketTasks).mockResolvedValue(
      makeTasks([{ status: 'failed', description: 'Failed task' }])
    )
    render(<TaskList projectId="p1" ticketId="t1" currentPhase="Build" />, { wrapper })
    const el = await screen.findByText('Failed task')
    expect(el.className).toContain('text-destructive')
  })
})
