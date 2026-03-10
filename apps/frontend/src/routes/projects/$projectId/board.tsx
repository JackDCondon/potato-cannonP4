import { createFileRoute, redirect } from '@tanstack/react-router'
import { api } from '@/api/client'

export const Route = createFileRoute('/projects/$projectId/board')({
  beforeLoad: async ({ params }) => {
    const { projectId: projectSlug } = params

    // Look up the project by slug to get its actual ID
    const projects = await api.getProjects()
    const project = projects?.find((p) => p.slug === projectSlug)

    if (!project) {
      return
    }

    // Fetch workflows and redirect to the default one
    const workflows = await api.getWorkflows(project.id)
    const defaultWorkflow = workflows?.find((w) => w.isDefault) ?? workflows?.[0]

    if (defaultWorkflow) {
      throw redirect({
        to: '/projects/$projectId/workflows/$workflowId/board',
        params: { projectId: projectSlug, workflowId: defaultWorkflow.id }
      })
    }
  },
  component: () => null
})
