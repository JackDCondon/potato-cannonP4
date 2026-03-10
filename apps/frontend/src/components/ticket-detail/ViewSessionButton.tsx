import { Monitor } from 'lucide-react'

interface ViewSessionButtonProps {
  projectId: string
  ticketId: string
  hasActiveSession?: boolean
}

export function ViewSessionButton({ projectId, ticketId }: ViewSessionButtonProps) {
  const handleClick = () => {
    const url = `/#/transcript/ticket/${encodeURIComponent(ticketId)}?projectId=${encodeURIComponent(projectId)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
    >
      <Monitor className="h-4 w-4" />
      View Session
    </button>
  )
}
