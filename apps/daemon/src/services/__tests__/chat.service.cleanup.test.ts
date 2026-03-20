import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

let routesRemoved = 0;

mock.module("../../stores/chat.store.js", {
  namedExports: {
    writeQuestion: async () => {},
    readResponse: async () => null,
    readQuestion: async () => null,
    clearQuestion: async () => {},
    clearResponse: async () => {},
    waitForResponse: async () => "mocked response",
    writeResponse: async () => {},
    createWaitController: () => new AbortController(),
  },
});

mock.module("../../stores/provider-channel.store.js", {
  namedExports: {
    createProviderChannelStore: () => ({
      listChannels: () => [],
      deleteChannelsForTicket: () => routesRemoved,
    }),
  },
});

mock.module("../../stores/db.js", {
  namedExports: {
    getDatabase: () => ({
      prepare: () => ({
        get: () => null,
      }),
    }),
  },
});

mock.module("../../stores/conversation.store.js", {
  namedExports: {
    addMessage: () => ({ id: "msg_1" }),
    answerQuestion: () => true,
    getPendingQuestion: () => null,
  },
});

mock.module("../../stores/session.store.js", {
  namedExports: {
    getActiveSessionForBrainstorm: () => null,
    getActiveSessionForTicket: () => null,
  },
});

mock.module("../../utils/event-bus.js", {
  namedExports: {
    eventBus: {
      emit: () => {},
    },
  },
});

const { ChatService } = await import("../chat.service.js");

describe("ChatService cleanupTicketLifecycle", () => {
  let service: InstanceType<typeof ChatService>;

  beforeEach(() => {
    routesRemoved = 3;
    service = new ChatService();
  });

  it("cleanupTicketLifecycle does not reference queue store", async () => {
    const result = await service.cleanupTicketLifecycle("proj", "TICK-X");

    assert.ok(!("queueCancelled" in result));
    assert.ok("routesRemoved" in result);
    assert.ok("threadDeletesAttempted" in result);
  });
});
