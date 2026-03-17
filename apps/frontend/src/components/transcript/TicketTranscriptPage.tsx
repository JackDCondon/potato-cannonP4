import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTicketSessions, useProjects, useTicket } from '@/hooks/queries'
import { useSessionOutput, useSessionEnded, useSessionStarted } from '@/hooks/useSSE'
import { api } from '@/api/client'
import type { SessionLogEntry, SessionMeta } from '@potato-cannon/shared'
import { PhaseHeader } from './PhaseHeader'
import { PhaseDivider } from './PhaseDivider'
import { IdleMarker } from './IdleMarker'
import { normalizeTranscriptEntries } from './log-normalizer'
import { flattenToStreamItems, type StreamItem, type ToolResultItem } from './transcript-presentation'
import { StreamItemRenderer } from './StreamItemRenderer'

// ─── Types ───────────────────────────────────────────────────────────────────

type TimelineEntry =
  | { kind: 'phase-divider'; session: SessionMeta }
  | { kind: 'entry'; sessionId: string; entry: SessionLogEntry }
  | { kind: 'idle'; phase: string; timestamp: string }

type RenderTimelineEntry =
  | { kind: 'phase-divider'; session: SessionMeta }
  | { kind: 'idle'; phase: string; timestamp: string }
  | { kind: 'stream-item'; sessionId: string; item: StreamItem }

interface Props {
  projectId: string
  ticketId: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
          const normalizedLog = normalizeTranscriptEntries(log)
          for (const entry of normalizedLog) {
            built.push({ kind: 'entry', sessionId: session.id, entry })
          }
        } catch {
          // Session log may not be available yet
        }
      }

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
    return () => { cancelled = true }
  }, [sessions])

  // ── SSE handlers ───────────────────────────────────────────────────────────

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

  useSessionOutput(
    useCallback(
      (data: Record<string, unknown>) => {
        const sid = data.sessionId as string | undefined
        if (!sid || !knownSessionIds.current.has(sid)) return

        const event = data.event as SessionLogEntry | undefined
        if (!event) return
        const normalized = normalizeTranscriptEntries([event])
        if (normalized.length === 0) return

        setLiveEntries((prev) => [
          ...prev,
          ...normalized.map((entry) => ({ kind: 'entry' as const, sessionId: sid, entry })),
        ])
      },
      [],
    ),
  )

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

  // ── Build render timeline ──────────────────────────────────────────────────

  const combinedTimeline = useMemo(
    () => [...timeline, ...liveEntries],
    [timeline, liveEntries],
  )

  const renderTimeline = useMemo(() => {
    const rendered: RenderTimelineEntry[] = []
    let pendingSessionId: string | null = null
    let pendingEntries: SessionLogEntry[] = []

    const flushPending = () => {
      if (!pendingSessionId || pendingEntries.length === 0) {
        pendingSessionId = null
        pendingEntries = []
        return
      }
      const items = flattenToStreamItems(pendingEntries)
      for (const item of items) {
        rendered.push({ kind: 'stream-item', sessionId: pendingSessionId, item })
      }
      pendingSessionId = null
      pendingEntries = []
    }

    for (const item of combinedTimeline) {
      if (item.kind === 'entry') {
        if (!pendingSessionId) {
          pendingSessionId = item.sessionId
        } else if (pendingSessionId !== item.sessionId) {
          flushPending()
          pendingSessionId = item.sessionId
        }
        pendingEntries.push(item.entry)
        continue
      }

      flushPending()
      rendered.push(item)
    }

    flushPending()
    return rendered
  }, [combinedTimeline])

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [renderTimeline, autoScroll])

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
        <div className="max-w-[800px] mx-auto px-4 py-4">
          {renderTimeline.map((item, i) => {
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
              case 'idle':
                return (
                  <IdleMarker
                    key={`idle-${item.phase}`}
                    phase={item.phase}
                    timestamp={item.timestamp}
                  />
                )
              case 'stream-item': {
                const streamItem = item.item
                // Pair Bash/Read tool-calls with their matching result (scan forward by toolUseId)
                let pairedResult: ToolResultItem | undefined
                if (streamItem.kind === 'tool-call' && (streamItem.toolName === 'Bash' || streamItem.toolName === 'Read')) {
                  for (let j = i + 1; j < renderTimeline.length && j < i + 20; j++) {
                    const candidate = renderTimeline[j]
                    if (candidate?.kind === 'stream-item' && candidate.item.kind === 'tool-result' && candidate.item.toolUseId === streamItem.toolUseId) {
                      pairedResult = candidate.item
                      break
                    }
                  }
                }
                // Skip tool-results that were already paired with a Bash/Read call above
                if (streamItem.kind === 'tool-result' && streamItem.toolUseId) {
                  const isPaired = renderTimeline.slice(Math.max(0, i - 20), i).some(
                    (prev) => prev.kind === 'stream-item' && prev.item.kind === 'tool-call' &&
                      (prev.item.toolName === 'Bash' || prev.item.toolName === 'Read') &&
                      prev.item.toolUseId === streamItem.toolUseId
                  )
                  if (isPaired) return null
                }
                return (
                  <StreamItemRenderer
                    key={`${item.sessionId}-${streamItem.id}`}
                    item={streamItem}
                    pairedResult={pairedResult}
                    defaultExpanded={isLive}
                  />
                )
              }
            }
          })}
        </div>
      </div>

      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true)
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
          }}
          className="fixed bottom-4 right-4 bg-zinc-700 hover:bg-zinc-600 text-white text-xs px-3 py-1.5 rounded-full shadow-lg"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  )
}
