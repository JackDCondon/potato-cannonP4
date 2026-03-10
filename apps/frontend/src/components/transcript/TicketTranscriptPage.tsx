import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTicketSessions, useProjects, useTicket } from '@/hooks/queries'
import { useSessionOutput, useSessionEnded, useSessionStarted } from '@/hooks/useSSE'
import { api } from '@/api/client'
import type { SessionLogEntry, SessionMeta } from '@potato-cannon/shared'
import { PhaseHeader } from './PhaseHeader'
import { PhaseDivider } from './PhaseDivider'
import { IdleMarker } from './IdleMarker'
import { EventRow } from './EventRow'

// ─── Types ───────────────────────────────────────────────────────────────────

type TimelineEntry =
  | { kind: 'phase-divider'; session: SessionMeta }
  | { kind: 'entry'; sessionId: string; entry: SessionLogEntry }
  | { kind: 'idle'; phase: string; timestamp: string }

interface Props {
  projectId: string
  ticketId: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Look up the swimlane color for a phase from the project config. */
function phaseColor(
  swimlaneColors: Record<string, string> | undefined,
  phase: string | undefined,
): string | undefined {
  if (!swimlaneColors || !phase) return undefined
  return swimlaneColors[phase]
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TicketTranscriptPage({ projectId, ticketId }: Props) {
  const queryClient = useQueryClient()
  const { data: sessions = [] } = useTicketSessions(projectId, ticketId)
  const { data: projects } = useProjects()
  const { data: ticket } = useTicket(projectId, ticketId)

  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [liveEntries, setLiveEntries] = useState<TimelineEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)

  const scrollRef = useRef<HTMLDivElement>(null)
  const knownSessionIds = useRef<Set<string>>(new Set())

  // ── Derived state ──────────────────────────────────────────────────────────

  const project = useMemo(
    () => projects?.find((p) => p.id === projectId),
    [projects, projectId],
  )
  const swimlaneColors = project?.swimlaneColors

  const lastSession = sessions[sessions.length - 1] as SessionMeta | undefined
  const isLive = lastSession?.status === 'running'
  const currentPhase = lastSession?.phase ?? ticket?.phase

  // ── Load historical session logs ───────────────────────────────────────────

  useEffect(() => {
    if (sessions.length === 0) {
      setTimeline([])
      return
    }

    let cancelled = false
    const ids = new Set(sessions.map((s) => s.id))
    knownSessionIds.current = ids

    async function loadAll() {
      const built: TimelineEntry[] = []
      for (const session of sessions) {
        built.push({ kind: 'phase-divider', session })
        try {
          const log = await api.getSessionLog(session.id)
          for (const entry of log) {
            built.push({ kind: 'entry', sessionId: session.id, entry })
          }
        } catch {
          // Session log may not be available yet — skip silently
        }
      }

      // Append idle marker after the last completed session
      const last = sessions[sessions.length - 1]
      if (last && last.status !== 'running') {
        built.push({
          kind: 'idle',
          phase: last.phase ?? 'Unknown',
          timestamp: last.endedAt ?? last.startedAt,
        })
      }

      if (!cancelled) {
        setTimeline(built)
        setLiveEntries([])
      }
    }

    loadAll()
    return () => {
      cancelled = true
    }
  }, [sessions])

  // ── SSE: new session started → invalidate sessions query ───────────────────

  useSessionStarted(
    useCallback(
      (data: { sessionId: string; ticketId?: string }) => {
        if (data.ticketId === ticketId) {
          queryClient.invalidateQueries({
            queryKey: ['ticketSessions', projectId, ticketId],
          })
        }
      },
      [queryClient, projectId, ticketId],
    ),
  )

  // ── SSE: live session output → append if from a known session ──────────────

  useSessionOutput(
    useCallback(
      (data: Record<string, unknown>) => {
        const sid = data.sessionId as string | undefined
        if (!sid || !knownSessionIds.current.has(sid)) return

        const event = data.event as SessionLogEntry | undefined
        if (!event) return

        setLiveEntries((prev) => [
          ...prev,
          { kind: 'entry', sessionId: sid, entry: event },
        ])
      },
      [],
    ),
  )

  // ── SSE: session ended → invalidate to pick up final state ─────────────────

  useSessionEnded(
    useCallback(
      (data: Record<string, unknown>) => {
        if (data.ticketId === ticketId) {
          queryClient.invalidateQueries({
            queryKey: ['ticketSessions', projectId, ticketId],
          })
        }
      },
      [queryClient, projectId, ticketId],
    ),
  )

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  const combinedTimeline = useMemo(
    () => [...timeline, ...liveEntries],
    [timeline, liveEntries],
  )

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [combinedTimeline, autoScroll])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setAutoScroll(atBottom)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      <PhaseHeader
        ticketTitle={ticket?.title ?? ticketId}
        phase={currentPhase}
        agentSource={lastSession?.agentSource}
        isLive={isLive}
        color={phaseColor(swimlaneColors, currentPhase)}
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {combinedTimeline.map((item, i) => {
          switch (item.kind) {
            case 'phase-divider':
              return (
                <PhaseDivider
                  key={`divider-${item.session.id}`}
                  phase={item.session.phase ?? 'Unknown'}
                  agentSource={item.session.agentSource}
                  timestamp={item.session.startedAt}
                  color={phaseColor(swimlaneColors, item.session.phase)}
                />
              )
            case 'entry':
              return (
                <EventRow
                  key={`entry-${item.sessionId}-${i}`}
                  entry={item.entry}
                />
              )
            case 'idle':
              return (
                <IdleMarker
                  key={`idle-${item.phase}`}
                  phase={item.phase}
                  timestamp={item.timestamp}
                />
              )
          }
        })}
      </div>
    </div>
  )
}
