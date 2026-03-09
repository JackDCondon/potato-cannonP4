// apps/frontend/src/components/transcript/TranscriptPage.tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Circle, Copy } from 'lucide-react'
import { api } from '@/api/client'
import { EventRow } from './EventRow'
import { useSessionOutput, useSessionEnded } from '@/hooks/useSSE'
import { cn } from '@/lib/utils'
import type { SessionLogEntry } from '@/api/client'

interface TranscriptPageProps {
  sessionId: string
}

export function TranscriptPage({ sessionId }: TranscriptPageProps) {
  const [liveEntries, setLiveEntries] = useState<SessionLogEntry[]>([])
  const [isEndedBySSE, setIsEndedBySSE] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [totalTokens, setTotalTokens] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const { data: historicalEntries = [], isLoading } = useQuery({
    queryKey: ['session-log', sessionId],
    queryFn: () => api.getSessionLog(sessionId),
    retry: false,
  })

  const meta = historicalEntries.find(e => e.type === 'session_start')?.meta as Record<string, string> | undefined
  const ticketTitle = meta?.ticketTitle ?? sessionId
  const phase = meta?.phase ?? ''
  const agentType = meta?.agentType ?? ''

  useSessionOutput(useCallback((raw) => {
    const data = raw as { sessionId: string; event: SessionLogEntry }
    if (data.sessionId !== sessionId) return
    setLiveEntries(prev => [...prev, data.event])
    const tokens = (data.event as { usage?: { total_tokens?: number } }).usage?.total_tokens
    if (tokens) setTotalTokens(tokens)
  }, [sessionId]))

  useSessionEnded(useCallback((raw) => {
    const data = raw as { sessionId: string }
    if (data.sessionId === sessionId) setIsEndedBySSE(true)
  }, [sessionId]))

  // Fix 3: Detect completed sessions from historical data (no SSE session:ended will arrive)
  useEffect(() => {
    if (historicalEntries.length > 0) {
      const last = historicalEntries[historicalEntries.length - 1]
      if (last.type === 'system' && (last.subtype === 'session_end' || last.subtype === 'task_complete')) {
        setIsEndedBySSE(true)
      }
    }
  }, [historicalEntries])

  // Auto-scroll fires on both historical load and live updates
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [liveEntries, historicalEntries, autoScroll])

  const onScroll = () => {
    const el = scrollContainerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(atBottom)
  }

  const allEntries = [...historicalEntries, ...liveEntries]

  // Fix 3: isEnded combines SSE signal and historical end detection
  const isSessionHistorical = !isLoading && historicalEntries.length > 0 && liveEntries.length === 0
  const isEnded = isEndedBySSE || isSessionHistorical

  const copyTranscript = () => {
    const text = allEntries
      .filter(e => e.type !== 'session_start')
      .map(e => {
        if (e.type === 'assistant' && e.message) {
          return e.message.content
            // Fix 1: b.text ?? '' prevents "undefined" in clipboard output
            // Fix 2: b.name guard prevents "[Tool: undefined]"
            .map(b => b.type === 'text' ? (b.text ?? '') : (b.name ? `[Tool: ${b.name}]` : '[Tool]'))
            .join('\n')
        }
        if (e.type === 'raw') return e.content
        return null
      })
      .filter(Boolean)
      .join('\n\n')
    // Fix 4: Handle clipboard promise rejection
    navigator.clipboard.writeText(text ?? '').catch((err) => {
      console.error('Failed to copy transcript:', err)
    })
  }

  return (
    <div className="relative flex flex-col h-screen bg-zinc-950 text-text-primary">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-zinc-950/80 backdrop-blur shrink-0">
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold truncate">{ticketTitle}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            {phase && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-text-muted font-mono uppercase">
                {phase}{agentType ? ` · ${agentType}` : ''}
              </span>
            )}
            {totalTokens > 0 && (
              <span className="text-[10px] text-text-muted">{totalTokens.toLocaleString()} tokens</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {isEnded ? (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <Circle className="h-2 w-2 fill-zinc-500 text-zinc-500" />
              Ended
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <Circle className="h-2 w-2 fill-green-400 text-green-400 animate-pulse" />
              Live
            </span>
          )}
          <button
            onClick={copyTranscript}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
        </div>
      </header>

      <div
        ref={scrollContainerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto py-2"
      >
        {isLoading && (
          <div className="flex justify-center py-12 text-text-muted text-sm">Loading…</div>
        )}
        {allEntries.map((entry, i) => (
          <EventRow key={i} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>

      {!autoScroll && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <button
            onClick={() => {
              setAutoScroll(true)
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs',
              'bg-zinc-800 text-text-secondary hover:bg-zinc-700 transition-colors shadow-lg',
            )}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Jump to bottom
          </button>
        </div>
      )}
    </div>
  )
}
