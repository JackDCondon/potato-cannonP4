import { useState, useCallback, type KeyboardEvent } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useProjects } from '@/hooks/queries'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

/** Extract workflowId from /projects/:slug/workflows/:workflowId/board paths */
function getCurrentWorkflowId(pathname: string): string | undefined {
  const match = pathname.match(/\/workflows\/([^/]+)\/board/)
  return match?.[1]
}

export function AddTicketModal() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const { data: projects } = useProjects()
  const currentProjectId = useAppStore((s) => s.currentProjectId)
  const isOpen = useAppStore((s) => s.addTicketModalOpen)
  const closeModal = useAppStore((s) => s.closeAddTicketModal)
  const routeProjectSlugMatch = location.pathname.match(/^\/projects\/([^/]+)/)
  const routeProjectSlug = routeProjectSlugMatch ? decodeURIComponent(routeProjectSlugMatch[1]) : null
  const routeProject = projects?.find((project) => project.slug === routeProjectSlug)
  const effectiveProjectId = routeProject?.id ?? currentProjectId

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetForm = useCallback(() => {
    setTitle('')
    setDescription('')
    setError(null)
  }, [])

  const handleClose = useCallback(() => {
    resetForm()
    closeModal()
  }, [closeModal, resetForm])

  const handleSubmit = useCallback(async () => {
    if (!effectiveProjectId || !title.trim()) {
      if (!effectiveProjectId) {
        setError('No active project selected')
      }
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const workflowId = getCurrentWorkflowId(location.pathname)
      const body: Record<string, string> = { title: title.trim() }
      const trimmedDesc = description.trim()
      if (trimmedDesc) body.description = trimmedDesc
      if (workflowId) body.workflowId = workflowId

      const res = await fetch(`/api/tickets/${encodeURIComponent(effectiveProjectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(err.message || err.error || 'Request failed')
      }

      queryClient.invalidateQueries({ queryKey: ['tickets', effectiveProjectId] })
      queryClient.invalidateQueries({ queryKey: ['tickets', effectiveProjectId, workflowId ?? null] })
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket')
    } finally {
      setIsSubmitting(false)
    }
  }, [effectiveProjectId, title, description, queryClient, handleClose, location.pathname])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && title.trim() && !isSubmitting) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="bg-bg-secondary border-border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-text-primary">New Ticket</DialogTitle>
          <DialogDescription className="text-text-secondary">
            Create a new ticket in the current project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label htmlFor="ticket-title" className="text-sm text-text-secondary">
              Title
            </label>
            <Input
              id="ticket-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ticket title"
              disabled={isSubmitting}
              autoFocus
              autoComplete="off"
              className="bg-bg-tertiary border-border"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="ticket-description" className="text-sm text-text-secondary">
              Description <span className="text-text-muted">(optional)</span>
            </label>
            <Textarea
              id="ticket-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ticket description (supports markdown)"
              disabled={isSubmitting}
              className="bg-bg-tertiary border-border min-h-[120px] resize-y"
            />
          </div>

          {error && (
            <p className="text-sm text-accent-red">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!title.trim() || isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Ticket'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
