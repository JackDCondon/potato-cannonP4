import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CollapsibleSettingsSectionProps {
  title: string
  description: string
  children: React.ReactNode
  defaultOpen?: boolean
  badge?: React.ReactNode
}

export function CollapsibleSettingsSection({
  title,
  description,
  children,
  defaultOpen = false,
  badge,
}: CollapsibleSettingsSectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-bg-secondary/70">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
      >
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            {badge}
          </div>
          <p className="text-sm text-text-secondary">{description}</p>
        </div>
        <ChevronDown
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0 text-text-secondary transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && <div className="border-t border-border px-5 py-2">{children}</div>}
    </section>
  )
}
