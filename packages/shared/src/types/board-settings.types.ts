// =============================================================================
// PM Mode
// =============================================================================

/** Operating mode for the Project Manager agent on a board. */
export type PmMode = 'passive' | 'watching' | 'executing'

// =============================================================================
// PM Alert Config
// =============================================================================

/** Flags controlling which alert types the PM will fire. */
export interface PmAlertConfig {
  stuckTickets: boolean
  ralphFailures: boolean
  dependencyUnblocks: boolean
  sessionCrashes: boolean
}

// =============================================================================
// PM Polling Config
// =============================================================================

/** Timing parameters for the daemon-side polling loop. */
export interface PmPollingConfig {
  /** How often the poller wakes up (minutes). */
  intervalMinutes: number
  /** How long a ticket must be idle before considered stuck (minutes). */
  stuckThresholdMinutes: number
  /** Minimum quiet period between repeated alerts of the same type (minutes). */
  alertCooldownMinutes: number
}

// =============================================================================
// PM Config
// =============================================================================

/** Combined PM configuration: mode + polling + alert flags. */
export interface PmConfig {
  mode: PmMode
  polling: PmPollingConfig
  alerts: PmAlertConfig
}

// =============================================================================
// Board Settings
// =============================================================================

/** Per-board PM settings row. `pmConfig` is null when no overrides are stored. */
export interface BoardSettings {
  id: string
  workflowId: string
  pmConfig: PmConfig | null
  createdAt: string
  updatedAt: string
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Global default PM config applied when a board has no overrides.
 * Mode: passive, 5-minute polling, 30-minute stuck threshold,
 * 15-minute cooldown, all alert types enabled.
 */
export const DEFAULT_PM_CONFIG: PmConfig = {
  mode: 'passive',
  polling: {
    intervalMinutes: 5,
    stuckThresholdMinutes: 30,
    alertCooldownMinutes: 15,
  },
  alerts: {
    stuckTickets: true,
    ralphFailures: true,
    dependencyUnblocks: true,
    sessionCrashes: true,
  },
}
