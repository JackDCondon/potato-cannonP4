import { createFileRoute, redirect, isRedirect } from '@tanstack/react-router'
import { api } from '@/api/client'

export const Route = createFileRoute('/projects/$projectId/board')({
  beforeLoad: async ({ params }) => {
    const { projectId: projectSlug } = params

    try {
      // Look up the project by slug to get its actual ID
      const projects = await api.getProjects()
      const project = projects?.find((p) => p.slug === projectSlug)

      if (!project) {
        throw redirect({ to: '/projects/$projectId/configure', params: { projectId: projectSlug } })
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

      // No workflows found — redirect to configure
      throw redirect({ to: '/projects/$projectId/configure', params: { projectId: projectSlug } })
    } catch (e) {
      // Re-throw TanStack Router redirects as-is
      if (isRedirect(e)) {
        throw e
      }
      // On unexpected API failure, redirect to configure
      throw redirect({ to: '/projects/$projectId/configure', params: { projectId: projectSlug } })
    }
  },
  component: () => null
})
