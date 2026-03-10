import { CircleSlash } from "lucide-react"
import type { BlockedByEntry } from "@potato-cannon/shared"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface DependencyBadgeProps {
  blockedBy: BlockedByEntry[]
}

function neededPhaseForTier(tier: BlockedByEntry["tier"]): string {
  if (tier === "artifact-ready") return "Specification"
  if (tier === "code-ready") return "Done"
  return tier
}

export function DependencyBadge({ blockedBy }: DependencyBadgeProps) {
  const unsatisfied = blockedBy.filter((dep) => !dep.satisfied)
  if (unsatisfied.length === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-amber-300">
          <CircleSlash className="h-3 w-3" />
          <span className="font-medium">{unsatisfied.length}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[320px] p-2">
        <div className="space-y-2">
          {unsatisfied.map((dep) => (
            <div key={`${dep.ticketId}-${dep.tier}`} className="rounded border border-border bg-bg-secondary px-2 py-1.5">
              <div className="text-text-primary text-xs font-medium">{dep.title}</div>
              <div className="text-text-muted text-[11px]">
                {dep.currentPhase} -&gt; {neededPhaseForTier(dep.tier)} ({dep.tier})
              </div>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
