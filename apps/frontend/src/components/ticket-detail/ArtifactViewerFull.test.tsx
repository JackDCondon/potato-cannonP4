import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ArtifactViewerFull } from './ArtifactViewerFull'

// Mock the API client
vi.mock('@/api/client', () => ({
  api: {
    getTicketArtifact: vi.fn(),
  },
}))

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock ArtifactChat component
vi.mock('./ArtifactChat', () => ({
  ArtifactChat: () => <div data-testid="artifact-chat">Chat</div>,
}))

// Mock window.matchMedia (needed for Radix UI components)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

import { api } from '@/api/client'

const mockArtifact = {
  filename: 'test-artifact.md',
  type: '.md',
  description: 'A test artifact',
  savedAt: '2026-01-01T00:00:00.000Z',
  phase: 'Specification',
}

const mockContent = '# Test Heading\n\nSome **bold** content.'

describe('ArtifactViewerFull - Copy Button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders copy button when content is loaded', async () => {
    vi.mocked(api.getTicketArtifact).mockResolvedValue(mockContent)

    render(
      <ArtifactViewerFull
        projectId="proj-1"
        ticketId="ticket-1"
        artifact={mockArtifact}
        onClose={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByLabelText('Copy to clipboard')).toBeTruthy()
    })
  })

  it('does not render copy button during loading', () => {
    // Mock API to never resolve - component stays in loading state
    vi.mocked(api.getTicketArtifact).mockReturnValue(new Promise(() => {}))

    render(
      <ArtifactViewerFull
        projectId="proj-1"
        ticketId="ticket-1"
        artifact={mockArtifact}
        onClose={vi.fn()}
      />
    )

    // Button should not be visible while loading
    expect(screen.queryByLabelText('Copy to clipboard')).toBeNull()
  })

  it('does not render copy button when there is an error', async () => {
    vi.mocked(api.getTicketArtifact).mockRejectedValue(new Error('Fetch failed'))

    render(
      <ArtifactViewerFull
        projectId="proj-1"
        ticketId="ticket-1"
        artifact={mockArtifact}
        onClose={vi.fn()}
      />
    )

    // Wait for the error state to be set
    await waitFor(() => {
      expect(screen.getByText('Fetch failed')).toBeTruthy()
    })

    // Button should not be visible when there's an error
    expect(screen.queryByLabelText('Copy to clipboard')).toBeNull()
  })

  it('does not render copy button when artifact is null', () => {
    const { container } = render(
      <ArtifactViewerFull
        projectId="proj-1"
        ticketId="ticket-1"
        artifact={null}
        onClose={vi.fn()}
      />
    )

    expect(container.innerHTML).toBe('')
  })
})
