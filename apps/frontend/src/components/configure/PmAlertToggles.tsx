import { cn } from '@/lib/utils'
import type { PmAlertConfig } from '@potato-cannon/shared'

interface AlertToggleItem {
  key: keyof PmAlertConfig
  label: string
  description: string
}

const ALERT_ITEMS: AlertToggleItem[] = [
  {
    key: 'stuckTickets',
    label: 'Stuck Tickets',
    description: 'Alert when a ticket has been idle beyond the stuck threshold.',
  },
  {
    key: 'ralphFailures',
    label: 'Ralph Failures',
    description: 'Alert when an adversarial review loop exhausts max attempts.',
  },
  {
    key: 'dependencyUnblocks',
    label: 'Dependency Unblocks',
    description: 'Alert when a blocked ticket becomes unblocked.',
  },
  {
    key: 'sessionCrashes',
    label: 'Session Crashes',
    description: 'Alert when a Claude session crashes unexpectedly.',
  },
]

interface ToggleSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
}

function ToggleSwitch({ checked, onChange, disabled, id }: ToggleSwitchProps) {
  return (
    <button
      id={id}
      role="switch"
      type="button"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
        checked ? 'bg-accent' : 'bg-border',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'pointer-events-none block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  )
}

interface PmAlertTogglesProps {
  value: PmAlertConfig
  onChange: (alerts: PmAlertConfig) => void
  disabled?: boolean
}

export function PmAlertToggles({ value, onChange, disabled }: PmAlertTogglesProps) {
  const handleToggle = (key: keyof PmAlertConfig, checked: boolean) => {
    onChange({ ...value, [key]: checked })
  }

  return (
    <div className="space-y-3">
      {ALERT_ITEMS.map((item) => (
        <div
          key={item.key}
          className={cn(
            'flex items-center justify-between gap-4 rounded-md border border-border p-3',
            disabled && 'opacity-60',
          )}
        >
          <div className="space-y-0.5">
            <label
              htmlFor={`alert-${item.key}`}
              className={cn(
                'text-sm font-medium',
                disabled ? 'text-text-secondary' : 'text-text-primary',
              )}
            >
              {item.label}
            </label>
            <p className="text-xs text-text-secondary">{item.description}</p>
          </div>
          <ToggleSwitch
            id={`alert-${item.key}`}
            checked={value[item.key]}
            onChange={(checked) => handleToggle(item.key, checked)}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  )
}
