import { Loader2, Bot } from 'lucide-react'
import { usePhaseWorkers } from '@/hooks/queries'
import { WorkerTreeItem } from './WorkerTreeItem'

interface WorkerTreeProps {
  projectId: string
  phase: string
  workflowId?: string | null
  onAgentClick: (agentType: string, agentName: string, model?: string) => void
}

export function WorkerTree({ projectId, phase, workflowId, onAgentClick }: WorkerTreeProps) {
  const { data, isLoading, error } = usePhaseWorkers(projectId, phase, workflowId)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-xs text-accent-red py-2">
        Failed to load workers
      </div>
    )
  }

  if (!data?.workers || data.workers.length === 0) {
    return (
      <div className="flex items-center gap-2 py-4 text-text-muted">
        <Bot className="h-4 w-4" />
        <span className="text-xs">No workers configured for this phase</span>
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {data.workers.map((worker, index) => (
        <WorkerTreeItem
          key={worker.id}
          node={worker}
          depth={0}
          isLastChild={index === data.workers.length - 1}
          onAgentClick={onAgentClick}
        />
      ))}
    </div>
  )
}
