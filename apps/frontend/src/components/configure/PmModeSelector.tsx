import { Eye, EyeOff, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PmMode } from '@potato-cannon/shared'

interface ModeOption {
  value: PmMode
  label: string
  description: string
  icon: typeof Eye
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'passive',
    label: 'Passive',
    description: 'PM is dormant. No polling, no alerts. Status queries only.',
    icon: EyeOff,
  },
  {
    value: 'watching',
    label: 'Watching',
    description: 'PM monitors tickets and fires alerts, but takes no action.',
    icon: Eye,
  },
  {
    value: 'executing',
    label: 'Executing',
    description: 'PM monitors and can autonomously advance stuck tickets.',
    icon: Play,
  },
]

interface PmModeSelectorProps {
  value: PmMode
  onChange: (mode: PmMode) => void
  disabled?: boolean
}

export function PmModeSelector({ value, onChange, disabled }: PmModeSelectorProps) {
  return (
    <div className="grid grid-cols-1 gap-3 @md:grid-cols-3">
      {MODE_OPTIONS.map((option) => {
        const isSelected = value === option.value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors',
              'hover:bg-bg-tertiary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              isSelected
                ? 'border-accent bg-accent/5'
                : 'border-border',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <div className="flex items-center gap-2">
              <Icon
                className={cn(
                  'h-4 w-4',
                  isSelected ? 'text-accent' : 'text-text-secondary',
                )}
              />
              <span
                className={cn(
                  'text-sm font-medium',
                  isSelected ? 'text-accent' : 'text-text-primary',
                )}
              >
                {option.label}
              </span>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              {option.description}
            </p>
          </button>
        )
      })}
    </div>
  )
}
