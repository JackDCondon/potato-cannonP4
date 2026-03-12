import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

const callOrder: string[] = [];
let deletedTicketArgs: { projectId: string; ticketId: string } | null = null;
let emittedPayload: unknown = null;
let cleanupResult = {
  queueCancelled: 0,
  routesRemoved: 0,
  threadDeletesAttempted: 0,
  threadDeleteErrors: [] as string[],
};

mock.module("../../stores/ticket.store.js", {
  namedExports: {
    deleteTicket: async (projectId: string, ticketId: string) => {
      callOrder.push("deleteTicket");
      deletedTicketArgs = { projectId, ticketId };
    },
  },
});

mock.module("../chat.service.js", {
  namedExports: {
    chatService: {
      cleanupTicketLifecycle: async () => {
        callOrder.push("cleanupTicketLifecycle");
        return cleanupResult;
      },
    },
  },
});

mock.module("../../utils/event-bus.js", {
  namedExports: {
    eventBus: {
      emit: (eventName: string, payload: unknown) => {
        callOrder.push(`emit:${eventName}`);
        emittedPayload = payload;
      },
    },
  },
});

const { deleteTicketWithLifecycle } = await import("../ticket-deletion.service.js");

describe("ticket deletion lifecycle service", () => {
  beforeEach(() => {
    callOrder.length = 0;
    deletedTicketArgs = null;
    emittedPayload = null;
    cleanupResult = {
      queueCancelled: 2,
      routesRemoved: 1,
      threadDeletesAttempted: 3,
      threadDeleteErrors: [],
    };
  });

  it("runs lifecycle cleanup sequence and returns structured report", async () => {
    const sessionService = {
      terminateTicketSession: async (_ticketId: string) => {
        callOrder.push("terminateTicketSession");
        return true;
      },
    };

    const report = await deleteTicketWithLifecycle("proj-1", "TKT-1", {
      sessionService,
    });

    assert.deepStrictEqual(callOrder, [
      "terminateTicketSession",
      "cleanupTicketLifecycle",
      "deleteTicket",
      "emit:ticket:deleted",
    ]);
    assert.deepStrictEqual(deletedTicketArgs, {
      projectId: "proj-1",
      ticketId: "TKT-1",
    });
    assert.deepStrictEqual(report, {
      sessionStopped: true,
      queueCancelled: 2,
      routesRemoved: 1,
      threadDeletesAttempted: 3,
      threadDeleteErrors: [],
    });
    assert.deepStrictEqual(emittedPayload, {
      projectId: "proj-1",
      ticketId: "TKT-1",
      cleanup: report,
    });
  });

  it("preserves provider thread warning errors in the lifecycle report", async () => {
    cleanupResult = {
      queueCancelled: 0,
      routesRemoved: 0,
      threadDeletesAttempted: 2,
      threadDeleteErrors: ["telegram/thread-1: timeout"],
    };
    const sessionService = {
      terminateTicketSession: async (_ticketId: string) => false,
    };

    const report = await deleteTicketWithLifecycle("proj-2", "TKT-2", {
      sessionService,
    });

    assert.equal(report.sessionStopped, false);
    assert.equal(report.threadDeletesAttempted, 2);
    assert.deepStrictEqual(report.threadDeleteErrors, [
      "telegram/thread-1: timeout",
    ]);
  });

  it("continues deletion when session termination throws and records warning", async () => {
    const sessionService = {
      terminateTicketSession: async (_ticketId: string) => {
        callOrder.push("terminateTicketSession");
        throw new Error("session terminate failed");
      },
    };

    const report = await deleteTicketWithLifecycle("proj-3", "TKT-3", {
      sessionService,
    });

    assert.deepStrictEqual(callOrder, [
      "terminateTicketSession",
      "cleanupTicketLifecycle",
      "deleteTicket",
      "emit:ticket:deleted",
    ]);
    assert.ok(
      report.threadDeleteErrors.some((entry) =>
        entry.includes("session:session terminate failed")
      )
    );
  });
});
