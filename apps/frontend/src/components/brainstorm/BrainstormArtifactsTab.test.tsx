import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrainstormArtifactsTab } from './BrainstormArtifactsTab'

// Mock the query hook
vi.mock('@/hooks/queries', () => ({
  useBrainstormArtifacts: vi.fn(),
}))

import { useBrainstormArtifacts } from '@/hooks/queries'
const mockUseBrainstormArtifacts = vi.mocked(useBrainstormArtifacts)

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('BrainstormArtifactsTab', () => {
  it('shows empty state when no artifacts', () => {
    mockUseBrainstormArtifacts.mockReturnValue({
      data: { artifacts: [] },
      isLoading: false,
    } as any)
    render(<BrainstormArtifactsTab projectId="p1" brainstormId="b1" />, { wrapper })
    expect(screen.getByText(/no artifacts yet/i)).toBeTruthy()
  })

  it('renders artifact filenames', () => {
    mockUseBrainstormArtifacts.mockReturnValue({
      data: {
        artifacts: [{ filename: 'plan.md', content: '# Plan', updatedAt: new Date().toISOString() }],
      },
      isLoading: false,
    } as any)
    render(<BrainstormArtifactsTab projectId="p1" brainstormId="b1" />, { wrapper })
    expect(screen.getByText('plan.md')).toBeTruthy()
  })
})
