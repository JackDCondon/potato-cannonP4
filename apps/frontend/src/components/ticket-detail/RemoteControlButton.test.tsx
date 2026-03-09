import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RemoteControlButton } from './RemoteControlButton'

vi.mock('@/api/client', () => ({
  api: {
    getRemoteControl: vi.fn().mockResolvedValue({ pending: false, url: null }),
    startRemoteControl: vi.fn().mockResolvedValue({ ok: true, sessionId: 'sess_1' }),
  },
}))

vi.mock('@/hooks/useSSE', () => ({
  useRemoteControlSSE: vi.fn(),
}))

afterEach(() => {
  cleanup()
})

describe('RemoteControlButton', () => {
  it('renders disabled when no active session', () => {
    render(
      <RemoteControlButton
        projectId="proj_1"
        ticketId="POT-1"
        ticketTitle="My Ticket"
        hasActiveSession={false}
      />
    )
    const btn = screen.getByRole('button', { name: /remote control/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders enabled when active session exists', () => {
    render(
      <RemoteControlButton
        projectId="proj_1"
        ticketId="POT-1"
        ticketTitle="My Ticket"
        hasActiveSession={true}
      />
    )
    const btn = screen.getByRole('button', { name: /start remote control/i })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })
})
