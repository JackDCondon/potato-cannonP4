import { useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle, LoaderCircle, ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import { cn, timeAgo } from '@/lib/utils'
import type { AttemptCard, RawMarker, SystemMarker } from './transcript-presentation'

interface AttemptCardProps {
  attempt: AttemptCard
  expandAll: boolean
}

function statusIcon(status: AttemptCard['status']) {
  if (status === 'error') {
    return <AlertTriangle className="h-3.5 w-3.5 text-accent-red shrink-0" />
  }
  if (status === 'in-progress') {
    return <LoaderCircle className="h-3.5 w-3.5 text-accent-yellow shrink-0 animate-spin" />
  }
  return <CheckCircle2 className="h-3.5 w-3.5 text-accent-green shrink-0" />
}

function statusPillClass(status: AttemptCard['status']): string {
  if (status === 'error') return 'text-accent-red bg-accent-red/10 border-accent-red/20'
  if (status === 'in-progress') return 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/20'
  return 'text-accent-green bg-accent-green/10 border-accent-green/20'
}

function toolPrimaryArg(name: string, input: Record<string, unknown>): string {
  const fileTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit']
  if (fileTools.includes(name)) return String(input.file_path ?? input.path ?? '')
  if (name === 'Bash') return String(input.command ?? '').slice(0, 80)
  return String(Object.values(input)[0] ?? '').slice(0, 80)
}

function SectionToggle({
  title,
  open,
  onToggle,
}: {
  title: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-1.5 text-left text-xs text-text-secondary hover:text-text-primary transition-colors"
    >
      {open
        ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
      }
      <span>{title}</span>
    </button>
  )
}

export function TranscriptAttemptCard({ attempt, expandAll }: AttemptCardProps) {
  const [openAssistant, setOpenAssistant] = useState(false)
  const [openTools, setOpenTools] = useState(false)
  const [openResults, setOpenResults] = useState(false)

  useEffect(() => {
    setOpenAssistant(expandAll)
    setOpenTools(expandAll)
    setOpenResults(expandAll)
  }, [expandAll])

  return (
    <article data-testid="attempt-card" className={cn(
      'mx-3 my-2 rounded-md border border-border bg-bg-secondary',
      attempt.status === 'error' && 'border-accent-red/35',
    )}>
      <header className="px-3 py-2 border-b border-border/60">
        <div className="flex items-center gap-2">
          {statusIcon(attempt.status)}
          <span className="text-xs font-semibold text-text-primary">Assistant Attempt</span>
          <span className={cn('ml-auto text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wide', statusPillClass(attempt.status))}>
            {attempt.status}
          </span>
        </div>
        <div className="mt-1 text-xs text-text-secondary line-clamp-2">
          {attempt.summary}
        </div>
        <div className="mt-2 flex items-center gap-3 text-[10px] text-text-muted">
          <span>{attempt.toolUses.length} tools</span>
          <span>{attempt.toolResults.length} results</span>
          <span>{attempt.toolResults.filter((r) => r.isError).length} errors</span>
          {attempt.startedAt && <span className="ml-auto">{timeAgo(attempt.startedAt)}</span>}
        </div>
      </header>

      <div className="px-3 py-2 space-y-2">
        <SectionToggle
          title={`Assistant message (${attempt.assistantTextBlocks.length})`}
          open={openAssistant}
          onToggle={() => setOpenAssistant((v) => !v)}
        />
        {openAssistant && (
          <div className="text-xs text-text-secondary whitespace-pre-wrap rounded bg-bg-tertiary/40 border border-border/50 px-2.5 py-2">
            {attempt.assistantTextBlocks.join('\n\n') || 'No assistant message captured.'}
          </div>
        )}

        <SectionToggle
          title={`Tool calls (${attempt.toolUses.length})`}
          open={openTools}
          onToggle={() => setOpenTools((v) => !v)}
        />
        {openTools && (
          <div className="space-y-1.5">
            {attempt.toolUses.length === 0 && (
              <div className="text-xs text-text-muted italic">No tool calls.</div>
            )}
            {attempt.toolUses.map((tool) => (
              <div key={tool.id} className="rounded border border-border/50 bg-bg-tertiary/40 px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-xs">
                  <Wrench className="h-3 w-3 text-accent-yellow shrink-0" />
                  <span className="font-mono text-accent-yellow">{tool.name}</span>
                  <span className="text-text-muted truncate">{toolPrimaryArg(tool.name, tool.input)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <SectionToggle
          title={`Tool results (${attempt.toolResults.length})`}
          open={openResults}
          onToggle={() => setOpenResults((v) => !v)}
        />
        {openResults && (
          <div className="space-y-1.5">
            {attempt.toolResults.length === 0 && (
              <div className="text-xs text-text-muted italic">No tool results.</div>
            )}
            {attempt.toolResults.map((result, i) => (
              <div
                key={`${result.toolUseId ?? 'orphan'}-${i}`}
                className={cn(
                  'rounded border px-2 py-1.5 text-xs whitespace-pre-wrap',
                  result.isError
                    ? 'border-accent-red/30 bg-accent-red/10 text-accent-red'
                    : 'border-border/50 bg-bg-tertiary/40 text-text-secondary',
                )}
              >
                {result.content || '(empty result)'}
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export function TranscriptSystemMarker({ marker }: { marker: SystemMarker }) {
  const tone =
    marker.level === 'error'
      ? 'text-accent-red border-accent-red/30 bg-accent-red/10'
      : marker.level === 'warning'
        ? 'text-accent-yellow border-accent-yellow/30 bg-accent-yellow/10'
        : 'text-accent border-accent/30 bg-accent/10'

  return (
    <div data-testid="system-marker" className={cn('mx-3 my-2 rounded border px-3 py-2 text-xs', tone)}>
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide font-semibold">{marker.label}</span>
        {marker.timestamp && <span className="ml-auto opacity-80">{timeAgo(marker.timestamp)}</span>}
      </div>
      {marker.details && <div className="mt-1 text-text-secondary">{marker.details}</div>}
    </div>
  )
}

export function TranscriptRawMarker({ marker }: { marker: RawMarker }) {
  return (
    <pre data-testid="raw-marker" className="mx-3 my-2 rounded border border-border/50 bg-bg-tertiary/30 px-3 py-2 text-xs text-text-muted whitespace-pre-wrap overflow-x-auto">
      {marker.content}
    </pre>
  )
}

