import { Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ViewSessionButtonProps {
  projectId: string
  ticketId: string
  compact?: boolean
}

export function ViewSessionButton({ projectId, ticketId, compact }: ViewSessionButtonProps) {
  const handleClick = () => {
    const url = `/#/transcript/ticket/${encodeURIComponent(ticketId)}?projectId=${encodeURIComponent(projectId)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        'flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors',
        compact
          ? 'px-1 py-0.5 text-xs'
          : 'px-3 py-1.5 text-sm rounded border border-border hover:border-text-muted'
      )}
    >
      <Monitor className={compact ? 'h-3 w-3' : 'h-4 w-4'} />
      {compact ? 'Session' : 'View Session'}
    </button>
  )
}
