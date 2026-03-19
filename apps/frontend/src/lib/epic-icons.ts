import {
  Code, Terminal, GitBranch, Bug, Wrench, Package, Rocket, Layers, Puzzle,
  Database, Server, Cloud, Palette, Pen, Briefcase, Users, Target, Bookmark,
  Flag, Star, Globe, Shield, Lock, Lightbulb, Zap
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const EPIC_ICON_MAP: Record<string, LucideIcon> = {
  'code': Code,
  'terminal': Terminal,
  'git-branch': GitBranch,
  'bug': Bug,
  'wrench': Wrench,
  'package': Package,
  'rocket': Rocket,
  'layers': Layers,
  'puzzle': Puzzle,
  'database': Database,
  'server': Server,
  'cloud': Cloud,
  'palette': Palette,
  'pen': Pen,
  'briefcase': Briefcase,
  'users': Users,
  'target': Target,
  'bookmark': Bookmark,
  'flag': Flag,
  'star': Star,
  'globe': Globe,
  'shield': Shield,
  'lock': Lock,
  'lightbulb': Lightbulb,
  'zap': Zap,
}

const DEFAULT_EPIC_COLOR = '#818cf8'

/**
 * Returns the Lucide icon component for the given epic icon name.
 * Falls back to Layers when the name is null, undefined, or unrecognised.
 */
export function getEpicIcon(name?: string | null): LucideIcon {
  if (name && EPIC_ICON_MAP[name]) {
    return EPIC_ICON_MAP[name]
  }
  return Layers
}

/**
 * Returns the color string for an epic.
 * Falls back to #818cf8 (indigo-400) when color is null or undefined.
 */
export function getEpicColor(color?: string | null): string {
  return color ?? DEFAULT_EPIC_COLOR
}
