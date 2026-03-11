import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

let openQueueItems: Array<{
  id: string;
  projectId: string;
  ticketId?: string;
  kind: "question" | "notification";
}> = [];
let cancelledIds: string[] = [];
let activeSessionTicketIds = new Set<string>();
let pendingQuestionByTicket = new Map<string, unknown>();
let pendingResponseByTicket = new Map<string, unknown>();
let ticketRows = new Map<string, { phase: string; archived_at: string | null } | null>();
let tickQueueCalls = 0;

const mockDb = {
  prepare: (_sql: string) => ({
    get: (ticketId: string, _projectId: string) => {
      const row = ticketRows.get(ticketId);
      if (row === undefined || row === null) {
        return undefined;
      }
      return { id: ticketId, ...row };
    },
  }),
};

mock.module("../../stores/chat-queue.store.js", {
  namedExports: {
    createChatQueueStore: () => ({
      listOpenQueueItems: () => openQueueItems,
      markCancelled: (id: string) => {
        cancelledIds.push(id);
      },
      cancelOpenItemsForTicket: () => 0,
      listChannels: () => [],
    }),
  },
});

mock.module("../../stores/chat.store.js", {
  namedExports: {
    writeQuestion: async () => {},
    readResponse: async (_projectId: string, contextId: string) =>
      pendingResponseByTicket.get(contextId) ?? null,
    readQuestion: async (_projectId: string, contextId: string) =>
      pendingQuestionByTicket.get(contextId) ?? null,
    clearQuestion: async () => {},
    clearResponse: async () => {},
    waitForResponse: async () => "mocked response",
    writeResponse: async () => {},
    createWaitController: () => new AbortController(),
  },
});

mock.module("../../stores/session.store.js", {
  namedExports: {
    getActiveSessionForTicket: (ticketId: string) =>
      activeSessionTicketIds.has(ticketId) ? { id: "sess_active" } : null,
  },
});

mock.module("../../stores/ticket.store.js", {
  namedExports: {
    isTerminalPhase: (phase: string) => ["Done", "Archived", "Cancelled"].includes(phase),
  },
});

mock.module("../../stores/db.js", {
  namedExports: {
    getDatabase: () => mockDb,
  },
});

mock.module("../chat/chat-orchestrator.js", {
  namedExports: {
    ChatOrchestrator: class {
      async enqueueQuestion(): Promise<void> {}
      async enqueueNotification(): Promise<void> {}
      async resolveQuestion(): Promise<{ accepted: boolean; stale: boolean }> {
        return { accepted: true, stale: false };
      }
      async tickQueue(): Promise<void> {
        tickQueueCalls++;
      }
    },
  },
});

mock.module("../../stores/conversation.store.js", {
  namedExports: {
    addMessage: () => ({ id: "msg_1" }),
    answerQuestion: () => true,
    getPendingQuestion: () => null,
  },
});

mock.module("../../stores/provider-channel.store.js", {
  namedExports: {
    createProviderChannelStore: () => ({
      listChannels: () => [],
      deleteChannelsForTicket: () => 0,
    }),
  },
});

mock.module("../../stores/ticket-log.store.js", {
  namedExports: {
    appendTicketLog: async () => {},
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

describe("ChatService queue pruning", () => {
  let service: InstanceType<typeof ChatService>;

  beforeEach(() => {
    openQueueItems = [];
    cancelledIds = [];
    activeSessionTicketIds = new Set<string>();
    pendingQuestionByTicket = new Map<string, unknown>();
    pendingResponseByTicket = new Map<string, unknown>();
    ticketRows = new Map<string, { phase: string; archived_at: string | null } | null>();
    tickQueueCalls = 0;
    service = new ChatService();
  });

  it("skips session-end prune while a replacement session is active", async () => {
    activeSessionTicketIds.add("T-1");

    const result = await service.pruneTicketQueueAfterSessionEnd("proj-1", "T-1");
    assert.deepStrictEqual(result, { checked: 0, cancelled: 0 });
  });

  it("cancels stale queue items for missing/terminal tickets but preserves pending interactions", async () => {
    openQueueItems = [
      { id: "q-missing", projectId: "proj-1", ticketId: "T-missing", kind: "question" },
      { id: "q-terminal", projectId: "proj-1", ticketId: "T-terminal", kind: "question" },
      { id: "q-pending", projectId: "proj-1", ticketId: "T-pending", kind: "question" },
      { id: "n-active", projectId: "proj-1", ticketId: "T-active", kind: "notification" },
    ];

    ticketRows.set("T-missing", null);
    ticketRows.set("T-terminal", { phase: "Done", archived_at: null });
    ticketRows.set("T-pending", { phase: "Build", archived_at: null });
    ticketRows.set("T-active", { phase: "Build", archived_at: null });
    pendingQuestionByTicket.set("T-pending", { questionId: "q1" });

    const result = await service.pruneIrrelevantTicketQueue({
      preservePendingInteraction: true,
    });

    assert.equal(result.checked, 4);
    assert.equal(result.cancelled, 3);
    assert.deepStrictEqual(cancelledIds.sort(), ["n-active", "q-missing", "q-terminal"]);
    assert.equal(tickQueueCalls, 1);
  });
});
