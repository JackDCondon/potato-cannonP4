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
// Phone Notification Policy
// =============================================================================

/** Preset for board-level external chat delivery. */
export type BoardNotificationPreset =
  | 'all'
  | 'important_only'
  | 'questions_only'
  | 'mute_all'

/** Stable categories used by provider-agnostic outbound chat filtering. */
export type ChatNotificationCategory =
  | 'builder_updates'
  | 'pm_alerts'
  | 'lifecycle_events'
  | 'questions'
  | 'critical'

/** Board-level policy controlling which messages reach external chat providers. */
export interface ChatNotificationPolicy {
  preset: BoardNotificationPreset
  categories: Record<ChatNotificationCategory, boolean>
}

/** Partial update payload for persisted board notification policy changes. */
export interface ChatNotificationPolicyInput {
  preset?: BoardNotificationPreset
  categories?: Partial<Record<ChatNotificationCategory, boolean>>
}

/** Resolved category toggles for each preset offered in the board UI. */
export const BOARD_NOTIFICATION_PRESET_CATEGORIES: Record<
  BoardNotificationPreset,
  Record<ChatNotificationCategory, boolean>
> = {
  all: {
    builder_updates: true,
    pm_alerts: true,
    lifecycle_events: true,
    questions: true,
    critical: true,
  },
  important_only: {
    builder_updates: false,
    pm_alerts: true,
    lifecycle_events: false,
    questions: true,
    critical: true,
  },
  questions_only: {
    builder_updates: false,
    pm_alerts: false,
    lifecycle_events: false,
    questions: true,
    critical: false,
  },
  mute_all: {
    builder_updates: false,
    pm_alerts: false,
    lifecycle_events: false,
    questions: false,
    critical: false,
  },
}

export function resolveBoardNotificationPresetCategories(
  preset: BoardNotificationPreset,
): Record<ChatNotificationCategory, boolean> {
  return { ...BOARD_NOTIFICATION_PRESET_CATEGORIES[preset] }
}

export function deriveBoardNotificationPreset(
  categories: Record<ChatNotificationCategory, boolean>,
): BoardNotificationPreset | null {
  const presets = Object.entries(
    BOARD_NOTIFICATION_PRESET_CATEGORIES,
  ) as Array<[BoardNotificationPreset, Record<ChatNotificationCategory, boolean>]>;

  for (const [preset, presetCategories] of presets) {
    const matches = (
      Object.keys(presetCategories) as ChatNotificationCategory[]
    ).every((category) => presetCategories[category] === categories[category]);

    if (matches) {
      return preset;
    }
  }

  return null
}

// =============================================================================
// Board Settings
// =============================================================================

/** Per-board PM settings row. `pmConfig` is null when no overrides are stored. */
export interface BoardSettings {
  id: string
  workflowId: string
  pmConfig: PmConfig | null
  chatNotificationPolicy: ChatNotificationPolicy | null
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

/**
 * Default external chat delivery policy applied when a board has no overrides.
 * New boards send all categories by default.
 */
export const DEFAULT_CHAT_NOTIFICATION_POLICY: ChatNotificationPolicy = {
  preset: 'all',
  categories: resolveBoardNotificationPresetCategories('all'),
}
