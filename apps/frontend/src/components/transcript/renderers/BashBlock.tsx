import { useState } from 'react'
import { Terminal, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolCallItem, ToolResultItem } from '../transcript-presentation'

interface Props {
  call: ToolCallItem
  result?: ToolResultItem
  defaultExpanded?: boolean
}

export function BashBlock({ call, result, defaultExpanded }: Props) {
  const command = String(call.toolInput.command ?? '')
  const output = result?.content ?? ''
  const lineCount = output.split('\n').length
  const isLong = lineCount > 20
  const [expanded, setExpanded] = useState(defaultExpanded ?? !isLong)

  return (
    <div className={cn(
      'my-1 rounded border font-mono text-xs',
      result?.isError
        ? 'border-accent-red/30 bg-zinc-900/80'
        : 'border-border/30 bg-zinc-900/80',
    )}>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Terminal className="h-3 w-3 text-accent-green shrink-0" />
        <span className="text-accent-green">$</span>
        <span className="text-text-primary truncate">{command}</span>
      </div>
      {output && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            className="w-full flex items-center gap-1 px-2 py-0.5 text-left text-text-muted hover:text-text-secondary transition-colors border-t border-border/20"
          >
            {expanded
              ? <ChevronDown className="h-3 w-3 shrink-0" />
              : <ChevronRight className="h-3 w-3 shrink-0" />}
            <span>output</span>
            {isLong && !expanded && (
              <span className="ml-auto">{lineCount} lines</span>
            )}
          </button>
          {expanded && (
            <pre className={cn(
              'px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto border-t border-border/20',
              result?.isError ? 'text-accent-red' : 'text-text-muted',
            )}>
              {output}
            </pre>
          )}
        </>
      )}
    </div>
  )
}
