import { Link, useLocation } from '@tanstack/react-router'
import { LayoutDashboard, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'

export function MobileBottomBar() {
  const location = useLocation()
  const closeTicketSheet = useAppStore((s) => s.closeTicketSheet)
  const closeBrainstormSheet = useAppStore((s) => s.closeBrainstormSheet)

  // Extract projectId and optional workflowId from URL
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/)
  const projectId = projectMatch ? decodeURIComponent(projectMatch[1]) : null
  const workflowMatch = location.pathname.match(/\/workflows\/([^/]+)/)
  const workflowId = workflowMatch ? decodeURIComponent(workflowMatch[1]) : null

  if (!projectId) return null // Don't show bar if not on a project route

  const isBoardActive = location.pathname.endsWith('/board')
  const isConfigureActive = location.pathname.endsWith('/configure')

  const handleNavClick = () => {
    closeTicketSheet()
    closeBrainstormSheet()
  }

  return (
    <nav className="sm:hidden absolute bottom-0 left-0 w-screen flex items-center px-2 py-2 border-t border-border bg-bg-secondary">
      <Link
        to={workflowId ? "/projects/$projectId/workflows/$workflowId/board" : "/projects/$projectId/board"}
        params={workflowId ? { projectId, workflowId } : { projectId }}
        onClick={handleNavClick}
        className={cn(
          'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors',
          isBoardActive
            ? 'bg-bg-tertiary text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-tertiary'
        )}
      >
        <LayoutDashboard className="h-5 w-5" />
        <span>Board</span>
      </Link>
      <Link
        to="/projects/$projectId/configure"
        params={{ projectId }}
        onClick={handleNavClick}
        className={cn(
          'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors',
          isConfigureActive
            ? 'bg-bg-tertiary text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-tertiary'
        )}
      >
        <SlidersHorizontal className="h-5 w-5" />
        <span>Configure</span>
      </Link>
    </nav>
  )
}
