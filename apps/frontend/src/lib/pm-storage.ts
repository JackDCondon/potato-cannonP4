import { DEFAULT_PM_CONFIG, type PmConfig } from '@potato-cannon/shared'

export const BOARD_PM_DEFAULTS_KEY = 'potato-board-pm-defaults'

export function loadBoardPmDefaults(): PmConfig {
  try {
    const raw = localStorage.getItem(BOARD_PM_DEFAULTS_KEY)
    if (raw) {
      return { ...DEFAULT_PM_CONFIG, ...JSON.parse(raw) }
    }
  } catch {
    // Fall through to defaults when storage is unavailable or malformed.
  }

  return DEFAULT_PM_CONFIG
}

export function saveBoardPmDefaults(config: PmConfig): void {
  localStorage.setItem(BOARD_PM_DEFAULTS_KEY, JSON.stringify(config))
}
