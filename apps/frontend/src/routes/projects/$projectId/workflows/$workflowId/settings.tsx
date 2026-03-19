import { createFileRoute } from '@tanstack/react-router'
import { BoardSettingsPage } from '@/components/configure/BoardSettingsPage'
import { useProjects } from '@/hooks/queries'

export const Route = createFileRoute('/projects/$projectId/workflows/$workflowId/settings')({
  component: WorkflowSettingsPage,
})

function WorkflowSettingsPage() {
  const { projectId: projectSlug, workflowId } = Route.useParams()
  const { data: projects } = useProjects()

  const project = projects?.find((p) => p.slug === projectSlug)

  if (!project) {
    return null
  }

  return <BoardSettingsPage projectId={project.id} workflowId={workflowId} />
}
