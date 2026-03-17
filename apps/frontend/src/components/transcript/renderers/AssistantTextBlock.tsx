import { renderMarkdown } from '@/lib/markdown'
import type { AssistantTextItem } from '../transcript-presentation'

export function AssistantTextBlock({ item }: { item: AssistantTextItem }) {
  const html = renderMarkdown(item.text)
  return (
    <div
      className="prose prose-invert prose-sm max-w-none px-1 py-1 text-text-primary leading-relaxed [&_pre]:bg-bg-tertiary [&_pre]:border [&_pre]:border-border/50 [&_pre]:rounded [&_code]:text-xs"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
