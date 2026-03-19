import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";
import type { BoardSettings, PmConfig } from "@potato-cannon/shared";
import { DEFAULT_PM_CONFIG } from "@potato-cannon/shared";

// =============================================================================
// Row Types
// =============================================================================

interface BoardSettingsRow {
  id: string;
  workflow_id: string;
  pm_config: string | null;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// Row Mapper
// =============================================================================

function rowToSettings(row: BoardSettingsRow): BoardSettings {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    pmConfig: row.pm_config ? (JSON.parse(row.pm_config) as PmConfig) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// =============================================================================
// BoardSettingsStore Class
// =============================================================================

export class BoardSettingsStore {
  constructor(private db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // Core CRUD
  // ---------------------------------------------------------------------------

  /**
   * Get the settings row for a board, or null if no overrides have been saved.
   */
  getSettings(workflowId: string): BoardSettings | null {
    const row = this.db
      .prepare("SELECT * FROM board_settings WHERE workflow_id = ?")
      .get(workflowId) as BoardSettingsRow | undefined;

    return row ? rowToSettings(row) : null;
  }

  /**
   * Insert or replace board settings, merging the supplied pmConfig with
   * whatever is already stored (board-level overrides WIN over existing values).
   * Returns the persisted BoardSettings row.
   */
  upsertSettings(workflowId: string, pmConfig: Partial<PmConfig>): BoardSettings {
    const existing = this.getSettings(workflowId);
    const now = new Date().toISOString();

    const merged: PmConfig = {
      ...(existing?.pmConfig ?? DEFAULT_PM_CONFIG),
      ...pmConfig,
      polling: {
        ...(existing?.pmConfig?.polling ?? DEFAULT_PM_CONFIG.polling),
        ...(pmConfig.polling ?? {}),
      },
      alerts: {
        ...(existing?.pmConfig?.alerts ?? DEFAULT_PM_CONFIG.alerts),
        ...(pmConfig.alerts ?? {}),
      },
    };

    if (existing) {
      this.db
        .prepare(
          "UPDATE board_settings SET pm_config = ?, updated_at = ? WHERE workflow_id = ?"
        )
        .run(JSON.stringify(merged), now, workflowId);
    } else {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO board_settings (id, workflow_id, pm_config, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, workflowId, JSON.stringify(merged), now, now);
    }

    return this.getSettings(workflowId)!;
  }

  /**
   * Delete all stored overrides for a board.
   * After deletion, getPmConfig() will return DEFAULT_PM_CONFIG.
   * Returns true if a row was deleted, false if nothing existed.
   */
  deleteSettings(workflowId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM board_settings WHERE workflow_id = ?")
      .run(workflowId);

    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Inheritance Resolution
  // ---------------------------------------------------------------------------

  /**
   * Return the effective PmConfig for a board.
   * If no overrides are stored, returns DEFAULT_PM_CONFIG.
   * If overrides are stored, returns them (they were merged at write time).
   */
  getPmConfig(workflowId: string): PmConfig {
    const settings = this.getSettings(workflowId);

    if (!settings || !settings.pmConfig) {
      return DEFAULT_PM_CONFIG;
    }

    return settings.pmConfig;
  }
}

// =============================================================================
// Factory & Convenience Functions
// =============================================================================

export function createBoardSettingsStore(
  db: Database.Database
): BoardSettingsStore {
  return new BoardSettingsStore(db);
}

export function getBoardSettings(workflowId: string): BoardSettings | null {
  return new BoardSettingsStore(getDatabase()).getSettings(workflowId);
}

export function upsertBoardSettings(
  workflowId: string,
  pmConfig: Partial<PmConfig>
): BoardSettings {
  return new BoardSettingsStore(getDatabase()).upsertSettings(workflowId, pmConfig);
}

export function deleteBoardSettings(workflowId: string): boolean {
  return new BoardSettingsStore(getDatabase()).deleteSettings(workflowId);
}

export function getBoardPmConfig(workflowId: string): PmConfig {
  return new BoardSettingsStore(getDatabase()).getPmConfig(workflowId);
}
