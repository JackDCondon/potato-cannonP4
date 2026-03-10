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
import { buildTranscriptRenderableItems, type TranscriptRenderableItem } from './transcript-presentation'
import { TranscriptAttemptCard, TranscriptRawMarker, TranscriptSystemMarker } from './TranscriptAttemptCard'

// ─── Types ───────────────────────────────────────────────────────────────────

type TimelineEntry =
  | { kind: 'phase-divider'; session: SessionMeta }
  | { kind: 'entry'; sessionId: string; entry: SessionLogEntry }
  | { kind: 'idle'; phase: string; timestamp: string }

type RenderTimelineEntry =
  | { kind: 'phase-divider'; session: SessionMeta }
  | { kind: 'idle'; phase: string; timestamp: string }
  | { kind: 'renderable'; sessionId: string; item: TranscriptRenderableItem }

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
  const [showSystemEvents, setShowSystemEvents] = useState(false)
  const [showRawEvents, setShowRawEvents] = useState(false)
  const [expandAllDetails, setExpandAllDetails] = useState(false)

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
      const items = buildTranscriptRenderableItems(pendingEntries, {
        showSystemEvents,
        showRawEvents,
      })
      for (const item of items) {
        rendered.push({ kind: 'renderable', sessionId: pendingSessionId, item })
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
      if (item.kind === 'phase-divider') {
        rendered.push(item)
      } else if (item.kind === 'idle') {
        rendered.push(item)
      }
    }

    flushPending()
    return rendered
  }, [combinedTimeline, showSystemEvents, showRawEvents])

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
        <div className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur border-b border-white/10 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowSystemEvents((v) => !v)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${showSystemEvents
                ? 'bg-accent/10 border-accent/30 text-accent'
                : 'bg-bg-tertiary/40 border-border text-text-secondary hover:text-text-primary'}`}
            >
              Show system events
            </button>
            <button
              onClick={() => setShowRawEvents((v) => !v)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${showRawEvents
                ? 'bg-accent-yellow/10 border-accent-yellow/30 text-accent-yellow'
                : 'bg-bg-tertiary/40 border-border text-text-secondary hover:text-text-primary'}`}
            >
              Show raw events
            </button>
            <button
              onClick={() => setExpandAllDetails((v) => !v)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${expandAllDetails
                ? 'bg-accent-green/10 border-accent-green/30 text-accent-green'
                : 'bg-bg-tertiary/40 border-border text-text-secondary hover:text-text-primary'}`}
            >
              Expand all details
            </button>
          </div>
        </div>

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
            case 'renderable':
              if (item.item.kind === 'attempt') {
                return (
                  <TranscriptAttemptCard
                    key={`attempt-${item.sessionId}-${item.item.id}-${i}`}
                    attempt={item.item}
                    expandAll={expandAllDetails}
                  />
                )
              }
              if (item.item.kind === 'system') {
                return (
                  <TranscriptSystemMarker
                    key={`system-${item.sessionId}-${item.item.id}-${i}`}
                    marker={item.item}
                  />
                )
              }
              return (
                <TranscriptRawMarker
                  key={`raw-${item.sessionId}-${item.item.id}-${i}`}
                  marker={item.item}
                />
              )
          }
        })}
      </div>

      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true)
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
          }}
          className="fixed bottom-4 right-4 bg-zinc-700 hover:bg-zinc-600 text-white text-xs px-3 py-1.5 rounded-full"
        >
          ↓ Jump to bottom
        </button>
      )}
    </div>
  )
}
