import { cn } from '@/lib/utils'

interface SettingsSectionProps {
  title: string
  description: string
  children: React.ReactNode
  danger?: boolean
  action?: React.ReactNode
}

export function SettingsSection({
  title,
  description,
  children,
  danger = false,
  action,
}: SettingsSectionProps) {
  return (
    <div
      className={cn(
        'grid gap-4 py-6 @lg:grid-cols-[240px_1fr] @lg:gap-8',
        danger && 'mt-4'
      )}
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className={cn(
            'font-medium',
            danger ? 'text-accent-red' : 'text-text-primary'
          )}>
            {title}
          </h3>
          {action}
        </div>
        <p className="text-sm text-text-secondary">{description}</p>
      </div>
      <div
        className={cn(
          'bg-bg-secondary rounded-lg border border-border p-4',
          danger && 'border-accent-red/30'
        )}
      >
        {children}
      </div>
    </div>
  )
}
