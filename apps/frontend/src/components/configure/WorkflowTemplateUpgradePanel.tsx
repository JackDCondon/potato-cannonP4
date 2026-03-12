import { useState } from 'react'
import { AlertTriangle, RefreshCw, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChangelogModal } from '@/components/ChangelogModal'
import { useUpgradeWorkflowTemplate, useWorkflowTemplateStatus } from '@/hooks/queries'

interface WorkflowTemplateUpgradePanelProps {
  projectId: string
  workflowId: string
  workflowName: string
}

export function WorkflowTemplateUpgradePanel({
  projectId,
  workflowId,
  workflowName,
}: WorkflowTemplateUpgradePanelProps) {
  const { data: status, isLoading } = useWorkflowTemplateStatus(projectId, workflowId)
  const upgradeMutation = useUpgradeWorkflowTemplate()
  const [showConfirm, setShowConfirm] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)

  if (isLoading || !status) {
    return (
      <div className="text-xs text-text-secondary">
        Template version: loading…
      </div>
    )
  }

  const hasUpgrade = !!status.upgradeType
  const isMajor = status.upgradeType === 'major'
  const current = status.current ?? 'unknown'
  const available = status.available ?? 'unknown'

  function handleUpgrade() {
    if (isMajor) {
      setShowConfirm(true)
      return
    }
    upgradeMutation.mutate({ projectId, workflowId, force: false })
  }

  return (
    <>
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <span>
          v{current}
          {hasUpgrade ? ` -> v${available}` : ''}
        </span>
        {hasUpgrade && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setShowChangelog(true)}
            >
              <FileText className="h-3 w-3 mr-1" />
              Changelog
            </Button>
            <Button
              variant={isMajor ? 'destructive' : 'outline'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleUpgrade}
              disabled={upgradeMutation.isPending}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              {upgradeMutation.isPending ? 'Upgrading…' : 'Upgrade'}
            </Button>
          </>
        )}
      </div>

      {showChangelog && (
        <ChangelogModal
          projectId={projectId}
          workflowId={workflowId}
          onClose={() => setShowChangelog(false)}
        />
      )}

      {showConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-bg-secondary border border-border rounded-lg p-5 w-full max-w-md mx-4">
            <div className="flex items-center gap-2 mb-3 text-accent-red">
              <AlertTriangle className="h-4 w-4" />
              <h3 className="font-semibold">Major Upgrade Confirmation</h3>
            </div>
            <p className="text-sm text-text-secondary mb-4">
              Workflow <span className="font-medium text-text-primary">{workflowName}</span> will
              upgrade from <span className="font-mono">{current}</span> to{' '}
              <span className="font-mono">{available}</span>. This can reset in-progress work.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setShowConfirm(false)}
                disabled={upgradeMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={upgradeMutation.isPending}
                onClick={() => {
                  upgradeMutation.mutate(
                    { projectId, workflowId, force: true },
                    { onSuccess: () => setShowConfirm(false) },
                  )
                }}
              >
                {upgradeMutation.isPending ? 'Upgrading…' : 'Upgrade Anyway'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
