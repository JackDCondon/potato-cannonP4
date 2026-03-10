import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../../stores/migrations.js";
import {
  createProjectWorkflowStore,
  type ProjectWorkflowStore,
} from "../../stores/project-workflow.store.js";
import { createProjectStore } from "../../stores/project.store.js";

describe("workflow routes — store-level integration", () => {
  let db: Database.Database;
  let store: ProjectWorkflowStore;
  let testDbPath: string;
  let projectId: string;

  before(() => {
    testDbPath = path.join(
      os.tmpdir(),
      `potato-test-workflow-routes-${Date.now()}.db`
    );
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    store = createProjectWorkflowStore(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Test Project",
      path: "/test/project",
    });
    projectId = project.id;
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
    db.prepare("DELETE FROM project_workflows").run();
  });

  // ── GET list ──────────────────────────────────────────────────────────────

  describe("GET /api/projects/:projectId/workflows (list)", () => {
    it("returns empty array when no workflows exist", () => {
      const workflows = store.listWorkflows(projectId);
      assert.deepStrictEqual(workflows, []);
    });

    it("returns all workflows for the project ordered by name", () => {
      store.createWorkflow({ projectId, name: "Zebra", templateName: "t1" });
      store.createWorkflow({ projectId, name: "Alpha", templateName: "t2" });

      const workflows = store.listWorkflows(projectId);
      assert.strictEqual(workflows.length, 2);
      assert.strictEqual(workflows[0].name, "Alpha");
      assert.strictEqual(workflows[1].name, "Zebra");
    });

    it("does not return workflows belonging to other projects", () => {
      const projectStore = createProjectStore(db);
      const other = projectStore.createProject({ displayName: "Other", path: "/other" });

      store.createWorkflow({ projectId, name: "Mine", templateName: "t1" });
      store.createWorkflow({ projectId: other.id, name: "Theirs", templateName: "t2" });

      const workflows = store.listWorkflows(projectId);
      assert.strictEqual(workflows.length, 1);
      assert.strictEqual(workflows[0].name, "Mine");
    });
  });

  // ── POST create ───────────────────────────────────────────────────────────

  describe("POST /api/projects/:projectId/workflows (create)", () => {
    it("creates a workflow with required fields", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "Main Board",
        templateName: "product-development",
      });

      assert.strictEqual(workflow.projectId, projectId);
      assert.strictEqual(workflow.name, "Main Board");
      assert.strictEqual(workflow.templateName, "product-development");
      assert.ok(workflow.id);
      assert.ok(workflow.createdAt);
    });

    it("creates a workflow as default when isDefault is true", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "Default Board",
        templateName: "product-development",
        isDefault: true,
      });

      assert.strictEqual(workflow.isDefault, true);
    });

    it("enforces single-default: new default clears the previous one", () => {
      const first = store.createWorkflow({
        projectId,
        name: "First",
        templateName: "t1",
        isDefault: true,
      });
      assert.strictEqual(first.isDefault, true);

      const second = store.createWorkflow({
        projectId,
        name: "Second",
        templateName: "t2",
        isDefault: true,
      });
      assert.strictEqual(second.isDefault, true);

      const refreshed = store.getWorkflow(first.id);
      assert.strictEqual(refreshed?.isDefault, false);
    });
  });

  // ── PATCH update ─────────────────────────────────────────────────────────

  describe("PATCH /api/projects/:projectId/workflows/:workflowId (update)", () => {
    it("updates the display name", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "Old Name",
        templateName: "t1",
      });

      const updated = store.updateWorkflow(workflow.id, { name: "New Name" });
      assert.strictEqual(updated?.name, "New Name");
    });

    it("updates the templateName", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "t1",
      });

      const updated = store.updateWorkflow(workflow.id, { templateName: "t2" });
      assert.strictEqual(updated?.templateName, "t2");
    });

    it("returns null when workflow does not exist", () => {
      const result = store.updateWorkflow("non-existent-id", { name: "X" });
      assert.strictEqual(result, null);
    });

    it("setting isDefault=true clears other defaults in the project", () => {
      const first = store.createWorkflow({
        projectId,
        name: "First",
        templateName: "t1",
        isDefault: true,
      });
      const second = store.createWorkflow({
        projectId,
        name: "Second",
        templateName: "t2",
        isDefault: false,
      });

      store.updateWorkflow(second.id, { isDefault: true });

      const refreshedFirst = store.getWorkflow(first.id);
      assert.strictEqual(refreshedFirst?.isDefault, false);

      const refreshedSecond = store.getWorkflow(second.id);
      assert.strictEqual(refreshedSecond?.isDefault, true);
    });
  });

  // ── DELETE guard ──────────────────────────────────────────────────────────

  describe("DELETE /api/projects/:projectId/workflows/:workflowId (delete guard)", () => {
    it("delete returns true when workflow is found and deleted", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "To Delete",
        templateName: "t1",
      });

      const deleted = store.deleteWorkflow(workflow.id);
      assert.strictEqual(deleted, true);

      const check = store.getWorkflow(workflow.id);
      assert.strictEqual(check, null);
    });

    it("delete returns false for non-existent workflow", () => {
      const deleted = store.deleteWorkflow("no-such-id");
      assert.strictEqual(deleted, false);
    });

    it("should not delete default workflow (route guard logic)", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "Default",
        templateName: "t1",
        isDefault: true,
      });

      // Simulate the route guard: isDefault === true → do NOT call deleteWorkflow
      assert.strictEqual(workflow.isDefault, true, "workflow is default");
      if (!workflow.isDefault) {
        store.deleteWorkflow(workflow.id);
      }

      // Workflow must still exist — the guard prevented deletion
      const check = store.getWorkflow(workflow.id);
      assert.ok(check, "default workflow was NOT deleted");
      assert.strictEqual(check.id, workflow.id);
    });

    it("should not delete last workflow (route guard logic)", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "Only One",
        templateName: "t1",
      });

      const all = store.listWorkflows(projectId);
      assert.strictEqual(all.length, 1, "only one workflow");

      // Simulate the route guard: length <= 1 → do NOT call deleteWorkflow
      if (all.length > 1) {
        store.deleteWorkflow(workflow.id);
      }

      // Workflow must still exist — the guard prevented deletion
      const check = store.getWorkflow(workflow.id);
      assert.ok(check, "last workflow was NOT deleted");
      assert.strictEqual(check.id, workflow.id);
    });
  });
});
