import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

let pendingQuestion: any = null;
let writeResponseCalls: Array<any> = [];
let reconcileResult: { accepted: boolean; stale: boolean; found: boolean } = {
  accepted: true,
  stale: false,
  found: true,
};
let phaseConfigError: Error | null = null;

class MockWorkflowContextError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowContextError";
    this.code = code;
  }
}

mock.module("../../stores/ticket.store.js", {
  namedExports: {
    listTickets: async () => [],
    getTicket: async () => ({
      id: "POT-1",
      project: "proj-1",
      phase: "Build",
      executionGeneration: 7,
      workflowId: undefined,
    }),
    createTicket: async () => ({}),
    updateTicket: async () => ({}),
    setCurrentHistoryMetadata: () => true,
    isTerminalPhase: () => false,
    deleteTicket: async () => {},
    archiveTicket: async () => ({}),
    restoreTicket: async () => ({}),
    listTicketImages: async () => [],
    saveTicketImage: async () => ({}),
    deleteTicketImage: async () => {},
    listArtifacts: async () => [],
    getArtifactContent: async () => "",
    saveArtifact: async () => ({ filename: "a", isNewVersion: false }),
    loadConversations: async () => [],
    appendConversation: async () => [],
  },
});

mock.module("../../stores/chat.store.js", {
  namedExports: {
    readQuestion: async () => pendingQuestion,
    writeResponse: async (...args: unknown[]) => {
      writeResponseCalls.push(args);
    },
    clearPendingInteraction: async () => {},
  },
});

mock.module("../../stores/ticket-dependency.store.js", {
  namedExports: {
    ticketDependencyGetDependents: () => [],
    ticketDependencyGetWithSatisfaction: () => [],
    ticketDependencyGetForTicket: () => [],
  },
});

mock.module("../../stores/project-workflow.store.js", {
  namedExports: { projectWorkflowGet: () => null },
});

mock.module("../../stores/template.store.js", {
  namedExports: {
    getTemplateWithFullPhasesForProject: async () => null,
    getWorkflowWithFullPhases: async () => null,
    WorkflowContextError: MockWorkflowContextError,
  },
});

mock.module("../../stores/session.store.js", {
  namedExports: { getActiveSessionForTicket: () => null },
});

mock.module("../../stores/conversation.store.js", {
  namedExports: {
    getMessages: () => [],
    createConversationStore: () => ({
      createConversation: () => ({ id: "conv-1" }),
      getConversation: () => null,
      deleteConversation: () => true,
      addMessage: () => ({ id: "msg-1" }),
      getMessage: () => null,
      getMessages: () => [],
      getPendingQuestion: () => null,
      answerQuestion: () => true,
    }),
    addMessage: () => ({ id: "msg-1" }),
    answerQuestion: () => true,
    getPendingQuestion: () => null,
  },
});

mock.module("../../services/session/phase-config.js", {
  namedExports: {
    resolveTargetPhase: async (_p: string, phase: string) => phase,
    getPhaseConfig: async () => {
      if (phaseConfigError) {
        throw phaseConfigError;
      }
      return { workers: [{ id: "w1" }] };
    },
  },
});

class MockTicketLifecycleConflictError extends Error {
  currentPhase: string;
  currentGeneration: number;
  constructor(currentPhase: string, currentGeneration: number) {
    super("Ticket lifecycle changed concurrently");
    this.currentPhase = currentPhase;
    this.currentGeneration = currentGeneration;
  }
}

class MockStaleTicketInputError extends Error {
  currentGeneration: number;
  providedGeneration?: number;
  expectedQuestionId?: string;
  providedQuestionId?: string;
  reason: string;
  constructor(
    reason: string,
    currentGeneration: number,
    providedGeneration?: number,
    expectedQuestionId?: string,
    providedQuestionId?: string,
  ) {
    super(reason);
    this.reason = reason;
    this.currentGeneration = currentGeneration;
    this.providedGeneration = providedGeneration;
    this.expectedQuestionId = expectedQuestionId;
    this.providedQuestionId = providedQuestionId;
  }
}

mock.module("../../services/session/session.service.js", {
  namedExports: {
    TicketLifecycleConflictError: MockTicketLifecycleConflictError,
    StaleTicketInputError: MockStaleTicketInputError,
  },
});

mock.module("../../services/chat.service.js", {
  namedExports: {
    chatService: {
      reconcileWebAnswer: async () => reconcileResult,
    },
  },
});

const { registerTicketRoutes } = await import("../routes/tickets.routes.js");

describe("ticket input route queue reconciliation", () => {
  beforeEach(() => {
    pendingQuestion = null;
    writeResponseCalls = [];
    reconcileResult = { accepted: true, stale: false, found: true };
    phaseConfigError = null;
  });

  it("accepts web answer that resolves queued question without writing stale pending response", async () => {
    let inputHandler: ((req: any, res: any) => Promise<void>) | null = null;

    const app = {
      get: () => {},
      post: (path: string, handler: any) => {
        if (path === "/api/tickets/:project/:id/input") {
          inputHandler = handler;
        }
      },
      put: () => {},
      patch: () => {},
      delete: () => {},
      use: () => {},
    };

    registerTicketRoutes(
      app as any,
      { resumeSuspendedTicket: async () => "sess-1", spawnForTicket: async () => "sess-2" } as any,
      () => new Map([["proj-1", { path: "/tmp/proj-1" } as any]]),
      () => ({ strictStaleResume409: true, strictStaleDrop: true }),
    );

    assert.ok(inputHandler, "input route should be registered");

    const req = {
      params: { project: "proj-1", id: "POT-1" },
      body: { message: "web answer", questionId: "q-queued", ticketGeneration: 7 },
    };

    const responseBody: any = { status: 200, json: null };
    const res = {
      status(code: number) {
        responseBody.status = code;
        return this;
      },
      json(payload: unknown) {
        responseBody.json = payload;
        return this;
      },
    };

    const handler = inputHandler as unknown as (req: unknown, res: unknown) => Promise<void>;
    await handler(req, res);

    assert.equal(responseBody.status, 200);
    assert.deepStrictEqual(responseBody.json, {
      success: true,
      idempotent: false,
      queueResolved: true,
    });
    assert.equal(writeResponseCalls.length, 0);
  });

  it("persists lifecycle identity for legacy web answer when strict stale enforcement is disabled", async () => {
    pendingQuestion = {
      questionId: "q-live",
      ticketGeneration: 7,
    };

    let inputHandler: ((req: any, res: any) => Promise<void>) | null = null;
    const app = {
      get: () => {},
      post: (path: string, handler: any) => {
        if (path === "/api/tickets/:project/:id/input") {
          inputHandler = handler;
        }
      },
      put: () => {},
      patch: () => {},
      delete: () => {},
      use: () => {},
    };

    registerTicketRoutes(
      app as any,
      { resumeSuspendedTicket: async () => "sess-1", spawnForTicket: async () => "sess-2" } as any,
      () => new Map([["proj-1", { path: "/tmp/proj-1" } as any]]),
      () => ({ strictStaleResume409: false, strictStaleDrop: false }),
    );

    assert.ok(inputHandler, "input route should be registered");

    const req = {
      params: { project: "proj-1", id: "POT-1" },
      body: { message: "legacy answer without ids" },
    };

    const responseBody: any = { status: 200, json: null };
    const res = {
      status(code: number) {
        responseBody.status = code;
        return this;
      },
      json(payload: unknown) {
        responseBody.json = payload;
        return this;
      },
    };

    const handler = inputHandler as unknown as (req: unknown, res: unknown) => Promise<void>;
    await handler(req, res);

    assert.equal(responseBody.status, 200);
    assert.deepStrictEqual(responseBody.json, { success: true });
    assert.equal(writeResponseCalls.length, 1);
    assert.deepStrictEqual(writeResponseCalls[0], [
      "proj-1",
      "POT-1",
      {
        answer: "legacy answer without ids",
        questionId: "q-live",
        ticketGeneration: 7,
      },
    ]);
  });

});
