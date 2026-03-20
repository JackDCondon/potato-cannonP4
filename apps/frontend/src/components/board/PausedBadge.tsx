import { Pause } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface PausedBadgeProps {
  paused?: boolean
  pauseReason?: string
  pauseRetryAt?: string
  pauseRetryCount?: number
}

function formatTimeRemaining(retryAt: string): string {
  const diff = new Date(retryAt).getTime() - Date.now()
  if (diff <= 0) return "Retrying soon..."
  const mins = Math.ceil(diff / 60_000)
  if (mins < 60) return `Retrying in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  return `Retrying in ${hrs}h ${remainMins}m`
}

export function PausedBadge({ paused, pauseReason, pauseRetryAt, pauseRetryCount }: PausedBadgeProps) {
  if (!paused) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded-full border border-orange-500/30 bg-orange-500/15 px-2 py-0.5 text-orange-300">
          <Pause className="h-3 w-3" />
          <span className="font-medium text-xs">Paused</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[320px] p-2">
        <div className="space-y-1.5">
          {pauseReason && (
            <div className="text-text-primary text-xs">{pauseReason}</div>
          )}
          {pauseRetryAt && (
            <div className="text-text-muted text-[11px]">
              {formatTimeRemaining(pauseRetryAt)}
            </div>
          )}
          {!pauseRetryAt && (
            <div className="text-text-muted text-[11px]">
              Manual resume required
            </div>
          )}
          {pauseRetryCount != null && pauseRetryCount > 0 && (
            <div className="text-text-muted text-[11px]">
              Retry {pauseRetryCount}/3
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
