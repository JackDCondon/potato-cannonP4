import { cn, formatTime } from '@/lib/utils'
import type { SystemMarkerItem } from '../transcript-presentation'

export function SystemMarker({ item }: { item: SystemMarkerItem }) {
  const tone =
    item.level === 'error'
      ? 'text-accent-red border-accent-red/20'
      : item.level === 'warning'
        ? 'text-accent-yellow border-accent-yellow/20'
        : 'text-text-muted border-border/30'

  return (
    <div className={cn('flex items-center gap-2 my-3 text-xs', tone)}>
      <div className="flex-1 border-t border-current/20" />
      <span className="uppercase tracking-wide font-medium whitespace-nowrap">
        {item.label}
      </span>
      {item.details && (
        <span className="text-text-muted">{item.details}</span>
      )}
      {item.timestamp && (
        <span className="text-text-muted">{formatTime(item.timestamp)}</span>
      )}
      <div className="flex-1 border-t border-current/20" />
    </div>
  )
}
