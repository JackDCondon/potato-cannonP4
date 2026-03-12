import { useState } from 'react'
import { Trash2, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from './SettingsSection'
import { useWorkflows, useCreateWorkflow, useDeleteWorkflow, useTemplates } from '@/hooks/queries'
import { api, type WorkflowDeletePreviewResponse } from '@/api/client'
import { DeleteWorkflowDialog } from './DeleteWorkflowDialog'
import { WorkflowTemplateUpgradePanel } from './WorkflowTemplateUpgradePanel'
import type { Project, ProjectWorkflow } from '@potato-cannon/shared'

interface WorkflowRowProps {
  projectId: string
  workflow: ProjectWorkflow
  isOnlyWorkflow: boolean
  onDelete: (workflowId: string) => void
  isDeleting: boolean
}

function WorkflowRow({ projectId, workflow, isOnlyWorkflow, onDelete, isDeleting }: WorkflowRowProps) {
  const deleteDisabled = workflow.isDefault || isOnlyWorkflow || isDeleting

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-text-primary truncate">{workflow.name}</span>
          {workflow.isDefault && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">
              <Star className="h-3 w-3" />
              default
            </span>
          )}
        </div>
        <WorkflowTemplateUpgradePanel
          projectId={projectId}
          workflowId={workflow.id}
          workflowName={workflow.name}
        />
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={deleteDisabled}
        onClick={() => onDelete(workflow.id)}
        title={
          workflow.isDefault
            ? 'Cannot delete the default workflow'
            : isOnlyWorkflow
              ? 'Cannot delete the only workflow'
              : 'Delete workflow'
        }
        className="text-text-secondary hover:text-accent-red shrink-0"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

interface AddWorkflowFormProps {
  onSubmit: (name: string, templateName: string, onSuccess: () => void) => void
  isSubmitting: boolean
  templates: Array<{ name: string; isDefault?: boolean }> | undefined
  error?: Error | null
}

function AddWorkflowForm({ onSubmit, isSubmitting, templates, error }: AddWorkflowFormProps) {
  const [name, setName] = useState('')
  const [templateName, setTemplateName] = useState('')

  const defaultTemplate = templates?.find(t => t.isDefault)?.name ?? templates?.[0]?.name ?? ''

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const tpl = templateName || defaultTemplate
    if (!tpl) return
    onSubmit(trimmed, tpl, () => {
      setName('')
      setTemplateName('')
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 pt-4 border-t border-border">
      <p className="text-sm font-medium text-text-primary">Add Workflow</p>
      {error && <p className="text-sm text-red-500">{error.message}</p>}
      <div className="flex flex-col gap-2 @sm:flex-row">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Workflow name"
          className="flex-1"
          disabled={isSubmitting}
        />
        <Select
          value={templateName || defaultTemplate}
          onValueChange={setTemplateName}
          disabled={isSubmitting}
        >
          <SelectTrigger className="w-full @sm:w-48">
            <SelectValue placeholder="Template" />
          </SelectTrigger>
          <SelectContent>
            {templates?.map(t => (
              <SelectItem key={t.name} value={t.name}>
                {t.name}
                {t.isDefault ? ' (default)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={isSubmitting || !name.trim()} className="shrink-0">
          {isSubmitting ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </form>
  )
}

interface WorkflowsSectionProps {
  project: Project
}

export function WorkflowsSection({ project }: WorkflowsSectionProps) {
  const { data: workflows } = useWorkflows(project.id)
  const { data: templates } = useTemplates()
  const createWorkflow = useCreateWorkflow()
  const deleteWorkflow = useDeleteWorkflow()
  const [pendingDelete, setPendingDelete] = useState<ProjectWorkflow | null>(null)
  const [deletePreview, setDeletePreview] = useState<WorkflowDeletePreviewResponse | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)

  function handleAdd(name: string, templateName: string, onSuccess: () => void) {
    createWorkflow.mutate({ projectId: project.id, name, templateName }, { onSuccess })
  }

  async function handleDelete(workflow: ProjectWorkflow) {
    setIsPreviewLoading(true)
    try {
      const preview = await api.getWorkflowDeletePreview(project.id, workflow.id)
      if (preview.ticketCount === 0) {
        deleteWorkflow.mutate(
          { projectId: project.id, workflowId: workflow.id },
          { onError: (err) => console.error('delete workflow failed', err) },
        )
        return
      }
      setPendingDelete(workflow)
      setDeletePreview(preview)
    } catch (err) {
      console.error('failed to load workflow delete preview', err)
    } finally {
      setIsPreviewLoading(false)
    }
  }

  function handleCancelDeleteDialog() {
    setPendingDelete(null)
    setDeletePreview(null)
  }

  function handleConfirmDelete(confirmation: string) {
    if (!pendingDelete || !deletePreview) return
    deleteWorkflow.mutate(
      {
        projectId: project.id,
        workflowId: pendingDelete.id,
        force: true,
        confirmation,
      },
      {
        onSuccess: () => {
          setPendingDelete(null)
          setDeletePreview(null)
        },
        onError: (err) => console.error('delete workflow failed', err),
      },
    )
  }

  return (
    <SettingsSection
      title="Workflows"
      description="Manage independent workflow boards for this project. Each workflow has its own ticket queue and kanban board."
    >
      <div className="space-y-1">
        {workflows && workflows.length > 0 ? (
          <div className="divide-y divide-border">
            {workflows.map(wf => (
              <WorkflowRow
                key={wf.id}
                projectId={project.id}
                workflow={wf}
                isOnlyWorkflow={workflows.length === 1}
                onDelete={(workflowId) => {
                  const workflow = workflows.find((item) => item.id === workflowId)
                  if (workflow) {
                    void handleDelete(workflow)
                  }
                }}
                isDeleting={deleteWorkflow.isPending || isPreviewLoading}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-secondary py-2">No workflows yet.</p>
        )}

        <AddWorkflowForm
          onSubmit={handleAdd}
          isSubmitting={createWorkflow.isPending}
          templates={templates}
          error={createWorkflow.error}
        />
      </div>
      <DeleteWorkflowDialog
        open={!!pendingDelete}
        workflowName={pendingDelete?.name ?? ''}
        preview={deletePreview}
        isDeleting={deleteWorkflow.isPending}
        onCancel={handleCancelDeleteDialog}
        onConfirm={handleConfirmDelete}
      />
    </SettingsSection>
  )
}
