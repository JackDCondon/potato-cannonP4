import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

import { SlackProvider } from "../slack.provider.js";
import type { ChatContext, OutboundMessage } from "../../chat-provider.types.js";

// We test the provider by calling its public methods directly.
// SlackApi and SlackSocket are injected as constructor dependencies.

function createMockApi() {
  return {
    openConversation: mock.fn(async (_userId: string) => "D_MOCK_CHANNEL"),
    postMessage: mock.fn(
      async (_channel: string, _text: string, _opts?: { thread_ts?: string }) =>
        "1234567890.123456",
    ),
  };
}

function createMockSocket() {
  return {
    connect: mock.fn(async () => {}),
    disconnect: mock.fn(async () => {}),
  };
}

// Mock scanAllChatThreads at module level — returns empty map by default
const mockScanAllChatThreads = mock.fn(async () => new Map());

describe("SlackProvider", () => {
  let provider: SlackProvider;
  let mockApi: ReturnType<typeof createMockApi>;
  let mockSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    mockApi = createMockApi();
    mockSocket = createMockSocket();
    provider = new SlackProvider();
    // Inject mocks via the test helper method
    provider._injectForTest(mockApi as any, mockSocket as any, mockScanAllChatThreads as any);
  });

  describe("capabilities", () => {
    it("should have correct id and name", () => {
      assert.strictEqual(provider.id, "slack");
      assert.strictEqual(provider.name, "Slack");
    });

    it("should declare threads=true, buttons=false, formatting=markdown", () => {
      assert.deepStrictEqual(provider.capabilities, {
        threads: true,
        buttons: false,
        formatting: "markdown",
      });
    });
  });

  describe("createThread", () => {
    it("should throw when knownUserId is null", async () => {
      const context: ChatContext = { projectId: "proj1", ticketId: "T-1" };

      await assert.rejects(
        () => provider.createThread(context, "Test ticket"),
        (err: Error) => {
          assert.match(err.message, /Slack user ID unknown/);
          return true;
        },
      );
    });

    it("should create thread when knownUserId is set", async () => {
      // Simulate user discovery
      provider._setKnownUserIdForTest("U_TEST_USER");

      const context: ChatContext = { projectId: "proj1", ticketId: "T-1" };
      const thread = await provider.createThread(context, "Test ticket");

      assert.strictEqual(thread.providerId, "slack");
      assert.strictEqual(thread.threadId, "D_MOCK_CHANNEL");
      assert.strictEqual((thread.metadata as any).channel, "D_MOCK_CHANNEL");
      assert.strictEqual((thread.metadata as any).thread_ts, "1234567890.123456");
      assert.strictEqual((thread.metadata as any).userId, "U_TEST_USER");

      // Should have called openConversation with the user ID
      assert.strictEqual(mockApi.openConversation.mock.calls.length, 1);
      assert.deepStrictEqual(mockApi.openConversation.mock.calls[0].arguments, [
        "U_TEST_USER",
      ]);

      // Should have posted a welcome message
      assert.strictEqual(mockApi.postMessage.mock.calls.length, 1);
      const postCall = mockApi.postMessage.mock.calls[0].arguments;
      assert.strictEqual(postCall[0], "D_MOCK_CHANNEL");
      assert.match(postCall[1], /Test ticket/);
    });

    it("should cache thread for subsequent getThread calls", async () => {
      provider._setKnownUserIdForTest("U_TEST_USER");

      const context: ChatContext = { projectId: "proj1", ticketId: "T-1" };
      const created = await provider.createThread(context, "Test");
      const retrieved = await provider.getThread(context);

      assert.deepStrictEqual(retrieved, created);
    });
  });

  describe("send", () => {
    it("should translate markdown to mrkdwn and post in-thread", async () => {
      const thread = {
        providerId: "slack",
        threadId: "D_CHANNEL",
        metadata: {
          channel: "D_CHANNEL",
          thread_ts: "111.222",
          userId: "U1",
        },
      };
      const message: OutboundMessage = {
        text: "**Bold** question",
      };

      await provider.send(thread, message);

      assert.strictEqual(mockApi.postMessage.mock.calls.length, 1);
      const args = mockApi.postMessage.mock.calls[0].arguments;
      assert.strictEqual(args[0], "D_CHANNEL");
      assert.match(args[1], /\*Bold\* question/);
      assert.deepStrictEqual(args[2], { thread_ts: "111.222" });
    });
  });

  describe("notifyAnswered", () => {
    it("should post acknowledgment in-thread", async () => {
      const thread = {
        providerId: "slack",
        threadId: "D_CHANNEL",
        metadata: {
          channel: "D_CHANNEL",
          thread_ts: "111.222",
          userId: "U1",
        },
      };

      await provider.notifyAnswered(thread, "option A");

      assert.strictEqual(mockApi.postMessage.mock.calls.length, 1);
      const args = mockApi.postMessage.mock.calls[0].arguments;
      assert.strictEqual(args[0], "D_CHANNEL");
      assert.match(args[1], /Already answered/);
      assert.match(args[1], /option A/);
      assert.deepStrictEqual(args[2], { thread_ts: "111.222" });
    });
  });

  describe("handleEvent (user discovery)", () => {
    it("should learn userId from first DM without thread_ts", async () => {
      // Before any event, knownUserId should be null
      assert.strictEqual(provider._getKnownUserIdForTest(), null);

      // Simulate an incoming top-level DM (no thread_ts)
      await provider._handleEventForTest({
        type: "message",
        user: "U_NEW_USER",
        text: "hello bot",
        channel: "D_SOME_CHANNEL",
        channel_type: "im",
        ts: "999.000",
      });

      // Now knownUserId should be set
      assert.strictEqual(provider._getKnownUserIdForTest(), "U_NEW_USER");
    });

    it("should route threaded reply to correct context via responseCallback", async () => {
      provider._setKnownUserIdForTest("U_USER");

      // First create a thread so we have a cache entry
      const context: ChatContext = { projectId: "proj1", ticketId: "T-1" };
      const thread = await provider.createThread(context, "Test");
      const threadTs = (thread.metadata as any).thread_ts;

      // Set up response callback
      let callbackArgs: any[] = [];
      provider.setResponseCallback(async (providerId: string, ctx: ChatContext, answer: string) => {
        callbackArgs = [providerId, ctx, answer];
        return true;
      });

      // Simulate an incoming threaded reply
      await provider._handleEventForTest({
        type: "message",
        user: "U_USER",
        text: "my answer",
        channel: (thread.metadata as any).channel,
        channel_type: "im",
        ts: "999.111",
        thread_ts: threadTs,
      });

      // Response callback should have been called with correct context
      assert.strictEqual(callbackArgs[0], "slack");
      assert.deepStrictEqual(callbackArgs[1], context);
      assert.strictEqual(callbackArgs[2], "my answer");
    });
  });
});
