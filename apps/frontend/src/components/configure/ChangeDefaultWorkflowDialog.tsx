import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import type { ProjectWorkflow } from '@potato-cannon/shared'

interface ChangeDefaultWorkflowDialogProps {
  open: boolean
  workflows: ProjectWorkflow[]
  currentDefaultId: string
  isUpdating: boolean
  onCancel: () => void
  onConfirm: (workflowId: string) => void
}

export function ChangeDefaultWorkflowDialog({
  open,
  workflows,
  currentDefaultId,
  isUpdating,
  onCancel,
  onConfirm,
}: ChangeDefaultWorkflowDialogProps) {
  const [selectedId, setSelectedId] = useState<string>('')

  const nonDefaultWorkflows = workflows.filter(wf => wf.id !== currentDefaultId)

  const handleConfirm = () => {
    if (selectedId) {
      onConfirm(selectedId)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setSelectedId('')
          onCancel()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Default Workflow</DialogTitle>
          <DialogDescription>
            New tickets will use the selected workflow by default. The previous
            default workflow can then be deleted if no tickets reference it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary">
            New default workflow
          </label>
          <Select
            value={selectedId}
            onValueChange={setSelectedId}
            disabled={isUpdating}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a workflow" />
            </SelectTrigger>
            <SelectContent>
              {nonDefaultWorkflows.map(wf => (
                <SelectItem key={wf.id} value={wf.id}>
                  {wf.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isUpdating}>
            Cancel
          </Button>
          <Button
            disabled={isUpdating || !selectedId}
            onClick={handleConfirm}
          >
            {isUpdating ? 'Updating...' : 'Change Default'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
