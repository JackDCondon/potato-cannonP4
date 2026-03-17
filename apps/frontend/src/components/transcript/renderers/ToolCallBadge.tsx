import { Wrench } from 'lucide-react'
import type { ToolCallItem } from '../transcript-presentation'

function toolPrimaryArg(name: string, input: Record<string, unknown>): string {
  const fileTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit']
  if (fileTools.includes(name)) return String(input.file_path ?? input.path ?? '')
  if (name === 'Bash') return String(input.command ?? '').slice(0, 80)
  if (name === 'Grep' || name === 'Glob') return String(input.pattern ?? '').slice(0, 80)
  return String(Object.values(input)[0] ?? '').slice(0, 80)
}

export function ToolCallBadge({ item }: { item: ToolCallItem }) {
  const arg = toolPrimaryArg(item.toolName, item.toolInput)
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 my-1 rounded bg-bg-tertiary/40 border border-border/30 text-xs">
      <Wrench className="h-3 w-3 text-accent-yellow shrink-0" />
      <span className="font-mono font-medium text-accent-yellow">{item.toolName}</span>
      {arg && <span className="text-text-muted truncate">{arg}</span>}
    </div>
  )
}
