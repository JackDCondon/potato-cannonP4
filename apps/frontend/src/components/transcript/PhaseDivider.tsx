interface PhaseDividerProps {
  /** The phase name to display (e.g. "Build", "Review") */
  phase: string;
  /** The agent source identifier (e.g. "architect-agent") */
  agentSource?: string;
  /** ISO 8601 timestamp string; displayed as local HH:MM */
  timestamp: string;
  /** Hex color string for the swimlane; defaults to a neutral gray */
  color?: string;
}

/**
 * Full-width in-stream banner marking a phase transition in the transcript.
 * Accepts a swimlane `color` prop — color logic lives in the parent component.
 */
export function PhaseDivider({ phase, agentSource, timestamp, color }: PhaseDividerProps) {
  const timeStr =
    timestamp
      ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

  const borderColor = color ?? '#374151';
  const bgColor = color ? `${color}22` : undefined;

  return (
    <div
      className="w-full flex items-center gap-3 px-4 py-2 my-2 border-l-4 font-semibold text-sm rounded-r"
      style={{ borderColor, backgroundColor: bgColor }}
      role="separator"
      aria-label={`${phase} phase started`}
    >
      <span className="text-white">→ {phase} Phase</span>
      {agentSource && (
        <span className="text-zinc-400 font-normal">· {agentSource}</span>
      )}
      {timeStr && (
        <span className="text-zinc-500 font-normal ml-auto tabular-nums">{timeStr}</span>
      )}
    </div>
  );
}
