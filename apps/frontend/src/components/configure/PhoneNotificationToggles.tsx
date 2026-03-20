import { cn } from '@/lib/utils'
import type { ChatNotificationCategory } from '@potato-cannon/shared'

interface PhoneNotificationToggleItem {
  key: ChatNotificationCategory
  label: string
  description: string
}

const PHONE_NOTIFICATION_ITEMS: PhoneNotificationToggleItem[] = [
  {
    key: 'builder_updates',
    label: 'Builder Updates',
    description: 'Task progress chatter like task started and task completed updates.',
  },
  {
    key: 'pm_alerts',
    label: 'PM Alerts',
    description: 'PM-driven alerts such as stuck tickets, failures, and dependency unblocks.',
  },
  {
    key: 'lifecycle_events',
    label: 'Lifecycle Events',
    description: 'Pause, resume, and other board lifecycle status changes.',
  },
  {
    key: 'questions',
    label: 'Questions',
    description: 'Messages that need a human reply, even though they still appear in Potato Cannon.',
  },
  {
    key: 'critical',
    label: 'Critical',
    description: 'High-signal warnings and action-needed notifications.',
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

interface PhoneNotificationTogglesProps {
  value: Record<ChatNotificationCategory, boolean>
  onChange: (category: ChatNotificationCategory, checked: boolean) => void
  disabled?: boolean
}

export function PhoneNotificationToggles({
  value,
  onChange,
  disabled,
}: PhoneNotificationTogglesProps) {
  return (
    <div className="space-y-3">
      {PHONE_NOTIFICATION_ITEMS.map((item) => (
        <div
          key={item.key}
          className={cn(
            'flex items-center justify-between gap-4 rounded-md border border-border p-3',
            disabled && 'opacity-60',
          )}
        >
          <div className="space-y-0.5">
            <label
              htmlFor={`phone-notification-${item.key}`}
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
            id={`phone-notification-${item.key}`}
            checked={value[item.key]}
            onChange={(checked) => onChange(item.key, checked)}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  )
}
