import { Slot } from '@radix-ui/react-slot'
import { cn } from '@/lib/utils'

interface ListItemCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Render as child element using Radix Slot */
  asChild?: boolean
  /** Show selected state with accent styling */
  isSelected?: boolean
  /** Show active state (dragging, processing) with reduced opacity */
  isActive?: boolean
  /** Tint color from parent container - card will be a lighter version */
  tintColor?: string
  /** Optional left accent line color (e.g., complexity indicator) */
  leftAccentColor?: string
}

/**
 * Shared card component for list items (tickets, brainstorms, etc.)
 * Provides consistent styling across different list views.
 */
export function ListItemCard({
  asChild,
  isSelected,
  isActive,
  tintColor,
  leftAccentColor,
  className,
  children,
  style,
  ...props
}: ListItemCardProps) {
  const Comp = asChild ? Slot : 'div'

  // Create a lighter background based on the tint color
  const cardStyle: React.CSSProperties = {
    ...style,
    ...(tintColor ? { backgroundColor: `color-mix(in srgb, ${tintColor} 60%, #3a3a3c)` } : {}),
    ...(leftAccentColor
      ? {
          borderLeftWidth: '3px',
          borderLeftStyle: 'solid',
          borderLeftColor: leftAccentColor
        }
      : {})
  }

  return (
    <Comp
      className={cn(
        'rounded-lg p-3 cursor-pointer transition-all',
        'border border-white/10 hover:border-white/20',
        'shadow-md shadow-black/30',
        !tintColor && 'bg-bg-tertiary',
        isSelected && 'border-accent/30 bg-accent/10',
        isActive && 'opacity-50 shadow-lg',
        className
      )}
      style={cardStyle}
      {...props}
    >
      {children}
    </Comp>
  )
}
