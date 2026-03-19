/**
 * PM Poller Service
 *
 * Daemon-side polling timer that monitors epic health and triggers alerts
 * by spawning PM sessions. Queries brainstorms with `status = 'epic'` and
 * `pm_enabled = 1`, detects alerts, and spawns Claude sessions as needed.
 */

import type { SessionService } from "../session/index.js";
import type { PmConfig } from "@potato-cannon/shared";
import type { Project } from "../../types/config.types.js";
import { getDatabase } from "../../stores/db.js";
import { getBoardPmConfig } from "../../stores/board-settings.store.js";
import { detectAlerts, type PmAlert } from "./pm-alerts.js";

// =============================================================================
// Types
// =============================================================================

interface EpicBrainstormRow {
  id: string;
  project_id: string;
  workflow_id: string | null;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum PM sessions spawned per hour to prevent runaway costs. */
const MAX_SPAWNS_PER_HOUR = 10;

/** Default polling interval if no epic brainstorms have board-level overrides. */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// PmPoller Class
// =============================================================================

export class PmPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private sessionService: SessionService;
  private getProjects: () => Map<string, Project>;

  /** alertKey -> timestamp of last fire. Cleared on restart (one duplicate acceptable). */
  private cooldowns = new Map<string, number>();

  /** Spawn counter for rate limiting: [windowStartMs, count]. */
  private spawnWindow: [number, number] = [Date.now(), 0];

  constructor(
    sessionService: SessionService,
    getProjects: () => Map<string, Project>,
  ) {
    this.sessionService = sessionService;
    this.getProjects = getProjects;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the polling loop. Uses the shortest configured interval across
   * all active epics (clamped to a sensible minimum of 1 minute).
   */
  start(): void {
    if (this.intervalId) return;

    const intervalMs = this.resolvePollingInterval();
    this.intervalId = setInterval(() => this.tick(), intervalMs);
    // Run initial tick after a short delay to let startup complete
    setTimeout(() => this.tick(), 5_000);
    console.log(
      `[pm-poller] Started with ${Math.round(intervalMs / 1000)}s interval`,
    );
  }

  /** Stop the polling loop and clear cooldown state. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.cooldowns.clear();
    console.log("[pm-poller] Stopped");
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    try {
      const epics = this.getActiveEpics();
      if (epics.length === 0) return;

      const projects = this.getProjects();

      for (const epic of epics) {
        const project = projects.get(epic.project_id);
        if (!project) continue;

        const config = epic.workflow_id
          ? getBoardPmConfig(epic.workflow_id)
          : null;
        if (!config || config.mode === "passive") continue;

        const alerts = detectAlerts(epic.id, epic.project_id, config);
        const cooldownMs = config.polling.alertCooldownMinutes * 60 * 1000;
        const now = Date.now();

        for (const alert of alerts) {
          // Cooldown check
          const lastFired = this.cooldowns.get(alert.alertKey);
          if (lastFired && now - lastFired < cooldownMs) continue;

          // Rate limit check
          if (!this.canSpawn()) {
            console.warn(
              `[pm-poller] Spawn rate limit hit (${MAX_SPAWNS_PER_HOUR}/hr). Skipping alert: ${alert.alertKey}`,
            );
            continue;
          }

          await this.handleAlert(alert, epic, config, project);
          this.cooldowns.set(alert.alertKey, now);
        }
      }
    } catch (err) {
      console.error(
        `[pm-poller] tick error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Alert Handling
  // ---------------------------------------------------------------------------

  private async handleAlert(
    alert: PmAlert,
    epic: EpicBrainstormRow,
    config: PmConfig,
    project: Project,
  ): Promise<void> {
    try {
      // All alert types spawn a brainstorm PM session with alert context.
      // The PM agent receives the alert message and decides the appropriate action
      // (e.g. unblocking a ticket, retrying a stuck ticket, investigating a crash).
      console.log(
        `[pm-poller] Spawning PM session for epic ${epic.id}: ${alert.message}`,
      );
      await this.sessionService.spawnForBrainstorm(
        alert.projectId,
        epic.id,
        project.path,
        `[PM Alert] ${alert.message}`,
      );
      this.recordSpawn();
    } catch (err) {
      console.error(
        `[pm-poller] Failed to spawn session for alert ${alert.alertKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Let cooldown expire naturally for retry on next tick
    }
  }

  // ---------------------------------------------------------------------------
  // Rate Limiting
  // ---------------------------------------------------------------------------

  private canSpawn(): boolean {
    const now = Date.now();
    const [windowStart, count] = this.spawnWindow;
    const oneHour = 60 * 60 * 1000;

    // Slide window if it's older than 1 hour
    if (now - windowStart > oneHour) {
      this.spawnWindow = [now, 0];
      return true;
    }

    return count < MAX_SPAWNS_PER_HOUR;
  }

  private recordSpawn(): void {
    this.spawnWindow[1]++;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Get all brainstorms with status 'epic' and pm_enabled = 1.
   * These are the active epics the poller monitors.
   */
  private getActiveEpics(): EpicBrainstormRow[] {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT id, project_id, workflow_id
         FROM brainstorms
         WHERE status = 'epic' AND pm_enabled = 1`,
      )
      .all() as EpicBrainstormRow[];
  }

  /**
   * Resolve the shortest polling interval across all configured boards.
   * Returns DEFAULT_POLL_INTERVAL_MS if no epics or no board configs exist.
   */
  private resolvePollingInterval(): number {
    const epics = this.getActiveEpics();
    let minInterval = DEFAULT_POLL_INTERVAL_MS;

    for (const epic of epics) {
      if (!epic.workflow_id) continue;
      const config = getBoardPmConfig(epic.workflow_id);
      if (config.mode === "passive") continue;
      const intervalMs = config.polling.intervalMinutes * 60 * 1000;
      if (intervalMs < minInterval) {
        minInterval = intervalMs;
      }
    }

    // Clamp to a minimum of 1 minute to avoid busy-looping
    return Math.max(minInterval, 60_000);
  }
}
