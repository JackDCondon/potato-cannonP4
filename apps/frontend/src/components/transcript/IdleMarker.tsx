interface IdleMarkerProps {
  /** The phase name that has just completed */
  phase: string;
  /** ISO 8601 timestamp of when the phase ended */
  timestamp: string;
}

/**
 * Subtle centered end-of-phase marker shown at the bottom of a swimlane's
 * output before the next phase begins (or while waiting for the user to
 * advance the ticket). This is intentionally low-contrast.
 */
export function IdleMarker({ phase, timestamp }: IdleMarkerProps) {
  const timeStr =
    timestamp
      ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

  return (
    <div
      className="w-full text-center text-zinc-500 text-xs py-3 border-t border-zinc-800 mt-2"
      role="status"
      aria-label={`${phase} phase complete, waiting for next phase`}
    >
      {phase} phase complete · waiting for next phase{timeStr ? ` · ${timeStr}` : ''}
    </div>
  );
}
