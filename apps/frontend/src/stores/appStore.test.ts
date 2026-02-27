import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from './appStore'

describe('appStore - pendingTickets', () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingTickets: new Map(),
    })
  })

  it('should return false for non-pending ticket', () => {
    const result = useAppStore.getState().isTicketPending('proj-1', 'ticket-1')
    expect(result).toBe(false)
  })

  it('should add a pending ticket', () => {
    useAppStore.getState().addPendingTicket('proj-1', 'ticket-1')
    expect(useAppStore.getState().isTicketPending('proj-1', 'ticket-1')).toBe(true)
  })

  it('should not affect other tickets when adding', () => {
    useAppStore.getState().addPendingTicket('proj-1', 'ticket-1')
    expect(useAppStore.getState().isTicketPending('proj-1', 'ticket-2')).toBe(false)
  })

  it('should not affect other projects when adding', () => {
    useAppStore.getState().addPendingTicket('proj-1', 'ticket-1')
    expect(useAppStore.getState().isTicketPending('proj-2', 'ticket-1')).toBe(false)
  })

  it('should remove a pending ticket', () => {
    useAppStore.getState().addPendingTicket('proj-1', 'ticket-1')
    useAppStore.getState().removePendingTicket('proj-1', 'ticket-1')
    expect(useAppStore.getState().isTicketPending('proj-1', 'ticket-1')).toBe(false)
  })

  it('should set pending tickets for a project (replacing existing)', () => {
    useAppStore.getState().addPendingTicket('proj-1', 'ticket-old')
    useAppStore.getState().setPendingTickets('proj-1', ['ticket-1', 'ticket-2'])

    expect(useAppStore.getState().isTicketPending('proj-1', 'ticket-1')).toBe(true)
    expect(useAppStore.getState().isTicketPending('proj-1', 'ticket-2')).toBe(true)
    expect(useAppStore.getState().isTicketPending('proj-1', 'ticket-old')).toBe(false)
  })

  it('should handle removing from non-existent project gracefully', () => {
    useAppStore.getState().removePendingTicket('nonexistent', 'ticket-1')
    expect(useAppStore.getState().isTicketPending('nonexistent', 'ticket-1')).toBe(false)
  })
})
