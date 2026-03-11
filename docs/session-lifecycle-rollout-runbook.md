# Session Lifecycle Hardening Rollout Runbook

Date: 2026-03-11
Owner: Daemon Session Orchestration

## Rollout Flags

Configure in global daemon config:

```json
{
  "daemon": {
    "port": 8443,
    "lifecycleHardening": {
      "strictStaleDrop": false,
      "strictStaleResume409": false
    }
  }
}
```

- `strictStaleDrop`
  - `true`: stale completion callbacks (generation mismatch) are dropped.
  - `false`: callback is allowed and logged as legacy mode.
- `strictStaleResume409`
  - `true`: stale/missing ticket input identity returns `409 STALE_TICKET_INPUT`.
  - `false`: legacy acceptance path writes response and avoids strict 409 rejection.

## Recommended Rollout Sequence

1. Enable `strictStaleResume409=true`, keep `strictStaleDrop=false`.
2. Observe stale-input rejection rate and user reports.
3. Enable `strictStaleDrop=true`.
4. Keep both enabled after one release window with stable metrics.

## Expected Log Signatures

- `Dropping stale completion callback`
- `Strict stale-drop disabled; allowing callback despite generation mismatch`
- `Dropped stale ticket input for <ticketId>`
- `Strict stale-resume enforcement disabled; allowing legacy recovery`
- `Ticket lifecycle changed concurrently` (`TICKET_LIFECYCLE_CONFLICT`)

## Telemetry/Alert Thresholds

- `STALE_TICKET_INPUT` responses:
  - warn if > 5% of ticket input POSTs over 15m
  - page if > 15% over 15m
- stale callback drops:
  - warn if > 20/hour per project
- lifecycle conflicts:
  - warn if > 10/hour per project
  - investigate drag/restart burst behavior if sustained

## Scenario Matrix Checklist

- Architecture active -> move to Backlog -> no stale continuation.
- Build mid-task -> move away -> move back -> entry worker sees re-entry task summary.
- Crash/restart -> only generation-matching recovery resumes.
- Stale input after move -> `409 STALE_TICKET_INPUT` when strict mode enabled.
- Concurrent move/restart -> one committed lifecycle path (`409` conflict on loser).
- Stale callback after replacement spawn -> dropped when strict stale-drop enabled.
- Spawn failure leaves `spawn_pending` and startup recovery respawns once.
- Startup with both pending response + worker-state -> pending response precedence path wins.

## Rollback

1. Set both flags to `false`.
2. Restart daemon.
3. Verify logs now show legacy-mode messages and no strict-drop enforcement.
4. Keep generation-aware invalidation/move logic intact; only strict fencing is relaxed.
