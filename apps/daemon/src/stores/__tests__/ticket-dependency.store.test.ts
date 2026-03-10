import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import {
  createTicketDependencyStore,
  TicketDependencyStore,
} from "../ticket-dependency.store.js";
import { createProjectStore } from "../project.store.js";
import { createProjectWorkflowStore } from "../project-workflow.store.js";
import { createTicketStore } from "../ticket.store.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("TicketDependencyStore", () => {
  let db: Database.Database;
  let store: TicketDependencyStore;
  let testDbPath: string;
  let projectId: string;
  let workflowId: string;

  /** Helper: create a ticket assigned to the shared workflow */
  function createTicket(title: string): string {
    const ticketStore = createTicketStore(db);
    const ticket = ticketStore.createTicket(projectId, {
      title,
      workflowId,
    });
    return ticket.id;
  }

  before(() => {
    testDbPath = path.join(
      os.tmpdir(),
      `potato-test-dep-${Date.now()}.db`
    );
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    store = createTicketDependencyStore(db);

    // Create project
    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Dep Test Project",
      path: "/test/dep-project",
    });
    projectId = project.id;

    // Create workflow
    const workflowStore = createProjectWorkflowStore(db);
    const workflow = workflowStore.createWorkflow({
      projectId,
      name: "Main Board",
      templateName: "product-development",
      isDefault: true,
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
    // Clear dependencies and tickets between tests
    db.prepare("DELETE FROM ticket_dependencies").run();
    db.prepare("DELETE FROM tickets").run();
  });

  describe("createDependency - happy path", () => {
    it("should create a dependency between two tickets", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");

      const dep = store.createDependency(ticketA, ticketB, "artifact-ready");

      assert.match(dep.id, UUID_REGEX, "ID should be a valid UUID");
      assert.strictEqual(dep.ticketId, ticketA);
      assert.strictEqual(dep.dependsOn, ticketB);
      assert.strictEqual(dep.tier, "artifact-ready");
      assert.ok(dep.createdAt, "createdAt should be set");
    });

    it("should store the dependency in the database", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");

      const dep = store.createDependency(ticketA, ticketB, "code-ready");

      const row = db
        .prepare("SELECT * FROM ticket_dependencies WHERE id = ?")
        .get(dep.id) as { id: string; ticket_id: string; depends_on: string; tier: string; created_at: string };

      assert.ok(row, "Row should exist in database");
      assert.strictEqual(row.ticket_id, ticketA);
      assert.strictEqual(row.depends_on, ticketB);
      assert.strictEqual(row.tier, "code-ready");
    });

    it("should allow multiple dependencies for the same ticket", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");
      const ticketC = createTicket("Ticket C");

      const dep1 = store.createDependency(ticketA, ticketB, "artifact-ready");
      const dep2 = store.createDependency(ticketA, ticketC, "code-ready");

      assert.notStrictEqual(dep1.id, dep2.id);
      assert.strictEqual(dep1.ticketId, ticketA);
      assert.strictEqual(dep2.ticketId, ticketA);
    });
  });

  describe("createDependency - self-reference rejected", () => {
    it("should reject a ticket depending on itself", () => {
      const ticketA = createTicket("Ticket A");

      assert.throws(
        () => store.createDependency(ticketA, ticketA, "artifact-ready"),
        (err: Error) =>
          err.message.includes("cycle") ||
          err.message.includes("circular") ||
          err.message.includes("CHECK"),
        "Self-reference should be rejected"
      );
    });
  });

  describe("createDependency - cycle detection", () => {
    it("should reject A -> B -> A cycle", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");

      // A depends on B
      store.createDependency(ticketA, ticketB, "artifact-ready");

      // B depends on A should fail (cycle)
      assert.throws(
        () => store.createDependency(ticketB, ticketA, "artifact-ready"),
        (err: Error) => err.message.includes("cycle") || err.message.includes("circular"),
        "Should reject cycle A -> B -> A"
      );
    });

    it("should reject 3-node cycle A -> B -> C -> A", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");
      const ticketC = createTicket("Ticket C");

      // A depends on B
      store.createDependency(ticketA, ticketB, "artifact-ready");
      // B depends on C
      store.createDependency(ticketB, ticketC, "artifact-ready");

      // C depends on A should fail (cycle)
      assert.throws(
        () => store.createDependency(ticketC, ticketA, "artifact-ready"),
        (err: Error) => err.message.includes("cycle") || err.message.includes("circular"),
        "Should reject 3-node cycle"
      );
    });
  });

  describe("createDependency - different workflow rejected", () => {
    it("should reject dependency between tickets in different workflows", () => {
      // Create a second workflow
      const workflowStore = createProjectWorkflowStore(db);
      const otherWorkflow = workflowStore.createWorkflow({
        projectId,
        name: "Other Board",
        templateName: "product-development",
        isDefault: false,
      });

      const ticketA = createTicket("Ticket A"); // in workflowId

      // Create ticket in other workflow
      const ticketStore = createTicketStore(db);
      const ticketB = ticketStore.createTicket(projectId, {
        title: "Ticket B",
        workflowId: otherWorkflow.id,
      });

      assert.throws(
        () => store.createDependency(ticketA, ticketB.id, "artifact-ready"),
        (err: Error) => err.message.includes("same workflow"),
        "Should reject dependency across different workflows"
      );
    });
  });

  describe("createDependency - null workflow rejected", () => {
    it("should reject dependency when ticket has no workflow_id", () => {
      // Insert a ticket directly with null workflow_id
      const ticketId = "NULL-WF-1";
      db.prepare(
        `INSERT INTO tickets (id, project_id, title, description, phase, created_at, updated_at, archived)
         VALUES (?, ?, ?, '', 'Ideas', ?, ?, 0)`
      ).run(ticketId, projectId, "No Workflow Ticket", new Date().toISOString(), new Date().toISOString());

      const ticketB = createTicket("Normal Ticket");

      assert.throws(
        () => store.createDependency(ticketId, ticketB, "artifact-ready"),
        (err: Error) => err.message.includes("no workflow_id"),
        "Should reject ticket with null workflow_id"
      );
    });

    it("should reject dependency when dependsOn ticket has no workflow_id", () => {
      const ticketA = createTicket("Normal Ticket");

      const ticketId = "NULL-WF-2";
      db.prepare(
        `INSERT INTO tickets (id, project_id, title, description, phase, created_at, updated_at, archived)
         VALUES (?, ?, ?, '', 'Ideas', ?, ?, 0)`
      ).run(ticketId, projectId, "No Workflow Ticket", new Date().toISOString(), new Date().toISOString());

      assert.throws(
        () => store.createDependency(ticketA, ticketId, "artifact-ready"),
        (err: Error) => err.message.includes("no workflow_id"),
        "Should reject dependsOn ticket with null workflow_id"
      );
    });
  });

  describe("createDependency - duplicate UNIQUE rejected", () => {
    it("should reject duplicate dependency (same ticket_id + depends_on)", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");

      store.createDependency(ticketA, ticketB, "artifact-ready");

      assert.throws(
        () => store.createDependency(ticketA, ticketB, "code-ready"),
        (err: Error) => err.message.includes("UNIQUE") || err.message.includes("constraint"),
        "Should reject duplicate dependency"
      );
    });
  });

  describe("createDependency - ticket not found", () => {
    it("should reject when ticketId does not exist", () => {
      const ticketB = createTicket("Ticket B");

      assert.throws(
        () => store.createDependency("NONEXISTENT-1", ticketB, "artifact-ready"),
        (err: Error) => err.message.includes("not found"),
        "Should reject non-existent ticketId"
      );
    });

    it("should reject when dependsOn does not exist", () => {
      const ticketA = createTicket("Ticket A");

      assert.throws(
        () => store.createDependency(ticketA, "NONEXISTENT-2", "artifact-ready"),
        (err: Error) => err.message.includes("not found"),
        "Should reject non-existent dependsOn"
      );
    });
  });
});
