interface PhaseHeaderProps {
  /** The human-readable ticket title */
  ticketTitle: string;
  /** Current phase name (e.g. "Build", "Review") — optional */
  phase?: string;
  /** Agent source identifier — optional */
  agentSource?: string;
  /** Whether the session is currently streaming live */
  isLive: boolean;
  /** Total token count across all sessions in the transcript */
  totalTokens?: number;
  /** Hex color string for the active swimlane accent */
  color?: string;
}

/**
 * Sticky top header for the transcript viewer.
 * Shows the ticket title, current phase, live/ended status badge,
 * and optional token count. Color logic lives in the parent.
 */
export function PhaseHeader({
  ticketTitle,
  phase,
  agentSource,
  isLive,
  totalTokens,
  color,
}: PhaseHeaderProps) {
  const accentColor = color ?? 'transparent';

  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2 border-b border-zinc-700 bg-zinc-900 border-l-4"
      style={{ borderLeftColor: accentColor }}
    >
      <span
        className="font-semibold text-white truncate max-w-xs"
        title={ticketTitle}
      >
        {ticketTitle}
      </span>

      {phase && (
        <span className="text-zinc-400 text-sm shrink-0">{phase}</span>
      )}

      {agentSource && (
        <span className="text-zinc-500 text-xs shrink-0">{agentSource}</span>
      )}

      <div className="ml-auto flex items-center gap-3 shrink-0">
        {totalTokens !== undefined && (
          <span className="text-zinc-500 text-xs tabular-nums">
            {totalTokens.toLocaleString()} tokens
          </span>
        )}

        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            isLive
              ? 'bg-green-900 text-green-400'
              : 'bg-zinc-700 text-zinc-400'
          }`}
        >
          {isLive ? 'Live' : 'Ended'}
        </span>
      </div>
    </div>
  );
}
