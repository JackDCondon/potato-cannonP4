import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../../stores/migrations.js";
import { createProjectStore } from "../../stores/project.store.js";
import { createProjectWorkflowStore, type ProjectWorkflowStore } from "../../stores/project-workflow.store.js";
import { createTicketStore } from "../../stores/ticket.store.js";
import { getProjectDataDir, getProjectFilesDir } from "../../config/paths.js";
import { deleteProjectWithLifecycle } from "../routes/projects.routes.js";

describe("projects routes - workflow bootstrap invariants", () => {
  let db: Database.Database;
  let testDbPath: string;
  let workflowStore: ProjectWorkflowStore;

  before(() => {
    testDbPath = path.join(
      os.tmpdir(),
      `potato-test-project-routes-${Date.now()}.db`
    );
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    workflowStore = createProjectWorkflowStore(db);
  });

  after(() => {
    db.close();
    try {
      fs.unlinkSync(testDbPath);
      fs.unlinkSync(testDbPath + "-wal");
      fs.unlinkSync(testDbPath + "-shm");
    } catch {
      // Ignore cleanup errors.
    }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM project_workflows").run();
    db.prepare("DELETE FROM projects").run();
  });

  it("project creation with explicit template creates exactly one default workflow", () => {
    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Template Project",
      path: "/tmp/template-project",
      templateName: "product-development-p4",
    });

    const workflows = workflowStore.listWorkflows(project.id);
    assert.strictEqual(workflows.length, 1);
    assert.strictEqual(workflows[0].isDefault, true);
    assert.strictEqual(workflows[0].templateName, "product-development-p4");
  });

  it("project creation without explicit template creates exactly one default workflow", () => {
    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Implicit Template Project",
      path: "/tmp/implicit-project",
    });

    const workflows = workflowStore.listWorkflows(project.id);
    assert.strictEqual(workflows.length, 1);
    assert.strictEqual(workflows[0].isDefault, true);
    assert.ok(workflows[0].templateName.length > 0);
  });

  it("project payload contract includes providerOverride and PATCH persistence fields", () => {
    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Provider Override Project",
      path: "/tmp/provider-override-project",
    });

    const updated = projectStore.updateProject(project.id, { providerOverride: "openai" });
    assert.strictEqual(updated?.providerOverride, "openai");

    const serialized = {
      id: updated!.id,
      slug: updated!.slug,
      displayName: updated!.displayName,
      path: updated!.path,
      providerOverride: updated!.providerOverride,
    };

    assert.deepStrictEqual(serialized, {
      id: project.id,
      slug: project.slug,
      displayName: "Provider Override Project",
      path: "/tmp/provider-override-project",
      providerOverride: "openai",
    });
  });

  it("repairs a legacy project with zero workflows by creating a default workflow", () => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO projects (id, slug, display_name, path, registered_at, template_name) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("legacy-project", "legacy-project", "Legacy Project", "/tmp/legacy-project", now, "product-development");

    const initial = workflowStore.listWorkflows("legacy-project");
    assert.strictEqual(initial.length, 0);

    const ensured = workflowStore.ensureDefaultWorkflow("legacy-project");
    const repaired = workflowStore.listWorkflows("legacy-project");

    assert.strictEqual(repaired.length, 1);
    assert.strictEqual(repaired[0].id, ensured.id);
    assert.strictEqual(repaired[0].isDefault, true);
    assert.strictEqual(repaired[0].templateName, "product-development");
  });

  it("deletes all project tickets via lifecycle cleanup before deleting workflows and project rows", async () => {
    const projectStore = createProjectStore(db);
    const ticketStore = createTicketStore(db);
    const project = projectStore.createProject({
      displayName: "Delete Project",
      path: "/tmp/delete-project",
      templateName: "product-development",
    });
    const extraWorkflow = workflowStore.createWorkflow({
      projectId: project.id,
      name: "Board B",
      templateName: "product-development",
    });

    const defaultWorkflow = workflowStore.getDefaultWorkflow(project.id);
    assert.ok(defaultWorkflow);

    const defaultTicket = ticketStore.createTicket(project.id, {
      title: "Default ticket",
      workflowId: defaultWorkflow!.id,
    });
    const secondTicket = ticketStore.createTicket(project.id, {
      title: "Second board ticket",
      workflowId: extraWorkflow.id,
    });

    ticketStore.updateTicket(project.id, defaultTicket.id, { phase: "Done" });
    ticketStore.archiveTicket(project.id, defaultTicket.id);

    const projectDataDir = getProjectDataDir(project.id);
    const projectFilesDir = getProjectFilesDir(project.id);
    await fsp.mkdir(projectDataDir, { recursive: true });
    await fsp.mkdir(projectFilesDir, { recursive: true });
    await fsp.writeFile(path.join(projectDataDir, "sentinel.txt"), "data");
    await fsp.writeFile(path.join(projectFilesDir, "sentinel.txt"), "files");

    const ticketCleanupOrder: string[] = [];
    const summary = await deleteProjectWithLifecycle(
      project.id,
      {
        terminateTicketSession: async () => false,
      },
      {
        listTicketsFn: (projectId, options) =>
          ticketStore.listTickets(projectId, options),
        deleteWorkflowsFn: (projectId) =>
          workflowStore.deleteWorkflowsForProject(projectId),
        deleteProjectFn: (projectId) => projectStore.deleteProject(projectId),
        deleteProjectScopedDataFn: async (projectId) => {
          await fsp.rm(getProjectDataDir(projectId), {
            recursive: true,
            force: true,
          });
          await fsp.rm(getProjectFilesDir(projectId), {
            recursive: true,
            force: true,
          });
        },
        deleteTicketFn: async (projectId, ticketId) => {
          // Project/workflows must still exist while per-ticket cleanup is running.
          const existingProject = projectStore.getProjectById(projectId);
          assert.ok(existingProject);
          assert.ok(workflowStore.listWorkflows(projectId).length > 0);
          ticketCleanupOrder.push(ticketId);
          const realStore = createTicketStore(db);
          realStore.deleteTicket(projectId, ticketId);
          return {
            sessionStopped: false,
            queueCancelled: 0,
            routesRemoved: 0,
            threadDeletesAttempted: 0,
            threadDeleteErrors: [],
          };
        },
      },
    );

    assert.deepStrictEqual(ticketCleanupOrder.sort(), [defaultTicket.id, secondTicket.id].sort());
    assert.strictEqual(summary.deletedTickets, 2);
    assert.strictEqual(summary.deletedWorkflows, 2);

    const remainingProject = projectStore.getProjectById(project.id);
    assert.strictEqual(remainingProject, null);
    assert.strictEqual(workflowStore.listWorkflows(project.id).length, 0);
    assert.strictEqual(ticketStore.listTickets(project.id, { archived: null }).length, 0);
    assert.strictEqual(fs.existsSync(projectDataDir), false);
    assert.strictEqual(fs.existsSync(projectFilesDir), false);
  });

  it("aborts project deletion when ticket lifecycle cleanup fails and leaves project row intact", async () => {
    const projectStore = createProjectStore(db);
    const ticketStore = createTicketStore(db);
    const project = projectStore.createProject({
      displayName: "Failing Delete Project",
      path: "/tmp/failing-delete-project",
      templateName: "product-development",
    });

    const defaultWorkflow = workflowStore.getDefaultWorkflow(project.id);
    assert.ok(defaultWorkflow);
    ticketStore.createTicket(project.id, {
      title: "Will fail cleanup",
      workflowId: defaultWorkflow!.id,
    });

    await assert.rejects(
      deleteProjectWithLifecycle(
        project.id,
      {
        terminateTicketSession: async () => false,
      },
      {
        listTicketsFn: (projectId, options) =>
          ticketStore.listTickets(projectId, options),
        deleteWorkflowsFn: (projectId) =>
          workflowStore.deleteWorkflowsForProject(projectId),
        deleteProjectFn: (projectId) => projectStore.deleteProject(projectId),
        deleteProjectScopedDataFn: async () => {},
        deleteTicketFn: async () => {
          throw new Error("simulated cleanup failure");
        },
      },
    ),
      /simulated cleanup failure/,
    );

    assert.ok(projectStore.getProjectById(project.id));
    assert.ok(workflowStore.listWorkflows(project.id).length > 0);
    assert.strictEqual(ticketStore.listTickets(project.id, { archived: null }).length, 1);
  });
});
