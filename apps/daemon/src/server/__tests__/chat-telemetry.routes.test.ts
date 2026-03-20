import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";

import { runMigrations } from "../../stores/migrations.js";
import { getChatTelemetrySnapshot } from "../routes/chat-telemetry.routes.js";

describe("chat telemetry snapshot", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, slug, display_name, path, registered_at)
      VALUES ('proj-1', 'proj-1', 'Project 1', '/tmp/proj-1', '2026-03-11T00:00:00.000Z');
      INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at)
      VALUES ('wf-1', 'proj-1', 'Default', 'product-development', 1, '2026-03-11T00:00:00.000Z', '2026-03-11T00:00:00.000Z');
      INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-1', 1);
      INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id)
      VALUES ('POT-1', 'proj-1', 'Ticket 1', 'Build', '2026-03-11T00:00:00.000Z', '2026-03-11T00:00:00.000Z', 'wf-1');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("returns a zeroed snapshot now that queue telemetry is stubbed", () => {
    const snapshot = getChatTelemetrySnapshot();

    assert.equal(snapshot.queueDepth, 0);
    assert.equal(snapshot.activeQuestion, null);
    assert.equal(snapshot.deadLetterCount, 0);
    assert.deepStrictEqual(snapshot.providerEventCounts, []);
    assert.deepStrictEqual(snapshot.perTicketQueueDepth, []);
  });
});
