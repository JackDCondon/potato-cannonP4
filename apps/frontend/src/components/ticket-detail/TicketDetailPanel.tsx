import { useState, useMemo, useCallback, useEffect } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, X, AlertCircle } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import {
  useTicket,
  useProjectPhases,
  useUpdateTicket,
  useProjects,
  useTemplate,
  useWorkflows
} from '@/hooks/queries'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/utils'
import { DetailsTab } from './DetailsTab'
import { SettingsTab } from './SettingsTab'
import { ActivityTab } from './ActivityTab'
import type { TemplatePhase } from '@potato-cannon/shared'
import { ApiError, isTicketLifecycleConflictPayload } from '@/api/client'

/**
 * Checks if a phase has automation configured (workers array with items)
 */
function phaseHasAutomation(phaseConfig: TemplatePhase | undefined): boolean {
  if (!phaseConfig) return false
  return !!(phaseConfig.workers && phaseConfig.workers.length > 0)
}

/**
 * Ticket detail panel that pushes content instead of overlaying it.
 * Unlike a Sheet/drawer, this component participates in the flex layout
 * and causes the main content area to shrink when open.
 */
export function TicketDetailPanel() {
  const queryClient = useQueryClient()
  const ticketSheetOpen = useAppStore((s) => s.ticketSheetOpen)
  const ticketSheetTicketId = useAppStore((s) => s.ticketSheetTicketId)
  const ticketSheetProjectId = useAppStore((s) => s.ticketSheetProjectId)
  const closeTicketSheet = useAppStore((s) => s.closeTicketSheet)
  const location = useLocation()
  const routeProjectSlugMatch = location.pathname.match(/^\/projects\/([^/]+)/)
  const routeProjectSlug = routeProjectSlugMatch ? decodeURIComponent(routeProjectSlugMatch[1]) : null
  const isOnBoardView = /^\/projects\/[^/]+(?:\/workflows\/[^/]+)?\/board$/.test(location.pathname)

  const { data: projects } = useProjects()
  const currentProject = useMemo(
    () => projects?.find((p) => p.slug === routeProjectSlug),
    [projects, routeProjectSlug]
  )
  const currentProjectId = currentProject?.id ?? null
  const isCorrectProject = currentProjectId === ticketSheetProjectId
  const { data: workflows } = useWorkflows(currentProjectId)

  // Queries
  const { data: ticket, isLoading } = useTicket(currentProjectId, ticketSheetTicketId)
  const { data: projectPhases } = useProjectPhases(currentProjectId)
  const updateTicket = useUpdateTicket()

  const currentWorkflow = useMemo(
    () => workflows?.find((workflow) => workflow.id === ticket?.workflowId),
    [workflows, ticket?.workflowId]
  )
  const templateName = currentWorkflow?.templateName ?? currentProject?.template?.name ?? null
  const { data: templateConfig } = useTemplate(templateName, { full: true })
  const phases = useMemo(
    () => templateConfig?.phases.map((phase) => phase.name) ?? projectPhases,
    [templateConfig, projectPhases]
  )

  // Phase change confirmation dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    targetPhase: string
  } | null>(null)
  const [phaseConflictNotice, setPhaseConflictNotice] = useState<string | null>(null)

  // Tab state - resets to phase-based default when ticket changes
  const [activeTab, setActiveTab] = useState<string>('details')

  // Reset tab to phase-based default when ticket changes
  useEffect(() => {
    if (!ticket || !templateConfig) return
    const phaseConfig = templateConfig.phases.find((p) => p.name === ticket.phase)
    const newDefault = phaseHasAutomation(phaseConfig) ? 'activity' : 'details'
    setActiveTab(newDefault)
  }, [ticketSheetTicketId, ticket?.phase, templateConfig])

  // Build phase breadcrumb from history
  const phaseBreadcrumb = useMemo(() => {
    if (!ticket?.history || ticket.history.length === 0) return null
    // Show last 3 phases
    const recent = ticket.history.slice(-3)
    return recent.map((h) => h.phase)
  }, [ticket?.history])

  const handlePhaseChange = useCallback(
    (newPhase: string) => {
      if (!currentProjectId || !ticketSheetTicketId || newPhase === ticket?.phase) return

      // Check if target phase has automation
      const phaseConfig = templateConfig?.phases.find((p) => p.name === newPhase)
      const hasAutomation = phaseHasAutomation(phaseConfig)

      if (hasAutomation) {
        setConfirmDialog({
          open: true,
          targetPhase: newPhase
        })
      } else {
        updateTicket.mutate({
          projectId: currentProjectId,
          ticketId: ticketSheetTicketId,
          updates: { phase: newPhase }
        }, {
          onSuccess: () => {
            setPhaseConflictNotice(null)
          },
          onError: (error) => {
            if (error instanceof ApiError && isTicketLifecycleConflictPayload(error.payload)) {
              setPhaseConflictNotice(
                `Ticket changed while moving. It is currently in ${error.payload.currentPhase}. Please retry.`
              )
              queryClient.refetchQueries({ queryKey: ['ticket', currentProjectId, ticketSheetTicketId] })
              queryClient.refetchQueries({ queryKey: ['tickets', currentProjectId] })
            }
          }
        })
      }
    },
    [currentProjectId, queryClient, ticketSheetTicketId, ticket?.phase, templateConfig, updateTicket]
  )

  const handleConfirmMove = useCallback(() => {
    if (!confirmDialog || !currentProjectId || !ticketSheetTicketId) return

    updateTicket.mutate({
      projectId: currentProjectId,
      ticketId: ticketSheetTicketId,
      updates: { phase: confirmDialog.targetPhase }
    }, {
      onSuccess: () => {
        setPhaseConflictNotice(null)
      },
      onError: (error) => {
        if (error instanceof ApiError && isTicketLifecycleConflictPayload(error.payload)) {
          setPhaseConflictNotice(
            `Ticket changed while moving. It is currently in ${error.payload.currentPhase}. Please retry.`
          )
          queryClient.refetchQueries({ queryKey: ['ticket', currentProjectId, ticketSheetTicketId] })
          queryClient.refetchQueries({ queryKey: ['tickets', currentProjectId] })
        }
      }
    })

    setConfirmDialog(null)
  }, [confirmDialog, currentProjectId, queryClient, ticketSheetTicketId, updateTicket])

  const isOpen = ticketSheetOpen && isOnBoardView && isCorrectProject

  // Handle escape key to close panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      // Don't close if a Radix dialog is open (it handles its own escape)
      // Must check data-state="open" - the data-slot attribute is static and exists
      // even when the dialog is closed
      const openDialog = document.querySelector('[data-slot="dialog-content"][data-state="open"]')
      if (openDialog) return

      // If focus is in an input/textarea, blur it instead of closing
      const activeElement = document.activeElement
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        activeElement.blur()
        return
      }

      // Close the panel
      closeTicketSheet()
    }

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, closeTicketSheet])

  return (
    <>
      <div
        className="ticket-detail-panel"
        data-open={isOpen}
      >
        <div className="flex flex-col h-full w-[480px] max-w-full">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-text-muted" />
            </div>
          ) : ticket ? (
            <>
              {/* Header with close button */}
              <div className="flex items-start justify-between p-4 pb-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-text-muted font-mono text-xs">
                      {ticket.id}
                    </Badge>
                  </div>
                  <h2 className="text-text-primary text-lg font-semibold">
                    {ticket.title}
                  </h2>

                  {/* Phase breadcrumb */}
                  {phaseBreadcrumb && phaseBreadcrumb.length > 1 && (
                    <p className="text-xs text-text-muted flex items-center gap-1 mt-1">
                      {phaseBreadcrumb.map((phase, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span>{'>'}</span>}
                          <span className={i === phaseBreadcrumb.length - 1 ? 'text-text-secondary' : ''}>
                            {phase}
                          </span>
                        </span>
                      ))}
                    </p>
                  )}

                  {/* Timestamps */}
                  <p className="text-xs text-text-muted mt-2">
                    Created {timeAgo(ticket.createdAt)} • Updated {timeAgo(ticket.updatedAt)}
                  </p>
                  {phaseConflictNotice && (
                    <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 flex items-start gap-2">
                      <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>{phaseConflictNotice}</span>
                    </div>
                  )}

                  {/* Phase selector - mobile only */}
                  <div className="mt-4 flex items-center gap-2 sm:hidden">
                    <span className="text-sm text-text-secondary">Phase:</span>
                    <Select value={ticket.phase} onValueChange={handlePhaseChange}>
                      <SelectTrigger className="w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {phases?.map((phase) => (
                          <SelectItem key={phase} value={phase}>
                            {phase}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Close button */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-text-muted hover:text-text-primary"
                  onClick={closeTicketSheet}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </Button>
              </div>

              {/* Tabs */}
              <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
                <TabsList className="mx-4 mt-4 mb-2 w-fit">
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                  <TabsTrigger value="details">Details</TabsTrigger>
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                </TabsList>

                <TabsContent value="activity" className="mt-0 flex-1 flex flex-col min-h-0">
                  <ActivityTab
                    projectId={currentProjectId!}
                    ticketId={ticket.id}
                    ticketTitle={ticket.title}
                    currentPhase={ticket.phase}
                    history={ticket.history}
                    archived={ticket.archived}
                  />
                </TabsContent>
                <TabsContent value="details" className="mt-0 flex-1 min-h-0">
                  <ScrollArea className="h-full">
                    <div className="px-4 pb-4">
                      <DetailsTab
                        projectId={currentProjectId!}
                        ticketId={ticket.id}
                        workflowId={ticket.workflowId}
                        complexity={ticket.complexity}
                        description={ticket.description}
                        history={ticket.history}
                      />
                    </div>
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="settings" className="mt-0 flex-1 min-h-0">
                  <ScrollArea className="h-full">
                    <div className="px-4 pb-4">
                      <SettingsTab
                        projectId={currentProjectId!}
                        ticketId={ticket.id}
                        ticket={{ phase: ticket.phase, archived: ticket.archived }}
                        onDeleted={closeTicketSheet}
                        onArchived={closeTicketSheet}
                      />
                    </div>
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-text-muted">Ticket not found</p>
            </div>
          )}
        </div>
      </div>

      {/* Phase Change Confirmation Dialog */}
      <Dialog
        open={confirmDialog?.open ?? false}
        onOpenChange={(open) => !open && setConfirmDialog(null)}
      >
        <DialogContent className="bg-bg-secondary border-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">Start Automation?</DialogTitle>
            <DialogDescription className="text-text-secondary">
              Moving to <span className="font-medium text-accent">{confirmDialog?.targetPhase}</span>{' '}
              will start Claude automation. Continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog(null)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmMove}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
