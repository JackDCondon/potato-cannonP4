import type { DependencyTier, TemplatePhase } from '@potato-cannon/shared'

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

/**
 * Resolve the first phase name that should be blocked for an unsatisfied
 * dependency tier. This is template-driven via `blocksOnUnsatisfiedTiers`.
 */
export function getBlockedFromPhaseForTier(
  tier: DependencyTier,
  templatePhases: TemplatePhase[] | undefined,
): string {
  const phase = templatePhases?.find((p) =>
    (p.blocksOnUnsatisfiedTiers ?? []).includes(tier),
  )
  if (phase?.name) return phase.name

  // Backward-compatible fallback for templates not yet tagged.
  if (tier === 'artifact-ready') return 'Specification'
  if (tier === 'code-ready') return 'Done'
  return 'Done'
}

export function getBlockedFromPhaseMap(
  templatePhases: TemplatePhase[] | undefined,
): Record<DependencyTier, string> {
  return {
    'artifact-ready': getBlockedFromPhaseForTier('artifact-ready', templatePhases),
    'code-ready': getBlockedFromPhaseForTier('code-ready', templatePhases),
  }
}
