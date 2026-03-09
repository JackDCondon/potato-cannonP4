import { useQuery } from '@tanstack/react-query'
import { Square, CheckSquare, Loader2, XSquare } from 'lucide-react'
import { api } from '@/api/client'
import type { Task } from '@potato-cannon/shared'

interface TaskListProps {
  projectId: string
  ticketId: string
  currentPhase: string
}

export function TaskList({ projectId, ticketId, currentPhase }: TaskListProps) {
  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['tasks', projectId, ticketId, currentPhase],
    queryFn: () => api.getTicketTasks(projectId, ticketId, currentPhase),
  })

  const visibleTasks = tasks.filter(t => t.status !== 'cancelled')

  if (visibleTasks.length === 0) {
    return null
  }

  return (
    <div className="px-4 pb-4">
      <div className="rounded-lg border border-border bg-bg-secondary p-3 max-h-[200px] overflow-y-auto shadow-sm">
        <div className="text-xs font-medium text-text-secondary mb-2">Tasks</div>
        <ul className="space-y-1">
          {visibleTasks.map((task) => (
            <li key={task.id} className="flex items-start gap-2">
              {task.status === 'completed' && (
                <CheckSquare className="h-4 w-4 text-accent shrink-0 mt-0.5" />
              )}
              {task.status === 'in_progress' && (
                <Loader2 className="h-4 w-4 text-accent shrink-0 mt-0.5 animate-spin" />
              )}
              {task.status === 'failed' && (
                <XSquare className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              )}
              {task.status === 'pending' && (
                <Square className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
              )}
              <span className={`text-sm ${
                task.status === 'completed' ? 'text-text-secondary line-through' :
                task.status === 'in_progress' ? 'text-accent' :
                task.status === 'failed' ? 'text-destructive' :
                'text-text-primary'
              }`}>
                {task.description}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
