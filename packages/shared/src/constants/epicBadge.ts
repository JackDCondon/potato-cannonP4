export const EPIC_BADGE_COLORS = [
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#f43f5e', // Rose
  '#8b5cf6', // Violet
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#ec4899', // Pink
  '#84cc16', // Lime
  '#0ea5e9'  // Sky
] as const

export const EPIC_BADGE_ICONS = [
  'code',
  'terminal',
  'git-branch',
  'bug',
  'wrench',
  'package',
  'rocket',
  'layers',
  'puzzle',
  'database',
  'server',
  'cloud',
  'palette',
  'pen',
  'briefcase',
  'users',
  'target',
  'bookmark',
  'flag',
  'star',
  'globe',
  'shield',
  'lock',
  'lightbulb',
  'zap'
] as const

export type EpicBadgeColor = typeof EPIC_BADGE_COLORS[number]
export type EpicBadgeIcon = typeof EPIC_BADGE_ICONS[number]
