import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { WorkflowDeletePreviewResponse } from '@/api/client'

interface DeleteWorkflowDialogProps {
  open: boolean
  workflowName: string
  preview: WorkflowDeletePreviewResponse | null
  isDeleting: boolean
  onCancel: () => void
  onConfirm: (confirmation: string) => void
}

export function DeleteWorkflowDialog({
  open,
  workflowName,
  preview,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteWorkflowDialogProps) {
  const [confirmation, setConfirmation] = useState('')

  const confirmationRequired =
    preview?.requiresForce === true && preview.expectedConfirmation.length > 0
  const isConfirmationValid = useMemo(() => {
    if (!confirmationRequired || !preview) return true
    return confirmation.trim() === preview.expectedConfirmation
  }, [confirmationRequired, preview, confirmation])

  const handleConfirm = () => {
    onConfirm(confirmation.trim())
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setConfirmation('')
          onCancel()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete workflow with tickets?</DialogTitle>
          <DialogDescription>
            "{workflowName}" currently has {preview?.ticketCount ?? 0} ticket(s). Deleting this
            workflow will permanently delete those tickets and their active lifecycle state.
          </DialogDescription>
        </DialogHeader>

        {confirmationRequired && preview && (
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">
              Type <code>{preview.expectedConfirmation}</code> to confirm deletion.
            </p>
            <Input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={preview.expectedConfirmation}
              aria-label="Delete workflow confirmation"
              disabled={isDeleting}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isDeleting || !isConfirmationValid}
            onClick={handleConfirm}
          >
            {isDeleting ? 'Deleting…' : 'Delete Workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
