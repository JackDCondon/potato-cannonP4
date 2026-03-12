import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Settings2, Bot } from 'lucide-react'
import { SwimlaneColorPicker } from './SwimlaneColorPicker'
import { WorkerTree } from './WorkerTree'
import { AgentPromptEditor } from './AgentPromptEditor'

interface SwimlaneBacksideProps {
  projectId: string
  phase: string
  workflowId?: string
  currentColor: string | undefined
  onColorChange: (color: string | null) => void
  disabled?: boolean
}

export function SwimlaneBackside({
  projectId,
  phase,
  workflowId,
  currentColor,
  onColorChange,
  disabled
}: SwimlaneBacksideProps) {
  // Agent editor state
  const [selectedAgent, setSelectedAgent] = useState<{
    agentType: string
    agentName: string
    modelTierLabel?: string
  } | null>(null)

  const handleAgentClick = useCallback((agentType: string, agentName: string, modelTierLabel?: string) => {
    setSelectedAgent({ agentType, agentName, modelTierLabel })
  }, [])

  const handleCloseEditor = useCallback(() => {
    setSelectedAgent(null)
  }, [])

  return (
    <>
      <div className="h-full flex flex-col p-4">
        {/* Header */}
        <div className="flex items-center gap-2 pb-4 border-b border-border">
          <Settings2 className="h-4 w-4 text-text-muted" />
          <h3 className="text-text-secondary font-semibold text-[13px]">
            {phase} Settings
          </h3>
        </div>

        {/* Configuration options */}
        <div className="flex-1 overflow-y-auto py-4 space-y-6">
          {/* Color setting */}
          <div className="space-y-3">
            <label className="text-xs text-text-muted uppercase tracking-wider">
              Column Color
            </label>
            <SwimlaneColorPicker
              value={currentColor}
              onChange={onColorChange}
              disabled={disabled}
            />
          </div>

          {/* Worker tree */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-xs text-text-muted uppercase tracking-wider">
              <Bot className="h-3 w-3" />
              Phase Workers
            </label>
            <div className="p-3 rounded-lg bg-bg-tertiary/50 border border-border">
              <WorkerTree
                projectId={projectId}
                phase={phase}
                workflowId={workflowId}
                onAgentClick={handleAgentClick}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Agent Prompt Editor Modal - Portaled to body to escape transform context */}
      {selectedAgent && createPortal(
        <AgentPromptEditor
          projectId={projectId}
          agentType={selectedAgent.agentType}
          agentName={selectedAgent.agentName}
          modelTierLabel={selectedAgent.modelTierLabel}
          workflowId={workflowId}
          open={true}
          onClose={handleCloseEditor}
        />,
        document.body
      )}
    </>
  )
}
