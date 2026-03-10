import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
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
import { getWorkflowWithFullPhases } from "../template.store.js";

describe("TicketDependencyStore (integration)", () => {
  let db: Database.Database;
  let store: TicketDependencyStore;
  let projectId: string;
  let workflowId: string;

  function createTicket(title: string): string {
    const ticketStore = createTicketStore(db);
    const ticket = ticketStore.createTicket(projectId, { title, workflowId });
    return ticket.id;
  }

  before(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    store = createTicketDependencyStore(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Integration Dep Project",
      path: "/test/dep-integration",
    });
    projectId = project.id;

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
  });

  beforeEach(() => {
    db.prepare("DELETE FROM ticket_dependencies").run();
    db.prepare("DELETE FROM tickets").run();
  });

  it("tracks dependency satisfaction across phase changes", async () => {
    const ticketA = createTicket("Ticket A");
    const ticketB = createTicket("Ticket B");

    store.createDependency(ticketA, ticketB, "code-ready");

    const template = await getWorkflowWithFullPhases("product-development");
    assert.ok(template, "Template should exist");
    const templatePhases = template!.phases as TemplatePhase[];

    const initial = store.getDependenciesWithSatisfaction(
      ticketA,
      templatePhases,
    );
    assert.strictEqual(initial.length, 1);
    assert.strictEqual(initial[0].satisfied, false);

    const ticketStore = createTicketStore(db);
    ticketStore.updateTicket(projectId, ticketB, { phase: "Done" });

    const updated = store.getDependenciesWithSatisfaction(
      ticketA,
      templatePhases,
    );
    assert.strictEqual(updated.length, 1);
    assert.strictEqual(updated[0].satisfied, true);
  });

  it("supports explicit cleanup when foreign keys are disabled", () => {
    db.pragma("foreign_keys = OFF");

    const ticketA = createTicket("Ticket A");
    const ticketB = createTicket("Ticket B");
    store.createDependency(ticketA, ticketB, "artifact-ready");

    const ticketStore = createTicketStore(db);
    ticketStore.deleteTicket(projectId, ticketB);

    const rowsAfterDelete = db
      .prepare(
        "SELECT COUNT(*) as count FROM ticket_dependencies WHERE ticket_id = ?"
      )
      .get(ticketA) as { count: number };
    assert.strictEqual(rowsAfterDelete.count, 1);

    store.deleteDependency(ticketA, ticketB);
    const rowsAfterCleanup = db
      .prepare(
        "SELECT COUNT(*) as count FROM ticket_dependencies WHERE ticket_id = ?"
      )
      .get(ticketA) as { count: number };
    assert.strictEqual(rowsAfterCleanup.count, 0);
  });

  it("cascades dependency cleanup when foreign keys are enabled", () => {
    db.pragma("foreign_keys = ON");

    const ticketA = createTicket("Ticket A");
    const ticketB = createTicket("Ticket B");
    store.createDependency(ticketA, ticketB, "artifact-ready");

    const ticketStore = createTicketStore(db);
    ticketStore.deleteTicket(projectId, ticketB);

    const rowsAfterDelete = db
      .prepare(
        "SELECT COUNT(*) as count FROM ticket_dependencies WHERE ticket_id = ?"
      )
      .get(ticketA) as { count: number };
    assert.strictEqual(rowsAfterDelete.count, 0);
  });

  it("rejects a 3-node cycle in integration flow", () => {
    const ticketA = createTicket("Ticket A");
    const ticketB = createTicket("Ticket B");
    const ticketC = createTicket("Ticket C");

    store.createDependency(ticketA, ticketB, "artifact-ready");
    store.createDependency(ticketB, ticketC, "artifact-ready");

    assert.throws(
      () => store.createDependency(ticketC, ticketA, "artifact-ready"),
      (err: Error) => err.message.includes("cycle"),
    );
  });
});
