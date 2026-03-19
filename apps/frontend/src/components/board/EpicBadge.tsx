import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getEpicIcon, getEpicColor } from "@/lib/epic-icons"
import type { Brainstorm } from "@potato-cannon/shared"

interface EpicBadgeProps {
  brainstorm: Brainstorm | undefined
  onClick: (e: React.MouseEvent) => void
}

export function EpicBadge({ brainstorm, onClick }: EpicBadgeProps) {
  if (!brainstorm) return null

  const total = brainstorm.ticketCount ?? 0
  const active = brainstorm.activeTicketCount ?? 0
  const color = getEpicColor(brainstorm.color)
  const Icon = getEpicIcon(brainstorm.icon)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1 cursor-pointer opacity-100 hover:opacity-80 transition-opacity"
          style={{ color }}
          onClick={onClick}
        >
          <Icon className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[320px] p-2">
        <div className="rounded border border-border bg-bg-secondary px-2 py-1.5">
          <div className="text-xs font-medium" style={{ color }}>{brainstorm.name}</div>
          {total > 0 && (
            <div className="text-text-muted text-[11px]">
              {active} of {total} tickets active
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
