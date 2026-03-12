import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import {
  createProjectWorkflowStore,
  ProjectWorkflowStore,
} from "../project-workflow.store.js";
import { createProjectStore } from "../project.store.js";
import { getWorkflowTemplateDir } from "../../config/paths.js";

// UUID v4 regex pattern
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("ProjectWorkflowStore", () => {
  let db: Database.Database;
  let store: ProjectWorkflowStore;
  let testDbPath: string;
  let projectId: string;

  before(() => {
    testDbPath = path.join(
      os.tmpdir(),
      `potato-test-workflow-${Date.now()}.db`
    );
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    store = createProjectWorkflowStore(db);

    // Create a project to own workflows
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
    // Clear workflows before each test
    db.prepare("DELETE FROM project_workflows").run();
  });

  describe("createWorkflow", () => {
    it("should create a workflow with auto-generated UUID", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "Main Board",
        templateName: "product-development",
        isDefault: false,
      });

      assert.match(workflow.id, UUID_REGEX, "ID should be a valid UUID");
      assert.strictEqual(workflow.projectId, projectId);
      assert.strictEqual(workflow.name, "Main Board");
      assert.strictEqual(workflow.templateName, "product-development");
      assert.strictEqual(workflow.templateVersion, "1.0.0");
      assert.strictEqual(workflow.isDefault, false);
      assert.ok(workflow.createdAt);
      assert.ok(workflow.updatedAt);
    });

    it("should create a default workflow", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "Default Board",
        templateName: "product-development",
        isDefault: true,
      });

      assert.strictEqual(workflow.isDefault, true);
    });

    it("should default isDefault to false when not provided", () => {
      const workflow = store.createWorkflow({
        projectId,
        name: "My Board",
        templateName: "product-development",
      });

      assert.strictEqual(workflow.isDefault, false);
    });

    it("should store ISO 8601 timestamps", () => {
      const before = new Date().toISOString();
      const workflow = store.createWorkflow({
        projectId,
        name: "Timestamped",
        templateName: "product-development",
      });
      const after = new Date().toISOString();

      assert.ok(workflow.createdAt >= before);
      assert.ok(workflow.createdAt <= after);
      assert.strictEqual(workflow.createdAt, workflow.updatedAt);
    });
  });

  describe("getWorkflow", () => {
    it("should return null for non-existent workflow", () => {
      const workflow = store.getWorkflow("non-existent");
      assert.strictEqual(workflow, null);
    });

    it("should return workflow by id", () => {
      const created = store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "product-development",
      });

      const workflow = store.getWorkflow(created.id);
      assert.ok(workflow);
      assert.strictEqual(workflow.id, created.id);
      assert.strictEqual(workflow.name, "Board");
    });
  });

  describe("listWorkflows", () => {
    it("should return empty array when no workflows", () => {
      const workflows = store.listWorkflows(projectId);
      assert.deepStrictEqual(workflows, []);
    });

    it("should return all workflows for a project ordered by name", () => {
      store.createWorkflow({
        projectId,
        name: "Zebra Board",
        templateName: "product-development",
      });
      store.createWorkflow({
        projectId,
        name: "Alpha Board",
        templateName: "product-development",
      });
      store.createWorkflow({
        projectId,
        name: "Middle Board",
        templateName: "product-development",
      });

      const workflows = store.listWorkflows(projectId);
      assert.strictEqual(workflows.length, 3);
      assert.strictEqual(workflows[0].name, "Alpha Board");
      assert.strictEqual(workflows[1].name, "Middle Board");
      assert.strictEqual(workflows[2].name, "Zebra Board");
    });

    it("should only return workflows for the specified project", () => {
      // Create a second project
      const projectStore = createProjectStore(db);
      const otherProject = projectStore.createProject({
        displayName: "Other Project",
        path: "/other/project",
      });

      store.createWorkflow({
        projectId,
        name: "Board A",
        templateName: "product-development",
      });
      store.createWorkflow({
        projectId: otherProject.id,
        name: "Board B",
        templateName: "product-development",
      });

      const workflows = store.listWorkflows(projectId);
      assert.strictEqual(workflows.length, 1);
      assert.strictEqual(workflows[0].name, "Board A");
    });
  });

  describe("updateWorkflow", () => {
    it("should return null for non-existent workflow", () => {
      const result = store.updateWorkflow("non-existent", { name: "New Name" });
      assert.strictEqual(result, null);
    });

    it("should update workflow name", () => {
      const created = store.createWorkflow({
        projectId,
        name: "Original",
        templateName: "product-development",
      });

      const updated = store.updateWorkflow(created.id, { name: "Renamed" });
      assert.ok(updated);
      assert.strictEqual(updated.name, "Renamed");

      // Verify persistence
      const fetched = store.getWorkflow(created.id);
      assert.strictEqual(fetched?.name, "Renamed");
    });

    it("should update templateName", () => {
      const created = store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "product-development",
      });

      const updated = store.updateWorkflow(created.id, {
        templateName: "custom-template",
      });
      assert.ok(updated);
      assert.strictEqual(updated.templateName, "custom-template");
      assert.strictEqual(updated.templateVersion, "1.0.0");
    });

    it("should update explicit templateVersion", () => {
      const created = store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "product-development",
      });

      const updated = store.updateWorkflow(created.id, {
        templateVersion: "4.3.2",
      });
      assert.ok(updated);
      assert.strictEqual(updated.templateVersion, "4.3.2");
    });

    it("should update isDefault", () => {
      const created = store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "product-development",
        isDefault: false,
      });

      const updated = store.updateWorkflow(created.id, { isDefault: true });
      assert.ok(updated);
      assert.strictEqual(updated.isDefault, true);
    });

    it("should update updatedAt timestamp on change", () => {
      const created = store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "product-development",
      });

      // Small delay to ensure timestamp difference
      const before = new Date().toISOString();
      const updated = store.updateWorkflow(created.id, { name: "New Name" });
      assert.ok(updated);
      assert.ok(updated.updatedAt >= before);
    });

    it("should return existing workflow when no fields updated", () => {
      const created = store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "product-development",
      });

      const result = store.updateWorkflow(created.id, {});
      assert.ok(result);
      assert.strictEqual(result.name, "Board");
    });
  });

  describe("deleteWorkflow", () => {
    it("should delete an existing workflow", () => {
      const created = store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "product-development",
      });

      const deleted = store.deleteWorkflow(created.id);
      assert.strictEqual(deleted, true);

      const workflow = store.getWorkflow(created.id);
      assert.strictEqual(workflow, null);
    });

    it("should return false for non-existent workflow", () => {
      const deleted = store.deleteWorkflow("non-existent");
      assert.strictEqual(deleted, false);
    });
  });

  describe("getDefaultWorkflow", () => {
    it("should return null when no workflows exist", () => {
      const workflow = store.getDefaultWorkflow(projectId);
      assert.strictEqual(workflow, null);
    });

    it("should return null when no default workflow is set", () => {
      store.createWorkflow({
        projectId,
        name: "Board",
        templateName: "product-development",
        isDefault: false,
      });

      const workflow = store.getDefaultWorkflow(projectId);
      assert.strictEqual(workflow, null);
    });

    it("should return the default workflow", () => {
      store.createWorkflow({
        projectId,
        name: "Non-default",
        templateName: "product-development",
        isDefault: false,
      });
      store.createWorkflow({
        projectId,
        name: "Default Board",
        templateName: "product-development",
        isDefault: true,
      });

      const workflow = store.getDefaultWorkflow(projectId);
      assert.ok(workflow);
      assert.strictEqual(workflow.name, "Default Board");
      assert.strictEqual(workflow.isDefault, true);
    });

    it("should enforce single default per project when updating", () => {
      const workflowA = store.createWorkflow({
        projectId,
        name: "Workflow A",
        templateName: "product-development",
        isDefault: true,
      });
      const workflowB = store.createWorkflow({
        projectId,
        name: "Workflow B",
        templateName: "product-development",
        isDefault: false,
      });

      // Set workflow B as default — should clear A's default
      store.updateWorkflow(workflowB.id, { isDefault: true });

      const defaultWorkflow = store.getDefaultWorkflow(projectId);
      assert.ok(defaultWorkflow, "A default workflow should exist");
      assert.strictEqual(
        defaultWorkflow.id,
        workflowB.id,
        "Workflow B should be the default"
      );

      // Verify A is no longer the default
      const updatedA = store.getWorkflow(workflowA.id);
      assert.strictEqual(
        updatedA?.isDefault,
        false,
        "Workflow A should no longer be default"
      );

      // Verify exactly one default exists
      const allWorkflows = store.listWorkflows(projectId);
      const defaults = allWorkflows.filter((w) => w.isDefault);
      assert.strictEqual(defaults.length, 1, "Exactly one default should exist");
    });

    it("should enforce single default per project when creating", () => {
      store.createWorkflow({
        projectId,
        name: "First Default",
        templateName: "product-development",
        isDefault: true,
      });
      store.createWorkflow({
        projectId,
        name: "Second Default",
        templateName: "product-development",
        isDefault: true,
      });

      const defaultWorkflow = store.getDefaultWorkflow(projectId);
      assert.ok(defaultWorkflow, "A default workflow should exist");
      assert.strictEqual(
        defaultWorkflow.name,
        "Second Default",
        "The last created default should be the default"
      );

      // Verify exactly one default exists
      const allWorkflows = store.listWorkflows(projectId);
      const defaults = allWorkflows.filter((w) => w.isDefault);
      assert.strictEqual(defaults.length, 1, "Exactly one default should exist");
    });

    it("should only return default from the specified project", () => {
      // Create a second project with its own default
      const projectStore = createProjectStore(db);
      const otherProject = projectStore.createProject({
        displayName: "Another Project",
        path: "/another/project",
      });

      store.createWorkflow({
        projectId: otherProject.id,
        name: "Other Default",
        templateName: "product-development",
        isDefault: true,
      });

      const workflow = store.getDefaultWorkflow(projectId);
      assert.strictEqual(workflow, null);
    });
  });

  describe("workflow template storage path", () => {
    it("returns deterministic and unique workflow template directories", () => {
      const pathA = getWorkflowTemplateDir("project/1", "workflow/a");
      const pathAAgain = getWorkflowTemplateDir("project/1", "workflow/a");
      const pathB = getWorkflowTemplateDir("project/1", "workflow/b");

      assert.strictEqual(pathA, pathAAgain);
      assert.notStrictEqual(pathA, pathB);
      assert.ok(pathA.includes("project-data"));
      assert.ok(pathA.endsWith(path.join("workflows", "workflow__a", "template")));
    });
  });
});
