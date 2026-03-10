import { createFileRoute } from '@tanstack/react-router'
import { Board } from '@/components/board/Board'
import { useProjects } from '@/hooks/queries'

export const Route = createFileRoute('/projects/$projectId/workflows/$workflowId/board')({
  component: WorkflowBoardPage
})

function WorkflowBoardPage() {
  // URL param is the slug, not the ID
  const { projectId: projectSlug, workflowId } = Route.useParams()
  const { data: projects } = useProjects()

  // Look up project by slug to get the actual ID for API calls
  const project = projects?.find((p) => p.slug === projectSlug)

  if (!project) {
    return null // Loading or project not found
  }

  return <Board projectId={project.id} workflowId={workflowId} />
}
