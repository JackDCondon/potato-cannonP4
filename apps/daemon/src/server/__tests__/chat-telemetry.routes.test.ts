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

  it("returns queue depth, active question, provider event counts, and dead-letter count", () => {
    db.exec(`
      INSERT INTO chat_queue_items
        (id, project_id, ticket_id, kind, question_id, provider_scope, payload_json, status, available_at, created_at)
      VALUES
        ('q-active', 'proj-1', 'POT-1', 'question', 'q-1', 'all_active', '{}', 'awaiting_reply', '2026-03-11T00:00:00.000Z', '2026-03-11T00:00:00.000Z'),
        ('q-queued', 'proj-1', 'POT-1', 'question', 'q-2', 'all_active', '{}', 'queued', '2026-03-11T00:00:00.000Z', '2026-03-11T00:00:01.000Z'),
        ('q-dead', 'proj-1', 'POT-1', 'notification', NULL, 'all_active', '{}', 'dead_letter', '2026-03-11T00:00:00.000Z', '2026-03-11T00:00:02.000Z');

      INSERT INTO chat_delivery_events
        (id, queue_item_id, project_id, ticket_id, provider_id, event_type, attempt, created_at)
      VALUES
        ('e1', 'q-active', 'proj-1', 'POT-1', 'telegram', 'sent', 1, '2026-03-11T00:00:01.000Z'),
        ('e2', 'q-active', 'proj-1', 'POT-1', 'slack', 'sent', 1, '2026-03-11T00:00:01.000Z'),
        ('e3', 'q-queued', 'proj-1', 'POT-1', 'telegram', 'failed', 1, '2026-03-11T00:00:02.000Z');
    `);

    const snapshot = getChatTelemetrySnapshot(
      db,
      new Date("2026-03-11T00:00:05.000Z"),
    );

    assert.equal(snapshot.queueDepth, 2);
    assert.ok(snapshot.activeQuestion);
    assert.equal(snapshot.activeQuestion?.questionId, "q-1");
    assert.equal(snapshot.activeQuestion?.ticketId, "POT-1");
    assert.equal(snapshot.activeQuestion?.ageSeconds, 5);
    assert.equal(snapshot.deadLetterCount, 1);

    assert.deepStrictEqual(snapshot.providerEventCounts, [
      { providerId: "slack", eventType: "sent", count: 1 },
      { providerId: "telegram", eventType: "failed", count: 1 },
      { providerId: "telegram", eventType: "sent", count: 1 },
    ]);

    assert.deepStrictEqual(snapshot.perTicketQueueDepth, [
      { projectId: "proj-1", ticketId: "POT-1", count: 2 },
    ]);
  });
});
