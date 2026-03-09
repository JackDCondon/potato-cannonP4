import { Monitor } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

interface ViewSessionButtonProps {
  projectId: string
  ticketId: string
  hasActiveSession: boolean
}

export function ViewSessionButton({ projectId, ticketId, hasActiveSession }: ViewSessionButtonProps) {
  const { data } = useQuery({
    queryKey: ['active-session', projectId, ticketId],
    queryFn: () => api.getRemoteControl(projectId, ticketId),
    enabled: hasActiveSession,
    staleTime: 10_000,
  })

  const sessionId = data?.sessionId

  if (!hasActiveSession || !sessionId) {
    return (
      <button
        disabled
        className="flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border text-text-muted cursor-not-allowed opacity-50"
      >
        <Monitor className="h-4 w-4" />
        View Session
      </button>
    )
  }

  return (
    <a
      href={`/transcript/${sessionId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
    >
      <Monitor className="h-4 w-4" />
      View Session
    </a>
  )
}
