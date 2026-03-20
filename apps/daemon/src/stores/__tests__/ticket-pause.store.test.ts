import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createTicketStore } from "../ticket.store.js";
import { runMigrations } from "../migrations.js";

describe("ticket store - pause fields", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createTicketStore>;
  let projectId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    store = createTicketStore(db);

    // Create a project and workflow for FK constraints
    projectId = "test-project";
    db.prepare(
      `INSERT INTO projects (id, slug, display_name, path, registered_at, template_name)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(projectId, "test", "Test", "/tmp/test", new Date().toISOString(), "product-development");

    const workflowId = "test-workflow";
    db.prepare(
      `INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).run(workflowId, projectId, "Default", "product-development", new Date().toISOString(), new Date().toISOString());
  });

  after(() => {
    db?.close();
  });

  it("should round-trip paused fields through updateTicket and getTicket", () => {
    const ticket = store.createTicket(projectId, { title: "Test ticket" });

    const updated = store.updateTicket(projectId, ticket.id, {
      paused: true,
      pauseReason: "Credits exhausted. Resets at 2026-03-20T10:00:00Z.",
      pauseRetryAt: "2026-03-20T10:05:00.000Z",
      pauseRetryCount: 1,
    });

    assert.ok(updated);
    assert.equal(updated.paused, true);
    assert.equal(updated.pauseReason, "Credits exhausted. Resets at 2026-03-20T10:00:00Z.");
    assert.equal(updated.pauseRetryAt, "2026-03-20T10:05:00.000Z");
    assert.equal(updated.pauseRetryCount, 1);

    // Verify via fresh getTicket
    const fetched = store.getTicket(projectId, ticket.id);
    assert.ok(fetched);
    assert.equal(fetched.paused, true);
    assert.equal(fetched.pauseReason, "Credits exhausted. Resets at 2026-03-20T10:00:00Z.");
    assert.equal(fetched.pauseRetryAt, "2026-03-20T10:05:00.000Z");
    assert.equal(fetched.pauseRetryCount, 1);
  });

  it("should clear paused fields on resume", () => {
    const ticket = store.createTicket(projectId, { title: "Test ticket" });

    // Pause it
    store.updateTicket(projectId, ticket.id, {
      paused: true,
      pauseReason: "Credits exhausted",
      pauseRetryAt: "2026-03-20T10:05:00.000Z",
      pauseRetryCount: 1,
    });

    // Resume it (clear reason and retryAt, keep count)
    const resumed = store.updateTicket(projectId, ticket.id, {
      paused: false,
      pauseReason: null,
      pauseRetryAt: null,
    });

    assert.ok(resumed);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.pauseReason, undefined);
    assert.equal(resumed.pauseRetryAt, undefined);
    assert.equal(resumed.pauseRetryCount, 1);
  });

  it("should default paused to false for new tickets", () => {
    const ticket = store.createTicket(projectId, { title: "Test ticket" });
    assert.equal(ticket.paused, false);
    assert.equal(ticket.pauseRetryCount, 0);
  });
});
