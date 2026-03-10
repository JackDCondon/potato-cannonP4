import { Link } from '@tanstack/react-router'
import {
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from '@/components/ui/sidebar'
import type { ProjectWorkflow } from '@potato-cannon/shared'

interface WorkflowMenuItemProps {
  workflow: ProjectWorkflow
  projectSlug: string
  isActive: boolean
}

export function WorkflowMenuItem({
  workflow,
  projectSlug,
  isActive,
}: WorkflowMenuItemProps) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={isActive}>
        <Link
          to="/projects/$projectId/workflows/$workflowId/board"
          params={{ projectId: projectSlug, workflowId: workflow.id }}
        >
          <span>{workflow.name}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}
