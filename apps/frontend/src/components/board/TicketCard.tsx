import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Archive, Image, Clock, MessageCircleQuestion } from 'lucide-react'
import { toast } from 'sonner'
import { cn, timeAgo } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'
import { useArchiveTicket } from '@/hooks/queries'
import { ListItemCard } from '@/components/ui/list-item-card'
import { IconButton } from '@/components/ui/icon-button'
import { ArchiveConfirmDialog, shouldShowArchiveWarning } from '@/components/ticket-detail/ArchiveConfirmDialog'
import { DependencyBadge } from '@/components/board/DependencyBadge'
import { EpicBadge } from '@/components/board/EpicBadge'
import type { Brainstorm, DependencyTier, Ticket } from '@potato-cannon/shared'

const COMPLEXITY_BORDER_COLORS: Record<Ticket['complexity'], string> = {
  simple: 'var(--color-text-muted)',
  standard: 'var(--color-accent)',
  complex: 'var(--color-accent-yellow)',
}

interface TicketCardProps {
  ticket: Ticket
  projectId: string
  swimlaneColor?: string
  blockedFromPhaseByTier?: Record<DependencyTier, string>
  brainstorm?: Brainstorm
}

export function TicketCard({ ticket, projectId, swimlaneColor, blockedFromPhaseByTier, brainstorm }: TicketCardProps) {
  const openTicketSheet = useAppStore((s) => s.openTicketSheet)
  const openBrainstormSheet = useAppStore((s) => s.openBrainstormSheet)
  const isProcessing = useAppStore((s) => s.isTicketProcessing(projectId, ticket.id))
  const activity = useAppStore((s) => s.getTicketActivity(projectId, ticket.id))
  const isPending = useAppStore((s) => s.isTicketPending(projectId, ticket.id))
  const isArchiving = useAppStore((s) => s.isTicketArchiving(projectId, ticket.id))
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const archiveTicket = useArchiveTicket()

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
    disabled: isArchiving,
    data: {
      ticket,
      projectId
    }
  })

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        zIndex: isDragging ? 50 : undefined
      }
    : undefined

  const handleClick = () => {
    if (isArchiving) return
    openTicketSheet(projectId, ticket.id)
  }

  const handleArchiveClick = (e: React.MouseEvent) => {
    e.stopPropagation() // Don't trigger card click
    if (shouldShowArchiveWarning()) {
      setArchiveConfirmOpen(true)
    } else {
      handleArchive()
    }
  }

  const handleArchive = () => {
    archiveTicket.mutate(
      { projectId, ticketId: ticket.id },
      {
        onSuccess: (result) => {
          setArchiveConfirmOpen(false)
          if (result.cleanup.errors.length > 0) {
            toast.warning('Ticket archived', {
              description: `Could not clean up: ${result.cleanup.errors.join(', ')}`
            })
          } else {
            toast.success('Ticket archived')
          }
        },
        onError: (error) => {
          toast.error('Failed to archive ticket', {
            description: (error as Error).message
          })
        }
      }
    )
  }

  const imageCount = ticket.images?.length ?? 0

  return (
    <ListItemCard
      asChild
      isActive={isDragging}
      tintColor={swimlaneColor}
      leftAccentColor={COMPLEXITY_BORDER_COLORS[ticket.complexity]}
    >
      <div
        ref={setNodeRef}
        style={style}
        {...listeners}
        {...attributes}
        onClick={handleClick}
        className={cn(
          'relative group',
          isProcessing && 'ticket-card-processing',
          isArchiving && 'opacity-50 pointer-events-none cursor-not-allowed'
        )}
      >
      {/* Archive button - only for Done phase */}
      {ticket.phase === 'Done' && !ticket.archived && (
        <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          <IconButton
            tooltip="Archive"
            onClick={handleArchiveClick}
            disabled={archiveTicket.isPending}
          >
            <Archive className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {/* Pending question badge */}
      {isPending && (
        <div className="absolute top-1.5 right-1.5 z-10">
          <span
            aria-label="Waiting for human input"
            title="Waiting for human input"
            className="flex items-center justify-center w-5 h-5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-bold animate-pending-glow"
          >
            <MessageCircleQuestion className="h-3.5 w-3.5" />
          </span>
        </div>
      )}

      {/* Ticket ID */}
      <div className="text-xs text-text-muted font-mono mb-1">{ticket.id}</div>

      {/* Title + badges row */}
      <div className="flex items-start gap-1.5 mb-2">
        <div className="text-text-primary text-sm font-medium line-clamp-2 min-w-0">
          {ticket.title}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
          <DependencyBadge
            blockedBy={ticket.blockedBy ?? []}
            blockedFromPhaseByTier={blockedFromPhaseByTier}
          />
          {ticket.brainstormId && (
            <EpicBadge
              brainstorm={brainstorm}
              onClick={(e) => {
                e.stopPropagation()
                openBrainstormSheet(projectId, ticket.brainstormId!, 'Epic')
              }}
            />
          )}
        </div>
      </div>

      {/* Meta row */}
      <div className="flex items-center justify-between text-xs text-text-muted">
        <div className="flex items-center gap-2 min-w-0">
          {isProcessing ? (
            <span className="flex items-center gap-1 text-accent truncate">
              <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse shrink-0" />
              <span className="truncate">{activity || 'Processing...'}</span>
            </span>
          ) : (
            imageCount > 0 && (
              <span className="flex items-center gap-1">
                <Image className="h-3 w-3" />
                {imageCount}
              </span>
            )
          )}
        </div>
        <span className="flex items-center gap-1 shrink-0">
          <Clock className="h-3 w-3" />
          {timeAgo(ticket.updatedAt)}
        </span>
      </div>

      <ArchiveConfirmDialog
        open={archiveConfirmOpen}
        onOpenChange={setArchiveConfirmOpen}
        onConfirm={handleArchive}
        isPending={archiveTicket.isPending}
        ticketId={ticket.id}
      />
      </div>
    </ListItemCard>
  )
}
