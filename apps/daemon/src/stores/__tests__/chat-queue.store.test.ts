import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import { createProjectStore } from "../project.store.js";
import { createTicketStore, TicketStore } from "../ticket.store.js";
import { ChatQueueStore, createChatQueueStore } from "../chat-queue.store.js";

describe("ChatQueueStore", () => {
  let db: Database.Database;
  let queueStore: ChatQueueStore;
  let ticketStore: TicketStore;
  let testDbPath: string;
  let projectId: string;
  let ticketId: string;

  before(() => {
    testDbPath = path.join(os.tmpdir(), `potato-chat-queue-test-${Date.now()}.db`);
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Queue Project",
      path: "/tmp/queue-project",
    });
    projectId = project.id;

    ticketStore = createTicketStore(db);
    queueStore = createChatQueueStore(db);
  });

  after(() => {
    db.close();
    try {
      fs.unlinkSync(testDbPath);
      fs.unlinkSync(testDbPath + "-wal");
      fs.unlinkSync(testDbPath + "-shm");
    } catch {
      // no-op
    }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM chat_delivery_events").run();
    db.prepare("DELETE FROM chat_queue_items").run();
    db.prepare("DELETE FROM ticket_history").run();
    db.prepare("DELETE FROM tickets").run();
    db.prepare("DELETE FROM conversations").run();
    db.prepare("DELETE FROM ticket_counters").run();

    const ticket = ticketStore.createTicket(projectId, { title: "Queue Ticket" });
    ticketId = ticket.id;
  });

  it("enqueues question and notification rows", () => {
    const question = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-1",
      payload: { text: "What should we do?" },
    });
    const notification = queueStore.enqueueNotification({
      projectId,
      ticketId,
      payload: { text: "Done" },
    });

    assert.equal(question.kind, "question");
    assert.equal(question.status, "queued");
    assert.equal(question.questionId, "q-1");
    assert.equal(notification.kind, "notification");
    assert.equal(notification.status, "queued");
  });

  it("returns ready queue items in available_at order", () => {
    const now = new Date();
    const old = new Date(now.getTime() - 5_000).toISOString();
    const current = now.toISOString();
    const future = new Date(now.getTime() + 60_000).toISOString();

    const first = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-old",
      payload: { text: "old" },
      availableAt: old,
    });
    queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-future",
      payload: { text: "future" },
      availableAt: future,
    });
    const second = queueStore.enqueueNotification({
      projectId,
      ticketId,
      payload: { text: "current" },
      availableAt: current,
    });

    const ready = queueStore.listReadyQueueItems(10, current);
    assert.equal(ready.length, 2);
    assert.equal(ready[0].id, first.id);
    assert.equal(ready[1].id, second.id);
  });

  it("allows only one awaiting_reply question globally", () => {
    const first = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-1",
      payload: { text: "first" },
    });
    const second = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-2",
      payload: { text: "second" },
    });

    queueStore.markDispatching(first.id);
    queueStore.markAwaitingReply(first.id);

    assert.throws(
      () => {
        queueStore.markAwaitingReply(second.id);
      },
      /UNIQUE constraint failed/
    );
  });

  it("transitions active question to answered and records resolver", () => {
    const question = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-1",
      payload: { text: "answer me" },
    });

    queueStore.markDispatching(question.id);
    queueStore.markAwaitingReply(question.id);
    const active = queueStore.getActiveQuestion();
    assert.ok(active);
    assert.equal(active?.id, question.id);

    const answered = queueStore.markAnswered(question.id, "web");
    assert.equal(answered?.status, "answered");
    assert.equal(answered?.resolvedBy, "web");
    assert.ok(answered?.resolvedAt);
    assert.equal(queueStore.getActiveQuestion(), null);
  });

  it("cancels queued items by questionId before dispatch", () => {
    const queued = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-cancel",
      payload: { text: "cancel this one" },
    });

    const changed = queueStore.cancelQueuedItemsForQuestionId("q-cancel", "system");
    assert.equal(changed, 1);

    const updated = queueStore.getQueueItem(queued.id);
    assert.equal(updated?.status, "cancelled");
    assert.equal(updated?.resolvedBy, "system");
    assert.ok(updated?.resolvedAt);
  });

  it("records delivery telemetry events", () => {
    const queued = queueStore.enqueueNotification({
      projectId,
      ticketId,
      payload: { text: "hello" },
    });

    const event = queueStore.recordDeliveryEvent({
      queueItemId: queued.id,
      projectId,
      ticketId,
      providerId: "telegram",
      eventType: "sent",
      attempt: 1,
    });

    assert.equal(event.queueItemId, queued.id);
    assert.equal(event.providerId, "telegram");
    assert.equal(event.eventType, "sent");
  });

  it("cancels all open queue items for a terminal ticket lifecycle", () => {
    const queued = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-open-1",
      payload: { text: "queued item" },
    });
    const awaiting = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-open-2",
      payload: { text: "awaiting item" },
    });
    queueStore.markAwaitingReply(awaiting.id);

    const closedCount = queueStore.cancelOpenItemsForTicket(projectId, ticketId, "system");
    assert.equal(closedCount, 2);

    const queuedAfter = queueStore.getQueueItem(queued.id);
    const awaitingAfter = queueStore.getQueueItem(awaiting.id);
    assert.equal(queuedAfter?.status, "cancelled");
    assert.equal(awaitingAfter?.status, "cancelled");
  });

  it("lists only open queue items and supports ticket filtering", () => {
    const q1 = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-open",
      payload: { text: "open question" },
    });
    queueStore.enqueueNotification({
      projectId,
      ticketId,
      payload: { text: "open notification" },
    });
    const answered = queueStore.enqueueQuestion({
      projectId,
      ticketId,
      questionId: "q-answered",
      payload: { text: "answered question" },
    });
    queueStore.markAnswered(answered.id, "system");

    const ticket2 = ticketStore.createTicket(projectId, { title: "Queue Ticket 2" });
    queueStore.enqueueQuestion({
      projectId,
      ticketId: ticket2.id,
      questionId: "q-other",
      payload: { text: "other question" },
    });

    const openForTicket = queueStore.listOpenQueueItems({ projectId, ticketId });
    assert.equal(openForTicket.length, 2);
    assert.ok(openForTicket.every((item) => item.ticketId === ticketId));

    const allOpen = queueStore.listOpenQueueItems({ projectId });
    assert.equal(allOpen.length, 3);
    assert.ok(allOpen.some((item) => item.id === q1.id));
    assert.ok(allOpen.every((item) => item.status !== "answered"));
  });
});
