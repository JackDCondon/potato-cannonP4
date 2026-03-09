// src/hooks/useSSE.ts
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/appStore'
import { formatToolActivity } from '@/lib/utils'

type SSEEventType =
  | 'ping'
  | 'ticket:created'
  | 'ticket:updated'
  | 'ticket:moved'
  | 'ticket:deleted'
  | 'ticket:restarted'
  | 'ticket:message'
  | 'ticket:task-updated'
  | 'session:started'
  | 'session:output'
  | 'session:ended'
  | 'session:remote-control-url'
  | 'session:remote-control-cleared'
  | 'brainstorm:created'
  | 'brainstorm:updated'
  | 'brainstorm:message'
  | 'log:entry'
  | 'processing:sync'
  | 'folder:updated'

interface SSEEventData {
  [key: string]: unknown
}

export function useSSE() {
  const queryClient = useQueryClient()
  const setProcessingTickets = useAppStore((s) => s.setProcessingTickets)
  const removeProcessingTicket = useAppStore((s) => s.removeProcessingTicket)
  const setPendingTickets = useAppStore((s) => s.setPendingTickets)
  const addPendingTicket = useAppStore((s) => s.addPendingTicket)
  const removePendingTicket = useAppStore((s) => s.removePendingTicket)
  const setTicketActivity = useAppStore((s) => s.setTicketActivity)
  const clearTicketActivity = useAppStore((s) => s.clearTicketActivity)
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectDelayRef = useRef(1000)

  useEffect(() => {
    function connect() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }

      const eventSource = new EventSource('/events')
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        console.log('SSE connected')
        reconnectDelayRef.current = 1000
        // Notify RC components to re-fetch state (recovers from SSE dropout during RC startup)
        window.dispatchEvent(new CustomEvent('sse:reconnected'))
      }

      eventSource.onerror = () => {
        console.log('SSE error, reconnecting...')
        eventSource.close()
        setTimeout(connect, reconnectDelayRef.current)
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000)
      }

      // Ticket events - invalidate tickets query and artifacts query
      const ticketEvents: SSEEventType[] = ['ticket:created', 'ticket:updated', 'ticket:moved', 'ticket:deleted']
      ticketEvents.forEach(event => {
        eventSource.addEventListener(event, () => {
          queryClient.refetchQueries({ queryKey: ['tickets'] })
          queryClient.refetchQueries({ queryKey: ['artifacts'] })
        })
      })

      // Ticket restarted - invalidate all related queries and dispatch custom event
      eventSource.addEventListener('ticket:restarted', (e) => {
        queryClient.refetchQueries({ queryKey: ['tickets'] })
        queryClient.refetchQueries({ queryKey: ['sessions'] })
        queryClient.refetchQueries({ queryKey: ['tasks'] })
        try {
          const data = JSON.parse(e.data) as SSEEventData
          window.dispatchEvent(new CustomEvent('sse:ticket-restarted', { detail: data }))
        } catch {
          // Ignore parse errors
        }
      })

      // Brainstorm events - invalidate brainstorms query
      const brainstormEvents: SSEEventType[] = ['brainstorm:created', 'brainstorm:updated']
      brainstormEvents.forEach(event => {
        eventSource.addEventListener(event, () => {
          queryClient.refetchQueries({ queryKey: ['brainstorms'] })
        })
      })

      // Folder events - invalidate folders query
      eventSource.addEventListener('folder:updated', () => {
        queryClient.refetchQueries({ queryKey: ['folders'] })
      })

      // Session events - invalidate sessions and tickets queries
      eventSource.addEventListener('session:started', () => {
        queryClient.refetchQueries({ queryKey: ['sessions'] })
        queryClient.refetchQueries({ queryKey: ['tickets'] })
      })

      eventSource.addEventListener('session:ended', (e) => {
        queryClient.refetchQueries({ queryKey: ['sessions'] })
        queryClient.refetchQueries({ queryKey: ['tickets'] })
        // Clear processing state for this ticket
        try {
          const data = JSON.parse(e.data) as SSEEventData
          const { projectId, ticketId } = data as { projectId?: string; ticketId?: string }
          if (projectId && ticketId) {
            removeProcessingTicket(projectId, ticketId)
            clearTicketActivity(projectId, ticketId)
          }
          // Dispatch custom event for session ended subscribers
          window.dispatchEvent(new CustomEvent('sse:session-ended', { detail: data }))
        } catch {
          // Ignore parse errors
        }
      })

      // Ping - confirm connection health
      eventSource.addEventListener('ping', () => {
        reconnectDelayRef.current = 1000
      })

      // Session output - real-time session feedback
      eventSource.addEventListener('session:output', (e) => {
        try {
          const data = JSON.parse(e.data) as SSEEventData
          window.dispatchEvent(new CustomEvent('sse:session-output', { detail: data }))

          // Update ticket activity in store for board card display
          const { projectId, ticketId } = data as { projectId?: string; ticketId?: string }
          const event = data.event as {
            type?: string
            message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> }
          } | undefined
          if (projectId && ticketId && event?.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use' && block.name) {
                const activity = formatToolActivity(block.name, block.input)
                setTicketActivity(projectId, ticketId, activity)
              }
            }
          }
        } catch (err) {
          console.error('Failed to parse session output:', err)
        }
      })

      // Log events - we'll handle these via a separate mechanism if needed
      eventSource.addEventListener('log:entry', (e) => {
        try {
          const data = JSON.parse(e.data) as SSEEventData
          // Dispatch custom event for log entries
          window.dispatchEvent(new CustomEvent('sse:log', { detail: data }))
        } catch (err) {
          console.error('Failed to parse log entry:', err)
        }
      })

      // Processing sync heartbeat - update store with currently processing sessions
      eventSource.addEventListener('processing:sync', (e) => {
        try {
          const { projectId, ticketIds, pendingTicketIds } = JSON.parse(e.data) as {
            projectId: string
            ticketIds: string[]
            pendingTicketIds?: string[]
          }
          // Update the store with the authoritative processing state from the server
          setProcessingTickets(projectId, ticketIds)
          if (pendingTicketIds) {
            setPendingTickets(projectId, pendingTicketIds)
          }
        } catch (err) {
          console.error('Failed to parse processing:sync:', err)
        }
      })

      // Brainstorm message events - dispatch for real-time updates
      eventSource.addEventListener('brainstorm:message', (e) => {
        try {
          const data = JSON.parse(e.data) as SSEEventData
          window.dispatchEvent(new CustomEvent('sse:brainstorm-message', { detail: data }))
        } catch (err) {
          console.error('Failed to parse brainstorm message:', err)
        }
      })

      // Ticket message events - dispatch for real-time updates
      eventSource.addEventListener('ticket:message', (e) => {
        try {
          const data = JSON.parse(e.data) as SSEEventData
          window.dispatchEvent(new CustomEvent('sse:ticket-message', { detail: data }))

          // Update pending tickets based on message type
          const { projectId, ticketId, message } = data as {
            projectId?: string
            ticketId?: string
            message?: { type?: string }
          }
          if (projectId && ticketId && message) {
            if (message.type === 'question') {
              addPendingTicket(projectId, ticketId)
            } else if (message.type === 'user') {
              removePendingTicket(projectId, ticketId)
            }
          }
        } catch (err) {
          console.error('Failed to parse ticket message:', err)
        }
      })

      // Task update events - refetch all task queries
      eventSource.addEventListener('ticket:task-updated', () => {
        queryClient.refetchQueries({ queryKey: ['tasks'] })
      })

      // Remote control URL — forward to window event for useRemoteControlSSE subscribers
      eventSource.addEventListener('session:remote-control-url', (e) => {
        try {
          const data = JSON.parse(e.data) as SSEEventData
          window.dispatchEvent(new CustomEvent('sse:remote-control-url', { detail: data }))
        } catch {
          // Ignore parse errors
        }
      })

      // Remote control cleared — forward to window event for useRemoteControlSSE subscribers
      eventSource.addEventListener('session:remote-control-cleared', (e) => {
        try {
          const data = JSON.parse(e.data) as SSEEventData
          window.dispatchEvent(new CustomEvent('sse:remote-control-cleared', { detail: data }))
        } catch {
          // Ignore parse errors
        }
      })
    }

    connect()

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
    }
  }, [queryClient, setProcessingTickets, removeProcessingTicket, setPendingTickets, addPendingTicket, removePendingTicket, setTicketActivity, clearTicketActivity])
}

// Hook for subscribing to log entries
export function useLogEntries(callback: (data: SSEEventData) => void) {
  useEffect(() => {
    const handler = (e: CustomEvent<SSEEventData>) => {
      callback(e.detail)
    }

    window.addEventListener('sse:log', handler as EventListener)
    return () => window.removeEventListener('sse:log', handler as EventListener)
  }, [callback])
}

// Hook for subscribing to session output
export function useSessionOutput(callback: (data: SSEEventData) => void) {
  useEffect(() => {
    const handler = (e: CustomEvent<SSEEventData>) => {
      callback(e.detail)
    }
    window.addEventListener('sse:session-output', handler as EventListener)
    return () => window.removeEventListener('sse:session-output', handler as EventListener)
  }, [callback])
}

// Hook for subscribing to brainstorm messages
export function useBrainstormMessage(callback: (data: SSEEventData) => void) {
  useEffect(() => {
    const handler = (e: CustomEvent<SSEEventData>) => {
      callback(e.detail)
    }
    window.addEventListener('sse:brainstorm-message', handler as EventListener)
    return () => window.removeEventListener('sse:brainstorm-message', handler as EventListener)
  }, [callback])
}

// Hook for subscribing to ticket messages
export function useTicketMessage(callback: (data: SSEEventData) => void) {
  useEffect(() => {
    const handler = (e: CustomEvent<SSEEventData>) => {
      callback(e.detail)
    }
    window.addEventListener('sse:ticket-message', handler as EventListener)
    return () => window.removeEventListener('sse:ticket-message', handler as EventListener)
  }, [callback])
}

// Hook for subscribing to session ended events
export function useSessionEnded(callback: (data: SSEEventData) => void) {
  useEffect(() => {
    const handler = (e: CustomEvent<SSEEventData>) => {
      callback(e.detail)
    }
    window.addEventListener('sse:session-ended', handler as EventListener)
    return () => window.removeEventListener('sse:session-ended', handler as EventListener)
  }, [callback])
}

// Hook for subscribing to ticket restarted events
export function useTicketRestarted(callback: (data: SSEEventData) => void) {
  useEffect(() => {
    const handler = (e: CustomEvent<SSEEventData>) => {
      callback(e.detail)
    }
    window.addEventListener('sse:ticket-restarted', handler as EventListener)
    return () => window.removeEventListener('sse:ticket-restarted', handler as EventListener)
  }, [callback])
}

// Hook for subscribing to remote control SSE events scoped to a specific ticket
export function useRemoteControlSSE(
  ticketId: string | undefined,
  onUrl: (url: string) => void,
  onCleared: () => void,
  onReconnected?: () => void,
) {
  const onUrlRef = useRef(onUrl)
  const onClearedRef = useRef(onCleared)
  const onReconnectedRef = useRef(onReconnected)

  // Keep refs updated on every render (safe — refs don't trigger effects)
  useEffect(() => {
    onUrlRef.current = onUrl
    onClearedRef.current = onCleared
    onReconnectedRef.current = onReconnected
  })

  useEffect(() => {
    if (!ticketId) return

    const urlHandler = (e: CustomEvent<SSEEventData>) => {
      const data = e.detail as { ticketId?: string; url?: string }
      if (data.ticketId === ticketId && data.url) {
        onUrlRef.current(data.url)
      }
    }

    const clearedHandler = (e: CustomEvent<SSEEventData>) => {
      const data = e.detail as { ticketId?: string }
      if (data.ticketId === ticketId) {
        onClearedRef.current()
      }
    }

    const reconnectedHandler = () => {
      onReconnectedRef.current?.()
    }

    window.addEventListener('sse:remote-control-url', urlHandler as EventListener)
    window.addEventListener('sse:remote-control-cleared', clearedHandler as EventListener)
    window.addEventListener('sse:reconnected', reconnectedHandler)
    return () => {
      window.removeEventListener('sse:remote-control-url', urlHandler as EventListener)
      window.removeEventListener('sse:remote-control-cleared', clearedHandler as EventListener)
      window.removeEventListener('sse:reconnected', reconnectedHandler)
    }
  }, [ticketId])  // Only ticketId in deps — callbacks stabilized via refs
}
