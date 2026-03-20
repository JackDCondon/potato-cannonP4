import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import { createProjectStore } from "../project.store.js";
import { createBrainstormStore, BrainstormStore } from "../brainstorm.store.js";
import { createTicketStore, TicketStore } from "../ticket.store.js";
import { createProjectWorkflowStore } from "../project-workflow.store.js";

describe("BrainstormStore", () => {
  let db: Database.Database;
  let store: BrainstormStore;
  let ticketStore: TicketStore;
  let testDbPath: string;
  let projectId: string;
  let defaultWorkflowId: string;
  let alternateWorkflowId: string;
  const createOwnedBrainstorm = (input: { name?: string } = {}) =>
    store.createBrainstorm(projectId, {
      workflowId: defaultWorkflowId,
      ...input,
    });

  before(() => {
    testDbPath = path.join(os.tmpdir(), `potato-brainstorm-test-${Date.now()}.db`);
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Test Project",
      path: "/test/project",
    });
    projectId = project.id;
    const workflowStore = createProjectWorkflowStore(db);
    const alternateWorkflow = workflowStore.createWorkflow({
      projectId,
      name: "Alternate Workflow",
      templateName: "product-development",
    });
    defaultWorkflowId = (
      db
        .prepare(
          "SELECT id FROM project_workflows WHERE project_id = ? AND is_default = 1 LIMIT 1"
        )
        .get(projectId) as { id: string }
    ).id;
    alternateWorkflowId = alternateWorkflow.id;

    store = createBrainstormStore(db);
    ticketStore = createTicketStore(db);
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
    // Order matters due to foreign key constraints
    db.prepare("DELETE FROM sessions").run();
    db.prepare("DELETE FROM conversation_messages").run();
    db.prepare("DELETE FROM tasks").run();
    db.prepare("UPDATE tickets SET brainstorm_id = NULL").run();
    db.prepare("DELETE FROM ticket_history").run();
    db.prepare("DELETE FROM tickets").run();
    db.prepare("DELETE FROM brainstorms").run();
    db.prepare("DELETE FROM conversations").run();
  });

  describe("createBrainstorm", () => {
    it("should reject brainstorm creation without workflow ownership", () => {
      let error: unknown;
      try {
        store.createBrainstorm(projectId, {} as any);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof Error);
      assert.match(error.message, /workflow/i);
    });

    it("should create a brainstorm with generated ID", () => {
      const brainstorm = store.createBrainstorm(projectId, {
        workflowId: defaultWorkflowId,
      });

      assert.ok(brainstorm.id);
      assert.ok(brainstorm.id.startsWith("brain_"));
      assert.strictEqual(brainstorm.projectId, projectId);
      assert.strictEqual(brainstorm.status, "active");
      assert.strictEqual(brainstorm.workflowId, defaultWorkflowId);
      assert.ok(brainstorm.createdAt);
      assert.ok(brainstorm.updatedAt);
    });

    it("should auto-generate name with timestamp", () => {
      const brainstorm = store.createBrainstorm(projectId, {
        workflowId: defaultWorkflowId,
      });

      assert.ok(brainstorm.name);
      assert.ok(brainstorm.name.startsWith("Brainstorm "));
    });

    it("should use custom name when provided", () => {
      const brainstorm = store.createBrainstorm(projectId, {
        name: "My Custom Brainstorm",
        workflowId: defaultWorkflowId,
      });

      assert.strictEqual(brainstorm.name, "My Custom Brainstorm");
    });

    it("should create associated conversation", () => {
      const brainstorm = store.createBrainstorm(projectId, {
        workflowId: defaultWorkflowId,
      });

      assert.ok(brainstorm.conversationId);
    });

    it("should have null createdTicketId initially", () => {
      const brainstorm = store.createBrainstorm(projectId, {
        workflowId: defaultWorkflowId,
      });

      assert.strictEqual(brainstorm.createdTicketId, null);
    });
  });

  describe("getBrainstorm", () => {
    it("should return null for non-existent brainstorm", () => {
      const brainstorm = store.getBrainstorm("non-existent");
      assert.strictEqual(brainstorm, null);
    });

    it("should return brainstorm by ID", () => {
      const created = createOwnedBrainstorm();
      const brainstorm = store.getBrainstorm(created.id);

      assert.ok(brainstorm);
      assert.strictEqual(brainstorm.id, created.id);
    });
  });

  describe("getBrainstormByProject", () => {
    it("should return null for wrong project", () => {
      const created = createOwnedBrainstorm();
      const brainstorm = store.getBrainstormByProject("wrong-project", created.id);

      assert.strictEqual(brainstorm, null);
    });

    it("should return brainstorm for correct project", () => {
      const created = createOwnedBrainstorm();
      const brainstorm = store.getBrainstormByProject(projectId, created.id);

      assert.ok(brainstorm);
      assert.strictEqual(brainstorm.id, created.id);
    });
  });

  describe("listBrainstorms", () => {
    it("should return empty array when no brainstorms", () => {
      const brainstorms = store.listBrainstorms(projectId, defaultWorkflowId);
      assert.deepStrictEqual(brainstorms, []);
    });

    it("should return brainstorms for project", () => {
      createOwnedBrainstorm({ name: "First" });
      createOwnedBrainstorm({ name: "Second" });

      const brainstorms = store.listBrainstorms(projectId, defaultWorkflowId);

      assert.strictEqual(brainstorms.length, 2);
    });

    it("should sort by updated_at descending", () => {
      const first = createOwnedBrainstorm({ name: "First" });
      createOwnedBrainstorm({ name: "Second" });

      // Update first to make it most recent
      store.updateBrainstorm(first.id, { name: "First Updated" });

      const brainstorms = store.listBrainstorms(projectId, defaultWorkflowId);

      assert.strictEqual(brainstorms[0].name, "First Updated");
    });

    it("should not return brainstorms from other projects", () => {
      createOwnedBrainstorm();

      const brainstorms = store.listBrainstorms("other-project", defaultWorkflowId);

      assert.deepStrictEqual(brainstorms, []);
    });

    it("should only return brainstorms for the requested workflow", () => {
      createOwnedBrainstorm({ name: "Default Workflow Brainstorm" });
      store.createBrainstorm(projectId, {
        name: "Alternate Workflow Brainstorm",
        workflowId: alternateWorkflowId,
      });

      const brainstorms = store.listBrainstorms(projectId, alternateWorkflowId);

      assert.strictEqual(brainstorms.length, 1);
      assert.strictEqual(brainstorms[0].workflowId, alternateWorkflowId);
      assert.strictEqual(brainstorms[0].name, "Alternate Workflow Brainstorm");
    });
  });

  describe("updateBrainstorm", () => {
    it("should update name", () => {
      const created = createOwnedBrainstorm();

      const updated = store.updateBrainstorm(created.id, {
        name: "New Name",
      });

      assert.ok(updated);
      assert.strictEqual(updated.name, "New Name");
    });

    it("should update status", () => {
      const created = createOwnedBrainstorm();

      const updated = store.updateBrainstorm(created.id, {
        status: "completed",
      });

      assert.ok(updated);
      assert.strictEqual(updated.status, "completed");
    });

    it("should update createdTicketId", () => {
      const created = createOwnedBrainstorm();

      const updated = store.updateBrainstorm(created.id, {
        createdTicketId: "TES-1",
      });

      assert.ok(updated);
      assert.strictEqual(updated.createdTicketId, "TES-1");
    });

    it("should update updatedAt timestamp", () => {
      const created = createOwnedBrainstorm();
      const originalUpdatedAt = created.updatedAt;

      const updated = store.updateBrainstorm(created.id, { name: "Updated" });

      assert.ok(updated);
      assert.ok(updated.updatedAt >= originalUpdatedAt);
    });

    it("should return null for non-existent brainstorm", () => {
      const result = store.updateBrainstorm("non-existent", { name: "Test" });
      assert.strictEqual(result, null);
    });
  });

  describe("deleteBrainstorm", () => {
    it("should delete existing brainstorm", () => {
      const created = createOwnedBrainstorm();

      const deleted = store.deleteBrainstorm(created.id);

      assert.strictEqual(deleted, true);
      assert.strictEqual(store.getBrainstorm(created.id), null);
    });

    it("should return false for non-existent brainstorm", () => {
      const deleted = store.deleteBrainstorm("non-existent");
      assert.strictEqual(deleted, false);
    });

    it("should null brainstorm_id on linked tickets when deleted", () => {
      const brainstorm = createOwnedBrainstorm();
      const ticket = ticketStore.createTicket(projectId, { title: "Linked" });
      // Directly set brainstorm_id since ticket store brainstormId support is in a parallel task
      db.prepare("UPDATE tickets SET brainstorm_id = ? WHERE id = ?").run(brainstorm.id, ticket.id);

      store.deleteBrainstorm(brainstorm.id);

      const row = db.prepare("SELECT brainstorm_id FROM tickets WHERE id = ?").get(ticket.id) as { brainstorm_id: string | null };
      assert.strictEqual(row.brainstorm_id, null, "brainstorm_id should be nulled after brainstorm deletion");
    });
  });

  describe("planSummary", () => {
    it("should be undefined initially", () => {
      const brainstorm = createOwnedBrainstorm();
      assert.strictEqual(brainstorm.planSummary, undefined);
    });

    it("should be settable via updateBrainstorm", () => {
      const brainstorm = createOwnedBrainstorm();
      const updated = store.updateBrainstorm(brainstorm.id, {
        planSummary: "This epic delivers auth features",
      });
      assert.strictEqual(updated?.planSummary, "This epic delivers auth features");
    });
  });

  describe("getTicketCountsForBrainstorm", () => {
    it("should return zero counts for brainstorm with no tickets", () => {
      const brainstorm = createOwnedBrainstorm();
      const counts = store.getTicketCountsForBrainstorm(brainstorm.id);
      assert.strictEqual(counts.ticketCount, 0);
      assert.strictEqual(counts.activeTicketCount, 0);
    });

    it("should return correct counts with linked tickets", () => {
      const brainstorm = createOwnedBrainstorm();

      const t1 = ticketStore.createTicket(projectId, { title: "Active ticket" });
      const t2 = ticketStore.createTicket(projectId, { title: "Done ticket" });
      // Directly set brainstorm_id since ticket store brainstormId support is in a parallel task
      db.prepare("UPDATE tickets SET brainstorm_id = ? WHERE id = ?").run(brainstorm.id, t1.id);
      db.prepare("UPDATE tickets SET brainstorm_id = ? WHERE id = ?").run(brainstorm.id, t2.id);
      db.prepare("UPDATE tickets SET phase = 'Done' WHERE id = ?").run(t2.id);

      const counts = store.getTicketCountsForBrainstorm(brainstorm.id);
      assert.strictEqual(counts.ticketCount, 2);
      assert.strictEqual(counts.activeTicketCount, 1);
    });
  });

  describe("getTicketCountsBatch", () => {
    it("should return empty map for empty input", () => {
      const result = store.getTicketCountsBatch([]);
      assert.strictEqual(result.size, 0);
    });

    it("should return counts for multiple brainstorms", () => {
      const b1 = createOwnedBrainstorm();
      const b2 = createOwnedBrainstorm();

      const t1 = ticketStore.createTicket(projectId, { title: "B1 T1" });
      const t2 = ticketStore.createTicket(projectId, { title: "B1 T2" });
      const t3 = ticketStore.createTicket(projectId, { title: "B2 T1" });
      // Directly set brainstorm_id since ticket store brainstormId support is in a parallel task
      db.prepare("UPDATE tickets SET brainstorm_id = ? WHERE id = ?").run(b1.id, t1.id);
      db.prepare("UPDATE tickets SET brainstorm_id = ? WHERE id = ?").run(b1.id, t2.id);
      db.prepare("UPDATE tickets SET brainstorm_id = ? WHERE id = ?").run(b2.id, t3.id);

      const result = store.getTicketCountsBatch([b1.id, b2.id]);
      assert.strictEqual(result.get(b1.id)?.ticketCount, 2);
      assert.strictEqual(result.get(b1.id)?.activeTicketCount, 2);
      assert.strictEqual(result.get(b2.id)?.ticketCount, 1);
      assert.strictEqual(result.get(b2.id)?.activeTicketCount, 1);
    });

    it("should not include entry for brainstorm with no tickets", () => {
      const b1 = createOwnedBrainstorm();
      const result = store.getTicketCountsBatch([b1.id]);
      // No tickets → no row in GROUP BY result → not in map
      assert.strictEqual(result.has(b1.id), false);
    });
  });

  describe("getUsedEpicColors", () => {
    it("returns colors of epic brainstorms", () => {
      const b = createOwnedBrainstorm();
      store.updateBrainstorm(b.id, { status: "epic", color: "#3b82f6" });
      const colors = store.getUsedEpicColors(projectId);
      assert.deepStrictEqual(colors, ["#3b82f6"]);
    });

    it("excludes non-epic brainstorms with colors", () => {
      const b = createOwnedBrainstorm();
      store.updateBrainstorm(b.id, { color: "#3b82f6" });
      const colors = store.getUsedEpicColors(projectId);
      assert.deepStrictEqual(colors, []);
    });

    it("excludes epics with null color", () => {
      const b = createOwnedBrainstorm();
      store.updateBrainstorm(b.id, { status: "epic" });
      const colors = store.getUsedEpicColors(projectId);
      assert.deepStrictEqual(colors, []);
    });

    it("returns distinct colors", () => {
      const b1 = createOwnedBrainstorm();
      const b2 = createOwnedBrainstorm();
      store.updateBrainstorm(b1.id, { status: "epic", color: "#3b82f6" });
      store.updateBrainstorm(b2.id, { status: "epic", color: "#3b82f6" });
      const colors = store.getUsedEpicColors(projectId);
      assert.deepStrictEqual(colors, ["#3b82f6"]);
    });

    it("returns empty for project with no epics", () => {
      const colors = store.getUsedEpicColors(projectId);
      assert.deepStrictEqual(colors, []);
    });
  });

  describe("updateBrainstorm color/icon", () => {
    it("sets color and icon", () => {
      const b = createOwnedBrainstorm();
      const updated = store.updateBrainstorm(b.id, { color: "#10b981", icon: "rocket" });
      assert.ok(updated, "updateBrainstorm should return non-null");
      assert.strictEqual(updated!.color, "#10b981");
      assert.strictEqual(updated!.icon, "rocket");
    });

    it("clears color and icon with explicit null", () => {
      const b = createOwnedBrainstorm();
      store.updateBrainstorm(b.id, { color: "#10b981", icon: "rocket" });
      const updated = store.updateBrainstorm(b.id, { color: null, icon: null });
      assert.ok(updated, "updateBrainstorm should return non-null");
      assert.strictEqual(updated!.color, null);
      assert.strictEqual(updated!.icon, null);
    });

    it("new brainstorm has null color and icon", () => {
      const b = createOwnedBrainstorm();
      assert.strictEqual(b.color, null);
      assert.strictEqual(b.icon, null);
    });
  });
});
