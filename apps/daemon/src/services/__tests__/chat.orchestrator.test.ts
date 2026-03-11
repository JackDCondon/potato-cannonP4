import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import { runMigrations } from "../../stores/migrations.js";
import { createProjectStore } from "../../stores/project.store.js";
import { createTicketStore, type TicketStore } from "../../stores/ticket.store.js";
import { createChatQueueStore, type ChatQueueStore } from "../../stores/chat-queue.store.js";
import { ChatOrchestrator } from "../chat/chat-orchestrator.js";
import type { ChatProvider } from "../../providers/chat-provider.types.js";

describe("ChatOrchestrator", () => {
  let db: Database.Database;
  let queueStore: ChatQueueStore;
  let ticketStore: TicketStore;
  let testDbPath: string;
  let projectId: string;
  let ticketId: string;
  let sendCalls: Array<{ providerId: string; text: string }>;

  const providers: ChatProvider[] = [
    {
      id: "telegram",
      name: "Telegram",
      capabilities: { threads: true, buttons: true, formatting: "markdown" },
      initialize: async () => {},
      shutdown: async () => {},
      createThread: async () => ({ providerId: "telegram", threadId: "t" }),
      getThread: async () => null,
      send: async () => {},
      notifyAnswered: async () => {},
    },
    {
      id: "slack",
      name: "Slack",
      capabilities: { threads: true, buttons: false, formatting: "markdown" },
      initialize: async () => {},
      shutdown: async () => {},
      createThread: async () => ({ providerId: "slack", threadId: "s" }),
      getThread: async () => null,
      send: async () => {},
      notifyAnswered: async () => {},
    },
  ];

  before(() => {
    testDbPath = path.join(os.tmpdir(), `potato-orchestrator-test-${Date.now()}.db`);
    db = new Database(testDbPath);
    runMigrations(db);
    queueStore = createChatQueueStore(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Orchestrator Project",
      path: "/tmp/orch-project",
    });
    projectId = project.id;
    ticketStore = createTicketStore(db);
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

    const ticket = ticketStore.createTicket(projectId, { title: "Orchestrator Ticket" });
    ticketId = ticket.id;
    sendCalls = [];
  });

  it("dispatches first question and keeps second question queued until resolved", async () => {
    const orchestrator = new ChatOrchestrator(
      queueStore,
      () => providers,
      async (provider, _context, message) => {
        sendCalls.push({ providerId: provider.id, text: message.text });
      }
    );

    await orchestrator.enqueueQuestion(
      { projectId, ticketId },
      "q-1",
      { text: "First question" }
    );

    await orchestrator.enqueueQuestion(
      { projectId, ticketId },
      "q-2",
      { text: "Second question" }
    );

    const first = queueStore.getQueueItemByQuestionId("q-1");
    const second = queueStore.getQueueItemByQuestionId("q-2");
    assert.equal(first?.status, "awaiting_reply");
    assert.equal(second?.status, "queued");

    await orchestrator.resolveQuestion("q-1", "done", "web");
    const secondAfter = queueStore.getQueueItemByQuestionId("q-2");
    assert.equal(secondAfter?.status, "awaiting_reply");
  });

  it("dispatches notifications without occupying the active-question lock", async () => {
    const orchestrator = new ChatOrchestrator(
      queueStore,
      () => providers,
      async (provider, _context, message) => {
        sendCalls.push({ providerId: provider.id, text: message.text });
      }
    );

    await orchestrator.enqueueNotification(
      { projectId, ticketId },
      { text: "Build completed", kind: "notification" }
    );

    const ready = queueStore.listReadyQueueItems(10);
    assert.equal(ready.length, 0);
    assert.equal(queueStore.getActiveQuestion(), null);
  });

  it("dispatches notification even when a queued question is blocked by active question lock", async () => {
    const orchestrator = new ChatOrchestrator(
      queueStore,
      () => providers,
      async (provider, _context, message) => {
        sendCalls.push({ providerId: provider.id, text: message.text });
      }
    );

    await orchestrator.enqueueQuestion(
      { projectId, ticketId },
      "q-active",
      { text: "Active question" }
    );
    await orchestrator.enqueueQuestion(
      { projectId, ticketId },
      "q-blocked",
      { text: "Blocked question" }
    );
    await orchestrator.enqueueNotification(
      { projectId, ticketId },
      { text: "Important notification", kind: "notification" }
    );

    const blocked = queueStore.getQueueItemByQuestionId("q-blocked");
    assert.equal(blocked?.status, "queued");

    const notification = db
      .prepare(
        "SELECT status FROM chat_queue_items WHERE kind = 'notification' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { status: string } | undefined;
    assert.equal(notification?.status, "answered");

    const notificationDeliveries = sendCalls.filter(
      (call) => call.text === "Important notification"
    );
    assert.equal(notificationDeliveries.length, 2);
  });

  it("fans out one logical question to both providers while keeping one active queue item", async () => {
    const orchestrator = new ChatOrchestrator(
      queueStore,
      () => providers,
      async (provider, _context, message) => {
        sendCalls.push({ providerId: provider.id, text: message.text });
      }
    );

    await orchestrator.enqueueQuestion(
      { projectId, ticketId },
      "q-fanout",
      { text: "Choose one", options: ["A", "B"] }
    );

    assert.equal(sendCalls.length, 2);
    assert.deepStrictEqual(
      sendCalls.map((call) => call.providerId).sort(),
      ["slack", "telegram"]
    );
    const active = queueStore.getActiveQuestion();
    assert.ok(active);
    assert.equal(active?.questionId, "q-fanout");
  });

  it("resolves queued question from web before it is dispatched", async () => {
    const orchestrator = new ChatOrchestrator(
      queueStore,
      () => providers,
      async () => {}
    );

    await orchestrator.enqueueQuestion(
      { projectId, ticketId },
      "q-active",
      { text: "Active question" }
    );
    await orchestrator.enqueueQuestion(
      { projectId, ticketId },
      "q-queued",
      { text: "Queued question" }
    );

    const pre = queueStore.getQueueItemByQuestionId("q-queued");
    assert.equal(pre?.status, "queued");

    const resolved = await orchestrator.resolveQuestion("q-queued", "web answer", "web");
    assert.equal(resolved.accepted, true);

    const post = queueStore.getQueueItemByQuestionId("q-queued");
    assert.equal(post?.status, "answered");
    assert.equal(post?.resolvedBy, "web");
  });
});
