import type { TemplatePhase } from '@potato-cannon/shared'

/**
 * Checks if a phase has automation configured (agents, ralphLoop, or ticketLoop)
 */
export function phaseHasAutomation(phaseConfig: TemplatePhase | undefined): boolean {
  if (!phaseConfig) return false
  return !!(
    (phaseConfig.agents && phaseConfig.agents.length > 0) ||
    phaseConfig.ralphLoop ||
    phaseConfig.ticketLoop
  )
}
