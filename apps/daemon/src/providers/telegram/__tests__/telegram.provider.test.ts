import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { TelegramProvider } from "../telegram.provider.js";
import type { ChatContext } from "../../chat-provider.types.js";

function createMockApi() {
  return {
    createForumTopic: mock.fn(async () => ({ message_thread_id: 555, name: "Topic" })),
    sendMessage: mock.fn(async () => ({ ok: true })),
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
});
