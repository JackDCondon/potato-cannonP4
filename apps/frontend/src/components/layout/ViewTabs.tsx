import { Link, useLocation } from '@tanstack/react-router'
import { LayoutDashboard, SlidersHorizontal, Cog } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function ViewTabs() {
  const location = useLocation()

  // Extract projectId from URL
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/)
  const projectId = projectMatch ? decodeURIComponent(projectMatch[1]) : null

  if (!projectId) return null // Don't show tabs if not on a project route

  const isBoardActive = location.pathname.endsWith('/board')
  const isConfigureActive = location.pathname.endsWith('/configure')

  return (
    <nav className="hidden sm:flex flex-1 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/projects/$projectId/board"
            params={{ projectId }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
              isBoardActive
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            )}
          >
            <LayoutDashboard className="h-4 w-4" />
            <span>Board</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent>An AI Assisted Kanban board</TooltipContent>
      </Tooltip>
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/global-configure"
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
              location.pathname === '/global-configure'
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            )}
          >
            <Cog className="h-4 w-4" />
            <span>Global</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent>Global Settings</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/projects/$projectId/configure"
            params={{ projectId }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
              isConfigureActive
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span>Configure</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent>Configure Project</TooltipContent>
      </Tooltip>
    </nav>
  )
}
