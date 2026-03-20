import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { TelegramProvider } from "../telegram.provider.js";
import { getContextKey, parseContextKey } from "../../chat-provider.types.js";
import type { ChatContext } from "../../chat-provider.types.js";
import { runMigrations } from "../../../stores/migrations.js";
import { createProviderChannelStore } from "../../../stores/provider-channel.store.js";

function createMockApi() {
  return {
    createForumTopic: mock.fn(async () => ({ message_thread_id: 555, name: "Topic" })),
    sendMessage: mock.fn(async () => ({ ok: true, message_id: 777 })),
    editMessageReplyMarkup: mock.fn(async () => ({ ok: true })),
    getChat: mock.fn(async () => ({ id: 1, type: "supergroup", is_forum: true })),
    getMe: mock.fn(async () => ({ id: 42, username: "potatobot" })),
    getChatMember: mock.fn(async () => ({ status: "administrator" })),
    deleteForumTopic: mock.fn(async () => true),
  };
}

describe("TelegramProvider", () => {
  let provider: TelegramProvider;
  let api: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    provider = new TelegramProvider();
    api = createMockApi();
    provider._setConfigForTest({
      botToken: "token",
      userId: "user-1",
      forumGroupId: "-100123",
    });
    provider._injectApiForTest(api as any);
  });

  it("creates topic route and stores thread metadata", async () => {
    const context: ChatContext = { projectId: "proj1", ticketId: "POT-1" };
    const thread = await provider.createThread(context, "Ticket 1");

    assert.equal(thread.providerId, "telegram");
    assert.equal((thread.metadata as any).chatId, "-100123");
    assert.equal((thread.metadata as any).messageThreadId, 555);
    assert.equal(api.createForumTopic.mock.calls.length, 1);
  });

  it("encodes callback payload with questionId identity", async () => {
    await provider.send(
      {
        providerId: "telegram",
        threadId: "-100123",
        metadata: { chatId: "-100123", messageThreadId: 555 },
      },
      {
        text: "Choose",
        questionId: "q-abc",
        options: ["Yes", "No"],
      },
    );

    const sendArgs = api.sendMessage.mock.calls[0]?.arguments as unknown as [string, string, { replyMarkup: unknown }];
    const replyMarkup = sendArgs[2].replyMarkup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    assert.equal(replyMarkup.inline_keyboard[0][0].callback_data, "answer:q-abc:0");
  });

  it("routes callback update to response callback", async () => {
    const context: ChatContext = { projectId: "proj1", ticketId: "POT-1" };
    await provider.createThread(context, "Ticket 1");

    let responsePayload = "";
    provider.setResponseCallback(async (_providerId, _context, answer) => {
      responsePayload = answer;
      return true;
    });

    await provider._handleUpdateForTest({
      callback_query: {
        message: {
          chat: { id: -100123 },
          message_thread_id: 555,
        },
        data: "answer:q-abc:1",
      },
    });

    assert.equal(responsePayload, "answer:q-abc:1");
  });

  it("stores the sent question message id on thread metadata", async () => {
    const context: ChatContext = { projectId: "proj1", ticketId: "POT-1" };
    const thread = await provider.createThread(context, "Ticket 1");

    await provider.send(thread, {
      text: "Choose",
      questionId: "q-abc",
      options: ["Yes", "No"],
    });

    assert.equal((thread.metadata as any).lastQuestionMessageId, 777);
  });

  it("clears inline buttons when notifying about a web answer", async () => {
    const context: ChatContext = { projectId: "proj1", ticketId: "POT-1" };
    const thread = await provider.createThread(context, "Ticket 1");
    (thread.metadata as any).lastQuestionMessageId = 777;

    await provider.notifyAnswered(thread, "Yes");

    assert.equal(api.editMessageReplyMarkup.mock.calls.length, 1);
    const editArgs = api.editMessageReplyMarkup.mock.calls[0]
      ?.arguments as unknown as [string, number, { messageThreadId?: number }];
    assert.equal(editArgs[0], "-100123");
    assert.equal(editArgs[1], 777);
    assert.equal(editArgs[2].messageThreadId, 555);
  });

  it("ignores legacy DM route when forum mode is enabled", async () => {
    const context: ChatContext = { projectId: "proj1", ticketId: "POT-1" };
    (provider as any).threadCache.set("proj1:POT-1", {
      providerId: "telegram",
      threadId: "8390479307",
      metadata: { chatId: "8390479307" },
    });

    const thread = await provider.getThread(context);
    assert.equal(thread, null);
  });

  it("loadThreadCache reads from provider_channels table, not filesystem", async () => {
    const db = new Database(":memory:");
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, slug, display_name, path, registered_at)
      VALUES ('proj-1', 'proj-1', 'Project 1', '/tmp/proj-1', '2026-03-11T00:00:00.000Z');

      INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at)
      VALUES ('wf-1', 'proj-1', 'Default', 'product-development', 1, '2026-03-11T00:00:00.000Z', '2026-03-11T00:00:00.000Z');

      INSERT INTO ticket_counters (project_id, next_number)
      VALUES ('proj-1', 1);

      INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id)
      VALUES ('ticket-1', 'proj-1', 'Test Ticket', 'Build', '2026-03-11T00:00:00.000Z', '2026-03-11T00:00:00.000Z', 'wf-1');
    `);

    const store = createProviderChannelStore(db);
    store.createChannel({
      ticketId: "ticket-1",
      providerId: "telegram",
      channelId: "-1001",
      metadata: { chatId: "-1001", messageThreadId: 5 },
    });

    const dbBackedProvider = new TelegramProvider(db);
    dbBackedProvider._setConfigForTest({
      botToken: "x",
      forumGroupId: "-1001",
      userId: "123",
    });

    await dbBackedProvider.loadThreadCache();

    store.deleteChannelsForTicket("ticket-1");

    const thread = await dbBackedProvider.getThread({
      projectId: "proj-1",
      ticketId: "ticket-1",
    });

    assert.notEqual(thread, null);
    assert.equal((thread!.metadata as any).messageThreadId, 5);

    db.close();
  });

  it("findContextByThread uses O(1) reverse lookup", async () => {
    const context: ChatContext = { projectId: "proj", ticketId: "TICK-2" };
    const thread = await provider.createThread(context, "My Ticket");

    const resolved = await provider._findContextByThreadForTest("-100123", 555);

    assert.deepEqual(resolved, context);
    assert.equal((thread.metadata as any).messageThreadId, 555);
  });

  it("deleteThread removes entry from thread cache", async () => {
    const context: ChatContext = { projectId: "proj", ticketId: "TICK-3" };
    const thread = await provider.createThread(context, "Test");

    await provider.deleteThread(thread);

    const found = await provider.getThread(context);
    assert.equal(found, null);
  });
});

describe("context key utilities", () => {
  it("round-trips ticketId contexts", () => {
    const ctx = { projectId: "proj", ticketId: "TICK-1" };
    assert.deepEqual(parseContextKey(getContextKey(ctx)), {
      projectId: "proj",
      ticketId: "TICK-1",
    });
  });

  it("round-trips brainstormId contexts", () => {
    const ctx = { projectId: "proj", brainstormId: "brain_abc" };
    assert.deepEqual(parseContextKey(getContextKey(ctx)), {
      projectId: "proj",
      brainstormId: "brain_abc",
    });
  });

  it("handles project IDs that contain colons without breaking parseContextKey", () => {
    const ctx = { projectId: "org:repo", ticketId: "TICK-1" };
    assert.deepEqual(parseContextKey(getContextKey(ctx)), {
      projectId: "org:repo",
      ticketId: "TICK-1",
    });
  });
});
