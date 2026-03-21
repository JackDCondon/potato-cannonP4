/**
 * PM Alert Detection
 *
 * Detects health issues for epic brainstorms by querying SQLite stores.
 * Returns typed alert objects consumed by the PM poller to spawn sessions.
 */

import type { PmConfig } from "@potato-cannon/shared";
import { getDatabase } from "../../stores/db.js";
import { getTicketsByBrainstormId } from "../../stores/ticket.store.js";
import { getActiveSessionForTicket } from "../../stores/session.store.js";

// =============================================================================
// Phase Priority
// =============================================================================

/**
 * Phase priority order for focus selection (higher = closer to Done = higher priority).
 * Tickets in later phases should be attended to before earlier ones.
 * Phases not listed get a default priority of 0.
 */
const PHASE_PRIORITY: Record<string, number> = {
  "Ideas": 1,
  "Refinement": 2,
  "Backlog": 3,
  "Architecture": 4,
  "Architecture Review": 5,
  "Specification": 6,
  "Specification Review": 7,
  "Build": 8,
  "Pull Requests": 9,
};

/** How recently a session must have ended to be considered "just finished"
 *  (anti-race guard for c2w.2: skip tickets where the workflow engine is
 *  still transitioning after a completed session). */
const RECENTLY_COMPLETED_SESSION_GRACE_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Alert Types
// =============================================================================

export type PmAlertKind =
  | "stuck_ticket"
  | "ralph_failure"
  | "session_crash"
  | "dependency_unblock";

export interface PmAlert {
  kind: PmAlertKind;
  /** Unique key for cooldown deduplication (e.g. "stuck_ticket:TKT-1"). */
  alertKey: string;
  ticketId: string;
  projectId: string;
  message: string;
}

// =============================================================================
// Detection
// =============================================================================

/**
 * Detect actionable alerts for an epic brainstorm.
 *
 * Queries tickets linked to the brainstorm and checks for:
 * - Stuck tickets (no active session and idle beyond threshold)
 * - Ralph loop max_attempts failures
 * - Recent session crashes (non-zero exit code)
 * - Dependency unblocks (watching mode only)
 *
 * Stuck-ticket alerts are sorted by phase priority descending so that tickets
 * closest to Done are surfaced first (fixes c2w.8).
 */
export function detectAlerts(
  epicId: string,
  projectId: string,
  config: PmConfig,
): PmAlert[] {
  const alerts: PmAlert[] = [];
  const db = getDatabase();

  // Get all tickets linked to this epic brainstorm
  const tickets = getTicketsByBrainstormId(epicId);
  if (tickets.length === 0) return alerts;

  const now = Date.now();
  const stuckThresholdMs = config.polling.stuckThresholdMinutes * 60 * 1000;

  // -------------------------------------------------------------------------
  // Stuck Tickets
  // -------------------------------------------------------------------------
  if (config.alerts.stuckTickets) {
    // Only truly terminal phases (ticket is done or intentionally waiting for
    // external reasons) are excluded. Ideas IS actionable — the PM should
    // advance Ideas tickets in executing mode or alert in watching mode (c2w.6).
    const terminalPhases = new Set(["Done", "Blocked"]);

    // Collect stuck alerts before sorting so we can order by phase priority
    const stuckAlerts: Array<PmAlert & { phasePriority: number }> = [];

    for (const ticket of tickets) {
      if (terminalPhases.has(ticket.phase)) continue;
      if (ticket.archived) continue;

      // Skip if ticket has an active session
      const activeSession = getActiveSessionForTicket(ticket.id);
      if (activeSession) continue;

      // c2w.2: Skip tickets where a session completed very recently.
      // The workflow engine may still be transitioning the ticket to the next
      // phase — treating it as "stuck" would produce a redundant move_ticket.
      const recentSessionRow = db
        .prepare(
          `SELECT ended_at FROM sessions
           WHERE ticket_id = ? AND ended_at IS NOT NULL
           ORDER BY ended_at DESC LIMIT 1`,
        )
        .get(ticket.id) as { ended_at: string } | undefined;

      if (recentSessionRow) {
        const endedAt = new Date(recentSessionRow.ended_at).getTime();
        if (now - endedAt < RECENTLY_COMPLETED_SESSION_GRACE_MS) continue;
      }

      // Check how long the ticket has been in this phase
      const historyRow = db
        .prepare(
          `SELECT entered_at FROM ticket_history
           WHERE ticket_id = ? AND exited_at IS NULL
           ORDER BY entered_at DESC LIMIT 1`,
        )
        .get(ticket.id) as { entered_at: string } | undefined;

      if (!historyRow) continue;

      const enteredAt = new Date(historyRow.entered_at).getTime();
      if (now - enteredAt > stuckThresholdMs) {
        const idleMinutes = Math.round((now - enteredAt) / 60_000);
        stuckAlerts.push({
          kind: "stuck_ticket",
          alertKey: `stuck_ticket:${ticket.id}`,
          ticketId: ticket.id,
          projectId,
          message: `Ticket ${ticket.id} stuck in ${ticket.phase} for ${idleMinutes}m with no active session`,
          // c2w.8: track priority for sorting (later phases = higher priority)
          phasePriority: PHASE_PRIORITY[ticket.phase] ?? 0,
        });
      }
    }

    // Sort stuck alerts: highest phase priority first (closest to Done first)
    stuckAlerts.sort((a, b) => b.phasePriority - a.phasePriority);

    for (const { phasePriority: _p, ...alert } of stuckAlerts) {
      alerts.push(alert);
    }
  }

  // -------------------------------------------------------------------------
  // Ralph Failures (max_attempts)
  // -------------------------------------------------------------------------
  if (config.alerts.ralphFailures) {
    const ticketIds = tickets.map((t) => t.id);
    if (ticketIds.length > 0) {
      const placeholders = ticketIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT rf.ticket_id, rf.phase_id, rf.ralph_loop_id
           FROM ralph_feedback rf
           JOIN tickets t ON t.id = rf.ticket_id
           WHERE rf.ticket_id IN (${placeholders})
             AND rf.status = 'max_attempts'
             AND t.phase NOT IN ('Done', 'Blocked', 'Ideas')`,
        )
        .all(...ticketIds) as Array<{
        ticket_id: string;
        phase_id: string;
        ralph_loop_id: string;
      }>;

      for (const row of rows) {
        alerts.push({
          kind: "ralph_failure",
          alertKey: `ralph_failure:${row.ticket_id}:${row.phase_id}:${row.ralph_loop_id}`,
          ticketId: row.ticket_id,
          projectId,
          message: `Ralph loop ${row.ralph_loop_id} hit max attempts for ${row.ticket_id} in phase ${row.phase_id}`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Session Crashes
  // -------------------------------------------------------------------------
  if (config.alerts.sessionCrashes) {
    // Look for sessions that ended with non-zero exit codes in the recent window
    // (use stuck threshold as the recency window — crashes older than that are stale)
    const recentCutoff = new Date(now - stuckThresholdMs).toISOString();
    const ticketIds = tickets.map((t) => t.id);
    if (ticketIds.length > 0) {
      const placeholders = ticketIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, ticket_id, exit_code, ended_at
           FROM sessions
           WHERE ticket_id IN (${placeholders})
             AND exit_code IS NOT NULL AND exit_code != 0
             AND ended_at > ?`,
        )
        .all(...ticketIds, recentCutoff) as Array<{
        id: string;
        ticket_id: string;
        exit_code: number;
        ended_at: string;
      }>;

      for (const row of rows) {
        alerts.push({
          kind: "session_crash",
          alertKey: `session_crash:${row.id}`,
          ticketId: row.ticket_id,
          projectId,
          message: `Session ${row.id} for ${row.ticket_id} crashed with exit code ${row.exit_code}`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Dependency Unblocks (watching + executing modes)
  // -------------------------------------------------------------------------
  if (config.alerts.dependencyUnblocks && (config.mode === "watching" || config.mode === "executing")) {
    // Find tickets in "Blocked" phase that have no unsatisfied hard dependencies.
    // We check if a ticket is in Blocked phase and all its dependencies are in
    // a terminal-like phase (Done). This is a simplified heuristic — full
    // satisfaction evaluation requires template phases which aren't available here.
    for (const ticket of tickets) {
      if (ticket.phase !== "Blocked") continue;
      if (ticket.archived) continue;

      const deps = db
        .prepare(
          `SELECT td.depends_on, t.phase
           FROM ticket_dependencies td
           JOIN tickets t ON t.id = td.depends_on
           WHERE td.ticket_id = ?`,
        )
        .all(ticket.id) as Array<{ depends_on: string; phase: string }>;

      if (deps.length === 0) continue;

      const allSatisfied = deps.every((d) => d.phase === "Done");
      if (allSatisfied) {
        alerts.push({
          kind: "dependency_unblock",
          alertKey: `dependency_unblock:${ticket.id}`,
          ticketId: ticket.id,
          projectId,
          message: `Ticket ${ticket.id} was blocked but all dependencies are now Done`,
        });
      }
    }
  }

  return alerts;
}
