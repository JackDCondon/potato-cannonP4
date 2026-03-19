import { useState, useMemo, useCallback, useRef } from 'react'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  useTickets,
  useProjectPhases,
  useTemplate,
  useWorkflows,
  useUpdateTicket,
  useProjects,
  useToggleDisabledPhase,
  useUpdateProject,
  useBrainstorms
} from '@/hooks/queries'
import { TemplateUpgradeBanner } from '@/components/TemplateUpgradeBanner'
import { ArchivedSwimlane } from './ArchivedSwimlane'
import { BoardColumn } from './BoardColumn'
import { BrainstormColumn } from './BrainstormColumn'
import { TicketCard } from './TicketCard'
import { ViewToggle } from './ViewToggle'
import { TableView } from './TableView'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { Brainstorm, Ticket, TemplatePhase } from '@potato-cannon/shared'
import { getBlockedFromPhaseMap, phaseHasAutomation } from './board-utils'


/**
 * Checks if a phase is a manual checkpoint (eligible for toggle).
 * A phase is manual if it has transitions.manual: true and no automation.
 */
function isManualCheckpoint(
  phaseConfig: TemplatePhase | undefined,
  phaseName: string,
  allPhases: string[]
): boolean {
  // First and last phases (Ideas, Done) cannot be disabled
  if (allPhases.length > 0) {
    if (phaseName === allPhases[0] || phaseName === allPhases[allPhases.length - 1]) {
      return false
    }
  }

  if (!phaseConfig) return false

  // Must have manual: true in transitions
  if (!phaseConfig.transitions?.manual) return false

  // Must NOT have automation
  return !phaseHasAutomation(phaseConfig)
}

interface BoardProps {
  projectId: string
  workflowId?: string
}

type DialogType = 'automation' | 'dependency'

function getDependencyWarning(
  ticket: Ticket,
  targetPhase: string,
  phases: string[],
  blockedFromPhaseByTier: Record<'artifact-ready' | 'code-ready', string>
): { title: string; neededPhase: string } | null {
  const targetIndex = phases.findIndex((phase) => phase === targetPhase)
  if (targetIndex === -1) return null

  const unsatisfied = (ticket.blockedBy ?? []).filter((dep) => !dep.satisfied)
  for (const dep of unsatisfied) {
    const neededPhase = blockedFromPhaseByTier[dep.tier]
    const neededIndex = phases.findIndex((phase) => phase === neededPhase)
    if (neededIndex !== -1 && targetIndex >= neededIndex) {
      return { title: dep.title, neededPhase }
    }
  }
  return null
}

export function Board({ projectId, workflowId }: BoardProps) {
  // Queries
  const { data: projects } = useProjects()
  const { data: workflows } = useWorkflows(projectId)
  const { data: tickets, isLoading: ticketsLoading, error: ticketsError } = useTickets(projectId, workflowId)
  const { data: projectPhases } = useProjectPhases(projectId)
  const { data: brainstorms } = useBrainstorms(projectId)

  // Get current project to access template name
  const currentProject = useMemo(
    () => projects?.find((p) => p.id === projectId),
    [projects, projectId]
  )

  const activeWorkflow = useMemo(
    () =>
      workflowId
        ? workflows?.find((w) => w.id === workflowId)
        : workflows?.find((w) => w.isDefault) ?? workflows?.[0],
    [workflowId, workflows]
  )

  const activeTemplateName =
    activeWorkflow?.templateName ?? currentProject?.template?.name ?? null
  const { data: templateConfig } = useTemplate(activeTemplateName, { full: true })
  const phases = useMemo(
    () => templateConfig?.phases.map((phase) => phase.name) ?? projectPhases,
    [templateConfig, projectPhases]
  )
  const blockedFromPhaseByTier = useMemo(
    () => getBlockedFromPhaseMap(templateConfig?.phases),
    [templateConfig]
  )

  // Mutations
  const updateTicket = useUpdateTicket()
  const toggleDisabledPhase = useToggleDisabledPhase()
  const updateProject = useUpdateProject()

  // View mode from store
  const boardViewMode = useAppStore((s) => s.boardViewMode)
  const showArchivedTickets = useAppStore((s) => s.showArchivedTickets)

  const handleToggleDisabled = useCallback(
    (phaseName: string) => {
      if (!currentProject) return

      const isCurrentlyDisabled = currentProject.disabledPhases?.includes(phaseName) ?? false

      toggleDisabledPhase.mutate({
        projectId,
        phaseId: phaseName,
        disabled: !isCurrentlyDisabled
      })
    },
    [projectId, currentProject, toggleDisabledPhase]
  )

  const handleSwimlaneColorChange = useCallback(
    (phaseName: string, color: string | null) => {
      if (!currentProject) return

      const currentColors = currentProject.swimlaneColors || {}
      let newColors: Record<string, string>

      if (color === null) {
        // Remove the color for this phase
        const { [phaseName]: _, ...rest } = currentColors
        newColors = rest
      } else {
        // Set the color for this phase
        newColors = { ...currentColors, [phaseName]: color }
      }

      updateProject.mutate({
        id: projectId,
        updates: { swimlaneColors: newColors }
      })
    },
    [projectId, currentProject, updateProject]
  )

  // Sensors for drag and drop - require 5px movement before activating drag
  // This allows clicks to work normally on ticket cards
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5
      }
    })
  )

  // Convert vertical scroll to horizontal scroll on the board via callback ref,
  // unless the cursor is over a vertically-scrollable child (e.g. ticket list)
  const boardScrollRef = useCallback((el: HTMLDivElement | null) => {
    // Clean up previous listener if any
    const prev = boardScrollElRef.current
    if (prev && prev.__wheelHandler) {
      prev.removeEventListener('wheel', prev.__wheelHandler)
      delete prev.__wheelHandler
    }
    boardScrollElRef.current = el
    if (!el) return

    const scrollContainer = el
    function handleWheel(e: WheelEvent) {
      // Only convert vertical scroll (not already horizontal)
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return

      // Walk up from the event target to the board container.
      // If we hit a vertically-scrollable element that actually has overflow, bail out.
      let target = e.target as HTMLElement | null
      while (target && target !== scrollContainer) {
        const { overflowY } = getComputedStyle(target)
        const isScrollable = overflowY === 'auto' || overflowY === 'scroll'
        if (isScrollable && target.scrollHeight > target.clientHeight) {
          const canScrollDown = e.deltaY > 0 && target.scrollTop + target.clientHeight < target.scrollHeight
          const canScrollUp = e.deltaY < 0 && target.scrollTop > 0
          if (canScrollDown || canScrollUp) return
        }
        target = target.parentElement
      }

      e.preventDefault()
      scrollContainer.scrollLeft += e.deltaY
    }

    ;(el as any).__wheelHandler = handleWheel
    el.addEventListener('wheel', handleWheel, { passive: false })
  }, [])
  const boardScrollElRef = useRef<(HTMLDivElement & { __wheelHandler?: (e: WheelEvent) => void }) | null>(null)

  // Local state
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    type: DialogType
    ticketId: string
    targetPhase: string
    phaseName: string
    dependencyTitle?: string
    dependencyNeededPhase?: string
  } | null>(null)

  // Group tickets by phase
  const ticketsByPhase = useMemo(() => {
    const grouped: Record<string, Ticket[]> = {}
    if (phases) {
      phases.forEach((phase) => {
        grouped[phase] = []
      })
    }
    if (tickets) {
      tickets.forEach((ticket) => {
        if (grouped[ticket.phase]) {
          grouped[ticket.phase].push(ticket)
        } else if (phases && !phases.includes(ticket.phase)) {
          // Ticket in unknown phase - add to first phase
          if (phases[0]) {
            grouped[phases[0]].push(ticket)
          }
        }
      })
    }
    return grouped
  }, [tickets, phases])

  // Build brainstorm lookup map for epic badge rendering
  const brainstormMap = useMemo(() => {
    const map = new Map<string, Brainstorm>()
    if (brainstorms) {
      for (const b of brainstorms) {
        map.set(b.id, b)
      }
    }
    return map
  }, [brainstorms])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const ticket = event.active.data.current?.ticket as Ticket | undefined
    if (ticket) {
      setActiveTicket(ticket)
    }
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTicket(null)

      const { active, over } = event
      if (!over || !projectId) return

      const ticketId = active.id as string
      const ticket = active.data.current?.ticket as Ticket | undefined
      const targetPhase = over.id as string

      if (!ticket || ticket.phase === targetPhase) return

      const dependencyWarning = phases
        ? getDependencyWarning(ticket, targetPhase, phases, blockedFromPhaseByTier)
        : null
      if (dependencyWarning) {
        setConfirmDialog({
          open: true,
          type: 'dependency',
          ticketId,
          targetPhase,
          phaseName: targetPhase,
          dependencyTitle: dependencyWarning.title,
          dependencyNeededPhase: dependencyWarning.neededPhase,
        })
        return
      }

      // Check if target phase has automation
      const phaseConfig = templateConfig?.phases.find((p) => p.name === targetPhase)
      const hasAutomation = phaseHasAutomation(phaseConfig)

      if (hasAutomation) {
        // Show confirmation dialog
        setConfirmDialog({
          open: true,
          type: 'automation',
          ticketId,
          targetPhase,
          phaseName: targetPhase
        })
      } else {
        // No automation, move directly
        updateTicket.mutate({
          projectId: projectId,
          ticketId,
          updates: { phase: targetPhase }
        })
      }
    },
    [blockedFromPhaseByTier, projectId, phases, templateConfig, updateTicket]
  )

  const handleConfirmMove = useCallback(() => {
    if (!confirmDialog || !projectId) return

    updateTicket.mutate({
      projectId: projectId,
      ticketId: confirmDialog.ticketId,
      updates: confirmDialog.type === 'dependency'
        ? { phase: confirmDialog.targetPhase, overrideDependencies: true }
        : { phase: confirmDialog.targetPhase }
    })

    setConfirmDialog(null)
  }, [confirmDialog, projectId, updateTicket])

  const handleCancelMove = useCallback(() => {
    setConfirmDialog(null)
  }, [])

  const blockedColumnIds = useMemo(() => {
    if (!activeTicket || !phases || phases.length === 0) return new Set<string>()

    const blocked = new Set<string>()
    const unsatisfied = (activeTicket.blockedBy ?? []).filter((dep) => !dep.satisfied)

    for (const dep of unsatisfied) {
      const neededPhase = blockedFromPhaseByTier[dep.tier]
      const neededIndex = phases.findIndex((phase) => phase === neededPhase)
      if (neededIndex === -1) continue
      for (let i = neededIndex; i < phases.length; i++) {
        blocked.add(phases[i])
      }
    }

    return blocked
  }, [activeTicket, blockedFromPhaseByTier, phases])

  // Loading state
  if (ticketsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-text-muted" />
      </div>
    )
  }

  // Error state
  if (ticketsError) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center text-accent-red">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
          <p>Failed to load tickets</p>
          <p className="text-sm text-text-muted mt-1">{ticketsError.message}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
      {/* Board Header */}
      <div className="flex items-center justify-end px-4 py-3">
        <ViewToggle projectSlug={currentProject?.slug} workflowId={activeWorkflow?.id} />
      </div>

      {/* Template Upgrade Banner */}
      <TemplateUpgradeBanner projectId={projectId} workflowId={activeWorkflow?.id ?? null} />

      {/* Divider */}
      <div className="border-b border-border" />

      {/* Board Content - Conditional Rendering */}
      {boardViewMode === 'table' ? (
        <div className="h-full flex">
          {/* Desktop only: fixed brainstorm column */}
          <div className="hidden sm:block shrink-0 h-full overflow-y-auto border-r border-border p-4 pr-2">
            <BrainstormColumn projectId={projectId} />
          </div>
          <TableView projectId={projectId} workflowId={workflowId} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 h-full">
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div ref={boardScrollRef} className="h-full overflow-x-auto overflow-y-hidden p-4">
              <div className="flex gap-4 h-full">
                {/* Brainstorm column */}
                <div className="shrink-0">
                  <BrainstormColumn projectId={projectId} />
                </div>

                {phases?.map((phase) => {
                  const phaseConfig = templateConfig?.phases.find((p) => p.name === phase)
                  const isManual = isManualCheckpoint(phaseConfig, phase, phases)
                  const isDisabled = currentProject?.disabledPhases?.includes(phase) ?? false
                  const isMigrating = currentProject?.disabledPhaseMigration ?? false

                  return (
                    <BoardColumn
                      key={phase}
                      phase={phase}
                      tickets={ticketsByPhase[phase] || []}
                      projectId={projectId}
                      workflowId={workflowId}
                      showAddTicket={phase === phases?.[0]}
                      isManualPhase={isManual}
                      isDisabled={isDisabled}
                      isMigrating={isMigrating}
                      isBlockedForDrag={!!activeTicket && blockedColumnIds.has(phase)}
                      onToggleDisabled={isManual ? () => handleToggleDisabled(phase) : undefined}
                      swimlaneColor={currentProject?.swimlaneColors?.[phase]}
                      onColorChange={(color) => handleSwimlaneColorChange(phase, color)}
                      blockedFromPhaseByTier={blockedFromPhaseByTier}
                      brainstormMap={brainstormMap}
                    />
                  )
                })}

                {/* Archived swimlane - appears after Done when toggled */}
                {showArchivedTickets && projectId && (
                  <ArchivedSwimlane projectId={projectId} />
                )}
              </div>
            </div>

            {/* Drag Overlay */}
            <DragOverlay>
              {activeTicket && (
                <div className="opacity-80">
                  <TicketCard
                    ticket={activeTicket}
                    projectId={projectId}
                    blockedFromPhaseByTier={blockedFromPhaseByTier}
                  />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {/* Automation Confirmation Dialog */}
      <Dialog
        open={confirmDialog?.open ?? false}
        onOpenChange={(open) => !open && handleCancelMove()}
      >
        <DialogContent className="bg-bg-secondary border-border">
          <DialogHeader>
            <DialogTitle className="text-text-primary">
              {confirmDialog?.type === 'dependency' ? 'Dependency Warning' : 'Start Automation?'}
            </DialogTitle>
            <DialogDescription className="text-text-secondary">
              {confirmDialog?.type === 'dependency' ? (
                <>
                  This ticket depends on{' '}
                  <span className="font-medium text-accent">{confirmDialog?.dependencyTitle}</span>{' '}
                  which has not reached{' '}
                  <span className="font-medium text-accent">{confirmDialog?.dependencyNeededPhase}</span>{' '}
                  yet. Proceed anyway?
                </>
              ) : (
                <>
                  Moving to <span className="font-medium text-accent">{confirmDialog?.phaseName}</span>{' '}
                  will start Claude automation. Continue?
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelMove}>
              Cancel
            </Button>
            <Button onClick={handleConfirmMove}>
              {confirmDialog?.type === 'dependency' ? 'Move Anyway' : 'Continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
