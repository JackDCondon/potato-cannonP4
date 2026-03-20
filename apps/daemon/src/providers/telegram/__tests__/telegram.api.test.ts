import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { TelegramApi } from "../telegram.api.js";

describe("TelegramApi", () => {
  let fetchCalls: Array<{ url: string; body?: string; method?: string }>;

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
        method: init?.method,
      });
      return {
        json: async () => ({ ok: true, result: { message_thread_id: 123, name: "Topic" } }),
      } as Response;
    }) as unknown as typeof fetch;
  });

  it("sendMessage serializes thread and inline keyboard payload", async () => {
    const api = new TelegramApi({ botToken: "token", userId: "u-1" });
    await api.sendMessage("chat-1", "Question", {
      messageThreadId: 99,
      replyMarkup: { inline_keyboard: [[{ text: "A", callback_data: "answer:q1:0" }]] },
    });

    assert.equal(fetchCalls.length, 1);
    const request = fetchCalls[0];
    const body = JSON.parse(request.body ?? "{}");
    assert.equal(body.chat_id, "chat-1");
    assert.equal(body.message_thread_id, 99);
    assert.equal(typeof body.reply_markup, "string");
  });

  it("calls setup-validation endpoints", async () => {
    const api = new TelegramApi({ botToken: "token", userId: "u-1", forumGroupId: "-100123" });
    await api.getChat("-100123");
    await api.getMe();
    await api.getChatMember("-100123", 42);
    await api.deleteForumTopic("-100123", 321);
    await api.editMessageReplyMarkup("-100123", 321, { messageThreadId: 99 });

    assert.equal(fetchCalls.length, 5);
    assert.ok(fetchCalls[0].url.includes("/getChat"));
    assert.ok(fetchCalls[1].url.includes("/getMe"));
    assert.ok(fetchCalls[2].url.includes("/getChatMember"));
    assert.ok(fetchCalls[3].url.includes("/deleteForumTopic"));
    assert.ok(fetchCalls[4].url.includes("/editMessageReplyMarkup"));
  });
});
