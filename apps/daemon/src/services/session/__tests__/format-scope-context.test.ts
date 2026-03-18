import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runMigrations } from "../../../stores/migrations.js";
import { createTicketStore } from "../../../stores/ticket.store.js";
import { createBrainstormStore } from "../../../stores/brainstorm.store.js";
import { createProjectStore } from "../../../stores/project.store.js";

describe("formatScopeContext (via store integration)", () => {
  let db: Database.Database;
  let testDbPath: string;
  let projectId: string;

  before(() => {
    testDbPath = path.join(
      os.tmpdir(),
      `potato-scope-test-${Date.now()}.db`,
    );
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Scope Test",
      path: "/test/scope",
    });
    projectId = project.id;
  });

  after(() => {
    db.close();
    try {
      fs.unlinkSync(testDbPath);
    } catch {}
    try {
      fs.unlinkSync(testDbPath + "-wal");
    } catch {}
    try {
      fs.unlinkSync(testDbPath + "-shm");
    } catch {}
  });

  it("should return undefined brainstormId for ticket created without one", () => {
    const ticketStore = createTicketStore(db);
    const ticket = ticketStore.createTicket(projectId, { title: "Solo ticket" });
    // formatScopeContext returns "" when brainstormId is absent
    assert.strictEqual(ticket.brainstormId, undefined);
  });

  it("should persist brainstormId on ticket creation", () => {
    const ticketStore = createTicketStore(db);
    const brainstormStore = createBrainstormStore(db);
    const brainstorm = brainstormStore.createBrainstorm(projectId);

    const ticket = ticketStore.createTicket(projectId, {
      title: "Linked ticket",
      brainstormId: brainstorm.id,
    });

    assert.strictEqual(ticket.brainstormId, brainstorm.id);

    const fetched = ticketStore.getTicket(projectId, ticket.id);
    assert.strictEqual(fetched?.brainstormId, brainstorm.id);
  });

  it("should retrieve sibling tickets by brainstormId", () => {
    const ticketStore = createTicketStore(db);
    const brainstormStore = createBrainstormStore(db);
    const brainstorm = brainstormStore.createBrainstorm(projectId);
    brainstormStore.updateBrainstorm(brainstorm.id, {
      planSummary: "Build auth system",
    });

    const t1 = ticketStore.createTicket(projectId, {
      title: "Auth API",
      brainstormId: brainstorm.id,
    });
    const t2 = ticketStore.createTicket(projectId, {
      title: "Auth UI",
      brainstormId: brainstorm.id,
    });

    const siblings = ticketStore.getTicketsByBrainstormId(brainstorm.id);
    assert.strictEqual(siblings.length, 2);

    const ids = siblings.map((s) => s.id);
    assert.ok(ids.includes(t1.id), "t1 should be in siblings");
    assert.ok(ids.includes(t2.id), "t2 should be in siblings");
  });

  it("should include planSummary on updated brainstorm", () => {
    const brainstormStore = createBrainstormStore(db);
    const brainstorm = brainstormStore.createBrainstorm(projectId);

    assert.strictEqual(brainstorm.planSummary, undefined);

    const updated = brainstormStore.updateBrainstorm(brainstorm.id, {
      planSummary: "Ship MVP by Q2",
    });

    assert.strictEqual(updated?.planSummary, "Ship MVP by Q2");
  });

  it("should return null planSummary for brainstorm without plan", () => {
    const brainstormStore = createBrainstormStore(db);
    const brainstorm = brainstormStore.createBrainstorm(projectId);
    // No planSummary set — getBrainstorm should reflect that
    const fetched = brainstormStore.getBrainstorm(brainstorm.id);
    assert.ok(
      fetched?.planSummary === undefined || fetched.planSummary === null,
      "planSummary should be absent when not set",
    );
  });

  it("should filter scope context for ticket without sibling tickets", () => {
    // Single ticket linked to brainstorm with planSummary — getTicketsByBrainstormId
    // returns only that ticket, so formatScopeContext would return "" after filtering self
    const ticketStore = createTicketStore(db);
    const brainstormStore = createBrainstormStore(db);
    const brainstorm = brainstormStore.createBrainstorm(projectId);
    brainstormStore.updateBrainstorm(brainstorm.id, {
      planSummary: "Only me here",
    });

    const ticket = ticketStore.createTicket(projectId, {
      title: "Lonely ticket",
      brainstormId: brainstorm.id,
    });

    const siblings = ticketStore
      .getTicketsByBrainstormId(brainstorm.id)
      .filter((t) => t.id !== ticket.id);

    assert.strictEqual(
      siblings.length,
      0,
      "no siblings when only one ticket is linked",
    );
  });
});
