import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import {
  BoardSettingsStore,
  createBoardSettingsStore,
} from "../board-settings.store.js";
import { createProjectStore } from "../project.store.js";
import { createProjectWorkflowStore } from "../project-workflow.store.js";
import { DEFAULT_PM_CONFIG } from "@potato-cannon/shared";
import type { PmConfig } from "@potato-cannon/shared";

describe("BoardSettingsStore", () => {
  let db: Database.Database;
  let store: BoardSettingsStore;
  let testDbPath: string;
  let workflowId: string;

  before(() => {
    testDbPath = path.join(
      os.tmpdir(),
      `potato-test-board-settings-${Date.now()}.db`
    );
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    store = createBoardSettingsStore(db);

    // Create a project + workflow to satisfy the FK
    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Test Project",
      path: "/test/board-settings",
    });

    const workflowStore = createProjectWorkflowStore(db);
    const workflow = workflowStore.createWorkflow({
      projectId: project.id,
      name: "Main Board",
      templateName: "product-development",
    });
    workflowId = workflow.id;
  });

  after(() => {
    db.close();
    try {
      fs.unlinkSync(testDbPath);
      fs.unlinkSync(testDbPath + "-wal");
      fs.unlinkSync(testDbPath + "-shm");
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM board_settings").run();
  });

  // ---------------------------------------------------------------------------
  // getSettings
  // ---------------------------------------------------------------------------

  describe("getSettings", () => {
    it("returns null when no settings exist", () => {
      const result = store.getSettings(workflowId);
      assert.strictEqual(result, null);
    });

    it("returns the stored row after upsert", () => {
      store.upsertSettings(workflowId, { mode: "watching" });
      const result = store.getSettings(workflowId);

      assert.ok(result);
      assert.strictEqual(result.workflowId, workflowId);
      assert.ok(result.pmConfig);
      assert.strictEqual(result.pmConfig.mode, "watching");
    });
  });

  // ---------------------------------------------------------------------------
  // upsertSettings — insert path
  // ---------------------------------------------------------------------------

  describe("upsertSettings (insert)", () => {
    it("creates a new row with merged defaults", () => {
      const settings = store.upsertSettings(workflowId, { mode: "executing" });

      assert.ok(settings.id);
      assert.strictEqual(settings.workflowId, workflowId);
      assert.ok(settings.pmConfig);
      assert.strictEqual(settings.pmConfig.mode, "executing");
      // Defaults inherited for polling and alerts
      assert.deepStrictEqual(
        settings.pmConfig.polling,
        DEFAULT_PM_CONFIG.polling
      );
      assert.deepStrictEqual(
        settings.pmConfig.alerts,
        DEFAULT_PM_CONFIG.alerts
      );
      assert.ok(settings.createdAt);
      assert.ok(settings.updatedAt);
    });

    it("merges partial polling overrides with defaults", () => {
      const settings = store.upsertSettings(workflowId, {
        polling: { intervalMinutes: 10 },
      } as Partial<PmConfig>);

      assert.ok(settings.pmConfig);
      assert.strictEqual(settings.pmConfig.polling.intervalMinutes, 10);
      assert.strictEqual(
        settings.pmConfig.polling.stuckThresholdMinutes,
        DEFAULT_PM_CONFIG.polling.stuckThresholdMinutes
      );
      assert.strictEqual(
        settings.pmConfig.polling.alertCooldownMinutes,
        DEFAULT_PM_CONFIG.polling.alertCooldownMinutes
      );
    });

    it("merges partial alert flag overrides with defaults", () => {
      const settings = store.upsertSettings(workflowId, {
        alerts: { stuckTickets: false },
      } as Partial<PmConfig>);

      assert.ok(settings.pmConfig);
      assert.strictEqual(settings.pmConfig.alerts.stuckTickets, false);
      // Other flags inherit defaults
      assert.strictEqual(settings.pmConfig.alerts.ralphFailures, true);
      assert.strictEqual(settings.pmConfig.alerts.dependencyUnblocks, true);
      assert.strictEqual(settings.pmConfig.alerts.sessionCrashes, true);
    });
  });

  // ---------------------------------------------------------------------------
  // upsertSettings — update path
  // ---------------------------------------------------------------------------

  describe("upsertSettings (update)", () => {
    it("updates existing row and preserves other fields", () => {
      store.upsertSettings(workflowId, { mode: "watching" });
      const updated = store.upsertSettings(workflowId, { mode: "executing" });

      assert.ok(updated.pmConfig);
      assert.strictEqual(updated.pmConfig.mode, "executing");
    });

    it("only one row exists after multiple upserts", () => {
      store.upsertSettings(workflowId, { mode: "watching" });
      store.upsertSettings(workflowId, { mode: "executing" });

      const count = db
        .prepare(
          "SELECT COUNT(*) as n FROM board_settings WHERE workflow_id = ?"
        )
        .get(workflowId) as { n: number };
      assert.strictEqual(count.n, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteSettings
  // ---------------------------------------------------------------------------

  describe("deleteSettings", () => {
    it("returns false when nothing to delete", () => {
      const result = store.deleteSettings(workflowId);
      assert.strictEqual(result, false);
    });

    it("returns true and removes the row", () => {
      store.upsertSettings(workflowId, { mode: "watching" });
      const result = store.deleteSettings(workflowId);

      assert.strictEqual(result, true);
      assert.strictEqual(store.getSettings(workflowId), null);
    });
  });

  // ---------------------------------------------------------------------------
  // getPmConfig — inheritance
  // ---------------------------------------------------------------------------

  describe("getPmConfig", () => {
    it("returns DEFAULT_PM_CONFIG when no settings exist", () => {
      const config = store.getPmConfig(workflowId);
      assert.deepStrictEqual(config, DEFAULT_PM_CONFIG);
    });

    it("returns DEFAULT_PM_CONFIG when settings row has null pmConfig", () => {
      // Force a row with null pm_config
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO board_settings (id, workflow_id, pm_config, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)"
      ).run("test-id-null-cfg", workflowId, now, now);

      const config = store.getPmConfig(workflowId);
      assert.deepStrictEqual(config, DEFAULT_PM_CONFIG);
    });

    it("returns stored config when overrides exist", () => {
      store.upsertSettings(workflowId, { mode: "executing" });
      const config = store.getPmConfig(workflowId);

      assert.strictEqual(config.mode, "executing");
    });

    it("reflects DEFAULT_PM_CONFIG after deleteSettings", () => {
      store.upsertSettings(workflowId, { mode: "watching" });
      store.deleteSettings(workflowId);

      const config = store.getPmConfig(workflowId);
      assert.deepStrictEqual(config, DEFAULT_PM_CONFIG);
    });
  });

  // ---------------------------------------------------------------------------
  // DEFAULT_PM_CONFIG constant
  // ---------------------------------------------------------------------------

  describe("DEFAULT_PM_CONFIG", () => {
    it("has mode passive", () => {
      assert.strictEqual(DEFAULT_PM_CONFIG.mode, "passive");
    });

    it("has 5-minute polling interval", () => {
      assert.strictEqual(DEFAULT_PM_CONFIG.polling.intervalMinutes, 5);
    });

    it("has 30-minute stuck threshold", () => {
      assert.strictEqual(DEFAULT_PM_CONFIG.polling.stuckThresholdMinutes, 30);
    });

    it("has 15-minute cooldown", () => {
      assert.strictEqual(DEFAULT_PM_CONFIG.polling.alertCooldownMinutes, 15);
    });

    it("has all alert flags enabled", () => {
      assert.strictEqual(DEFAULT_PM_CONFIG.alerts.stuckTickets, true);
      assert.strictEqual(DEFAULT_PM_CONFIG.alerts.ralphFailures, true);
      assert.strictEqual(DEFAULT_PM_CONFIG.alerts.dependencyUnblocks, true);
      assert.strictEqual(DEFAULT_PM_CONFIG.alerts.sessionCrashes, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Cascade Delete (FK ON DELETE CASCADE)
  // ---------------------------------------------------------------------------

  describe("cascade delete when workflow is deleted", () => {
    it("automatically deletes board_settings when workflow is deleted", () => {
      // Create board settings for the workflow
      store.upsertSettings(workflowId, { mode: "executing" });

      // Verify the settings exist
      let settings = store.getSettings(workflowId);
      assert.ok(settings);
      assert.strictEqual(settings.workflowId, workflowId);

      // Delete the workflow via the project_workflows table
      const workflowStore = createProjectWorkflowStore(db);
      const deleted = workflowStore.deleteWorkflow(workflowId);
      assert.strictEqual(deleted, true);

      // Verify board_settings row was automatically deleted by FK cascade
      settings = store.getSettings(workflowId);
      assert.strictEqual(settings, null);
    });
  });
});
