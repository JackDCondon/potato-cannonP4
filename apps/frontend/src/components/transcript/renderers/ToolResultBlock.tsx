import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolResultItem } from '../transcript-presentation'

interface Props {
  item: ToolResultItem
  defaultExpanded?: boolean
}

export function ToolResultBlock({ item, defaultExpanded }: Props) {
  const lineCount = item.content.split('\n').length
  const isLong = lineCount > 20
  const [expanded, setExpanded] = useState(defaultExpanded ?? !isLong)

  return (
    <div className={cn(
      'my-1 rounded border text-xs',
      item.isError
        ? 'border-accent-red/30 bg-accent-red/5'
        : 'border-border/30 bg-bg-tertiary/20',
    )}>
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-1 px-2 py-1 text-left text-text-muted hover:text-text-secondary transition-colors"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" />
          : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span>{item.toolName ? `${item.toolName} result` : 'Tool result'}</span>
        {isLong && !expanded && (
          <span className="ml-auto text-text-muted">{lineCount} lines</span>
        )}
      </button>
      {expanded && (
        <pre className={cn(
          'px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto border-t',
          item.isError ? 'text-accent-red border-accent-red/20' : 'text-text-secondary border-border/20',
        )}>
          {item.content || '(empty result)'}
        </pre>
      )}
    </div>
  )
}
