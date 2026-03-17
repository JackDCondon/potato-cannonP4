import type { ThinkingItem } from '../transcript-presentation'

export function ThinkingBlock({ item }: { item: ThinkingItem }) {
  return (
    <div className="px-1 py-1 text-sm text-text-muted italic leading-relaxed whitespace-pre-wrap">
      {item.text}
    </div>
  )
}
