import { createFileRoute } from '@tanstack/react-router'
import { TicketTranscriptPage } from '@/components/transcript/TicketTranscriptPage'

export const Route = createFileRoute('/transcript/ticket/$ticketId')({
  validateSearch: (search: Record<string, unknown>) => ({
    projectId: String(search.projectId ?? ''),
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { ticketId } = Route.useParams()
  const { projectId } = Route.useSearch()
  return <TicketTranscriptPage projectId={projectId} ticketId={ticketId} />
}
