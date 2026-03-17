import { useState } from 'react'
import { FileText, ChevronDown, ChevronRight } from 'lucide-react'
import type { ToolCallItem, ToolResultItem } from '../transcript-presentation'

interface Props {
  call: ToolCallItem
  result?: ToolResultItem
  defaultExpanded?: boolean
}

export function FileReadPreview({ call, result, defaultExpanded }: Props) {
  const filePath = String(call.toolInput.file_path ?? call.toolInput.path ?? '')
  const content = result?.content ?? ''
  const lines = content.split('\n')
  const isLong = lines.length > 30
  const [expanded, setExpanded] = useState(defaultExpanded ?? !isLong)
  const [showAll, setShowAll] = useState(false)

  const displayLines = !showAll && isLong ? lines.slice(0, 30) : lines

  return (
    <div className="my-1 rounded border border-border/30 bg-bg-tertiary/20 text-xs">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-text-secondary hover:text-text-primary transition-colors"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" />
          : <ChevronRight className="h-3 w-3 shrink-0" />}
        <FileText className="h-3 w-3 shrink-0 text-accent" />
        <span className="font-mono truncate">{filePath}</span>
        <span className="ml-auto text-text-muted">{lines.length} lines</span>
      </button>
      {expanded && (
        <div className="border-t border-border/20">
          <pre className="px-2 py-1.5 overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto text-text-secondary">
            {displayLines.map((line, i) => (
              <div key={i} className="flex">
                <span className="select-none text-text-muted/50 w-8 text-right pr-2 shrink-0">{i + 1}</span>
                <span>{line}</span>
              </div>
            ))}
          </pre>
          {isLong && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full px-2 py-1 text-center text-accent text-xs hover:underline border-t border-border/20"
            >
              Show all {lines.length} lines
            </button>
          )}
        </div>
      )}
    </div>
  )
}
