import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import type { TemplatePhase } from "@potato-cannon/shared";
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

  describe("deleteDependency", () => {
    it("should delete an existing dependency and return true", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");

      store.createDependency(ticketA, ticketB, "artifact-ready");

      const deleted = store.deleteDependency(ticketA, ticketB);
      assert.strictEqual(deleted, true);

      // Verify it's gone from the database
      const row = db
        .prepare(
          "SELECT * FROM ticket_dependencies WHERE ticket_id = ? AND depends_on = ?"
        )
        .get(ticketA, ticketB);
      assert.strictEqual(row, undefined, "Row should no longer exist");
    });

    it("should return false when no matching dependency exists", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");

      const deleted = store.deleteDependency(ticketA, ticketB);
      assert.strictEqual(deleted, false);
    });

    it("should only delete the specified dependency, not others", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");
      const ticketC = createTicket("Ticket C");

      store.createDependency(ticketA, ticketB, "artifact-ready");
      store.createDependency(ticketA, ticketC, "code-ready");

      store.deleteDependency(ticketA, ticketB);

      const remaining = db
        .prepare("SELECT * FROM ticket_dependencies WHERE ticket_id = ?")
        .all(ticketA);
      assert.strictEqual(remaining.length, 1, "One dependency should remain");
    });
  });

  describe("getDependenciesForTicket", () => {
    it("should return all dependencies with ticket title and phase", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");
      const ticketC = createTicket("Ticket C");

      store.createDependency(ticketA, ticketB, "artifact-ready");
      store.createDependency(ticketA, ticketC, "code-ready");

      const deps = store.getDependenciesForTicket(ticketA);

      assert.strictEqual(deps.length, 2);

      const depB = deps.find((d) => d.ticketId === ticketB);
      const depC = deps.find((d) => d.ticketId === ticketC);

      assert.ok(depB, "Should include dependency on Ticket B");
      assert.strictEqual(depB!.title, "Ticket B");
      assert.strictEqual(depB!.tier, "artifact-ready");
      assert.ok(depB!.currentPhase, "Should have a phase");

      assert.ok(depC, "Should include dependency on Ticket C");
      assert.strictEqual(depC!.title, "Ticket C");
      assert.strictEqual(depC!.tier, "code-ready");
    });

    it("should return empty array when ticket has no dependencies", () => {
      const ticketA = createTicket("Ticket A");

      const deps = store.getDependenciesForTicket(ticketA);
      assert.strictEqual(deps.length, 0);
    });
  });

  describe("getDependentsOfTicket", () => {
    it("should return all tickets that depend on the given ticket", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");
      const ticketC = createTicket("Ticket C");

      // B and C both depend on A
      store.createDependency(ticketB, ticketA, "artifact-ready");
      store.createDependency(ticketC, ticketA, "code-ready");

      const dependents = store.getDependentsOfTicket(ticketA);

      assert.strictEqual(dependents.length, 2);

      const depB = dependents.find((d) => d.ticketId === ticketB);
      const depC = dependents.find((d) => d.ticketId === ticketC);

      assert.ok(depB, "Should include Ticket B as dependent");
      assert.strictEqual(depB!.title, "Ticket B");
      assert.strictEqual(depB!.tier, "artifact-ready");

      assert.ok(depC, "Should include Ticket C as dependent");
      assert.strictEqual(depC!.title, "Ticket C");
      assert.strictEqual(depC!.tier, "code-ready");
    });

    it("should return empty array when no tickets depend on the given ticket", () => {
      const ticketA = createTicket("Ticket A");

      const dependents = store.getDependentsOfTicket(ticketA);
      assert.strictEqual(dependents.length, 0);
    });
  });

  describe("delete then verify lists updated", () => {
    it("should remove dependency from getDependenciesForTicket after delete", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");

      store.createDependency(ticketA, ticketB, "artifact-ready");
      assert.strictEqual(store.getDependenciesForTicket(ticketA).length, 1);

      store.deleteDependency(ticketA, ticketB);
      assert.strictEqual(store.getDependenciesForTicket(ticketA).length, 0);
    });

    it("should remove dependency from getDependentsOfTicket after delete", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");

      store.createDependency(ticketA, ticketB, "artifact-ready");
      assert.strictEqual(store.getDependentsOfTicket(ticketB).length, 1);

      store.deleteDependency(ticketA, ticketB);
      assert.strictEqual(store.getDependentsOfTicket(ticketB).length, 0);
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

  // ===========================================================================
  // isSatisfied
  // ===========================================================================

  describe("isSatisfied", () => {
    // Mimics the full phases array from getWorkflowWithFullPhases for product-development:
    // Ideas, Refinement, Backlog, Architecture, Architecture Review, Specification (artifact-ready),
    // Build, Build Review, Blocked, Done (code-ready)
    const templatePhases: TemplatePhase[] = [
      { id: "Ideas", name: "Ideas" },
      { id: "Refinement", name: "Refinement" },
      { id: "Backlog", name: "Backlog" },
      { id: "Architecture", name: "Architecture" },
      { id: "Architecture Review", name: "Architecture Review" },
      { id: "Specification", name: "Specification", unblocksTier: "artifact-ready" },
      { id: "Build", name: "Build" },
      { id: "Build Review", name: "Build Review" },
      { id: "Blocked", name: "Blocked" },
      { id: "Done", name: "Done", unblocksTier: "code-ready" },
    ];

    it("should return true when ticket at Specification satisfies artifact-ready", () => {
      const result = store.isSatisfied("Specification", "artifact-ready", templatePhases);
      assert.strictEqual(result, true);
    });

    it("should return true when ticket past the required phase (Build satisfies artifact-ready)", () => {
      const result = store.isSatisfied("Build", "artifact-ready", templatePhases);
      assert.strictEqual(result, true);
    });

    it("should return false when ticket before the required phase (Architecture does not satisfy artifact-ready)", () => {
      const result = store.isSatisfied("Architecture", "artifact-ready", templatePhases);
      assert.strictEqual(result, false);
    });

    it("should return false when ticket at Build does NOT satisfy code-ready", () => {
      const result = store.isSatisfied("Build", "code-ready", templatePhases);
      assert.strictEqual(result, false);
    });

    it("should return true when ticket at Done satisfies code-ready", () => {
      const result = store.isSatisfied("Done", "code-ready", templatePhases);
      assert.strictEqual(result, true);
    });

    it("should return true (permissive fallback) when no phase has artifact-ready marker", () => {
      const phasesNoMarker: TemplatePhase[] = [
        { id: "Ideas", name: "Ideas" },
        { id: "Build", name: "Build" },
        { id: "Done", name: "Done", unblocksTier: "code-ready" },
      ];

      const result = store.isSatisfied("Ideas", "artifact-ready", phasesNoMarker);
      assert.strictEqual(result, true, "Should default to satisfied when no artifact-ready marker");
    });

    it("should return false when depTicketPhase is not found in template phases", () => {
      const result = store.isSatisfied("NonexistentPhase", "artifact-ready", templatePhases);
      assert.strictEqual(result, false);
    });

    it("should return false for code-ready when no phase has code-ready marker", () => {
      const phasesNoCodeReady: TemplatePhase[] = [
        { id: "Ideas", name: "Ideas" },
        { id: "Build", name: "Build" },
        { id: "Done", name: "Done" },
      ];

      const result = store.isSatisfied("Done", "code-ready", phasesNoCodeReady);
      assert.strictEqual(result, false);
    });
  });

  // ===========================================================================
  // getDependenciesWithSatisfaction
  // ===========================================================================

  describe("getDependenciesWithSatisfaction", () => {
    const templatePhases: TemplatePhase[] = [
      { id: "Ideas", name: "Ideas" },
      { id: "Refinement", name: "Refinement" },
      { id: "Specification", name: "Specification", unblocksTier: "artifact-ready" },
      { id: "Build", name: "Build" },
      { id: "Done", name: "Done", unblocksTier: "code-ready" },
    ];

    it("should return dependencies with correct satisfaction status", () => {
      const ticketA = createTicket("Ticket A");
      const ticketB = createTicket("Ticket B");
      const ticketC = createTicket("Ticket C");

      // A depends on B (artifact-ready) and C (code-ready)
      store.createDependency(ticketA, ticketB, "artifact-ready");
      store.createDependency(ticketA, ticketC, "code-ready");

      // Move B to Specification (satisfies artifact-ready), C stays at Ideas (does not satisfy code-ready)
      const ticketStore = createTicketStore(db);
      ticketStore.updateTicket(projectId, ticketB, { phase: "Specification" });

      const deps = store.getDependenciesWithSatisfaction(ticketA, templatePhases);

      assert.strictEqual(deps.length, 2);

      const depB = deps.find((d) => d.ticketId === ticketB);
      const depC = deps.find((d) => d.ticketId === ticketC);

      assert.ok(depB);
      assert.strictEqual(depB!.satisfied, true, "Ticket B at Specification should satisfy artifact-ready");

      assert.ok(depC);
      assert.strictEqual(depC!.satisfied, false, "Ticket C at Ideas should not satisfy code-ready");
    });

    it("should return empty array when ticket has no dependencies", () => {
      const ticketA = createTicket("Ticket A");

      const deps = store.getDependenciesWithSatisfaction(ticketA, templatePhases);
      assert.strictEqual(deps.length, 0);
    });
  });
});
