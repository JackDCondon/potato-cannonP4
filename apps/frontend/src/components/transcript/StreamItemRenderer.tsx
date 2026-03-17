import type { StreamItem, ToolResultItem } from './transcript-presentation'
import {
  AssistantTextBlock,
  ThinkingBlock,
  ToolCallBadge,
  ToolResultBlock,
  BashBlock,
  FileReadPreview,
  SystemMarker,
} from './renderers'

interface Props {
  item: StreamItem
  /** For tool-call items, the paired result (if next item is a matching result) */
  pairedResult?: ToolResultItem
  /** Whether tool results should default to expanded */
  defaultExpanded?: boolean
}

export function StreamItemRenderer({ item, pairedResult, defaultExpanded }: Props) {
  switch (item.kind) {
    case 'assistant-text':
      return <AssistantTextBlock item={item} />

    case 'thinking':
      return <ThinkingBlock item={item} />

    case 'tool-call': {
      // Bash and Read get compound widgets
      if (item.toolName === 'Bash') {
        return <BashBlock call={item} result={pairedResult} defaultExpanded={defaultExpanded} />
      }
      if (item.toolName === 'Read') {
        return <FileReadPreview call={item} result={pairedResult} defaultExpanded={defaultExpanded} />
      }
      return <ToolCallBadge item={item} />
    }

    case 'tool-result':
      // Standalone result (not paired with a Bash/Read call above)
      return <ToolResultBlock item={item} defaultExpanded={defaultExpanded} />

    case 'system-marker':
      return <SystemMarker item={item} />

    case 'raw':
      return (
        <pre className="px-2 py-1 my-1 text-xs text-text-muted whitespace-pre-wrap font-mono">
          {item.content}
        </pre>
      )

    default:
      return null
  }
}
