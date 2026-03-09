import { createFileRoute } from '@tanstack/react-router'
import { TranscriptPage } from '@/components/transcript/TranscriptPage'

export const Route = createFileRoute('/transcript/$sessionId')({
  component: TranscriptPageRoute,
})

function TranscriptPageRoute() {
  const { sessionId } = Route.useParams()
  return <TranscriptPage sessionId={sessionId} />
}
