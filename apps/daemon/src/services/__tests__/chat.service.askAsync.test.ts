// src/services/__tests__/chat.service.askAsync.test.ts
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";

/**
 * Tests for ChatService.askAsync method.
 *
 * These tests use Node.js experimental module mocking to stub external
 * dependencies (database, file system, event bus) and verify that askAsync():
 * 1. Returns { status: 'pending', questionId: string }
 * 2. Doesn't block waiting for response
 */

// Track mock calls
let writeQuestionCalls: Array<{
  projectId: string;
  contextId: string;
  question: unknown;
}> = [];
let writeResponseCalls: Array<{
  projectId: string;
  contextId: string;
  response: unknown;
}> = [];
let eventBusEmitCalls: Array<{ event: string; data: unknown }> = [];
let addMessageCalls: Array<{ conversationId: string; input: unknown }> = [];
let messageIdCounter = 0;
let readQuestionResult: unknown = null;

// Mock the external dependencies before importing ChatService
mock.module("../../stores/chat.store.js", {
  namedExports: {
    writeQuestion: async (
      projectId: string,
      contextId: string,
      question: unknown
    ) => {
      writeQuestionCalls.push({ projectId, contextId, question });
    },
    writeResponse: async (
      projectId: string,
      contextId: string,
      response: unknown
    ) => {
      writeResponseCalls.push({ projectId, contextId, response });
    },
    readResponse: async () => null,
    readQuestion: async () => readQuestionResult,
    clearQuestion: async () => {},
    clearResponse: async () => {},
    waitForResponse: async () => "mocked response",
    createWaitController: () => new AbortController(),
  },
});

mock.module("../../stores/conversation.store.js", {
  namedExports: {
    addMessage: (conversationId: string, input: unknown) => {
      messageIdCounter++;
      const msgId = `msg_${messageIdCounter}`;
      addMessageCalls.push({ conversationId, input });
      return {
        id: msgId,
        conversationId,
        type: (input as { type: string }).type,
        text: (input as { text: string }).text,
        createdAt: new Date().toISOString(),
      };
    },
    answerQuestion: () => true,
    getPendingQuestion: () => null,
  },
});

// Mock database to return null for conversation lookups (no conversation)
const mockDb = {
  prepare: (_sql: string) => ({
    get: () => null,
    run: () => ({}),
  }),
};

mock.module("../../stores/db.js", {
  namedExports: {
    getDatabase: () => mockDb,
  },
});

mock.module("../../utils/event-bus.js", {
  namedExports: {
    eventBus: {
      emit: (event: string, data: unknown) => {
        eventBusEmitCalls.push({ event, data });
      },
      on: () => {},
      off: () => {},
    },
  },
});

mock.module("../../stores/ticket-log.store.js", {
  namedExports: {
    appendTicketLog: async () => {},
  },
});

mock.module("../../stores/chat-threads.store.js", {
  namedExports: {
    getProviderThread: async () => null,
    setProviderThread: async () => {},
    getAllThreads: async () => [],
  },
});

// Import ChatService after mocks are in place
const { ChatService } = await import("../chat.service.js");

describe("ChatService.askAsync", () => {
  let service: InstanceType<typeof ChatService>;

  beforeEach(() => {
    // Reset mock call tracking
    writeQuestionCalls = [];
    writeResponseCalls = [];
    eventBusEmitCalls = [];
    addMessageCalls = [];
    messageIdCounter = 0;
    readQuestionResult = null;

    service = new ChatService();
  });

  afterEach(() => {
    // Clean up any registered providers
    for (const provider of service.getActiveProviders()) {
      service.unregisterProvider(provider.id);
    }
  });

  it("should return immediately with pending status", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_123" };
    const question = "What color do you prefer?";

    const result = await service.askAsync(context, question);

    assert.strictEqual(result.status, "pending");
    assert.ok(result.questionId !== undefined, "Should return a questionId");
  });

  it("should not block waiting for response", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_456" };
    const question = "What is your favorite food?";

    const startTime = Date.now();
    await service.askAsync(context, question);
    const elapsed = Date.now() - startTime;

    // Should complete almost instantly (< 100ms), not wait for response
    assert.ok(elapsed < 100, `Should not block, but took ${elapsed}ms`);
  });

  it("should write pending question to chat store", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_789" };
    const question = "Should we proceed?";
    const options = ["Yes", "No", "Maybe"];

    await service.askAsync(context, question, options);

    assert.strictEqual(writeQuestionCalls.length, 1);
    assert.strictEqual(writeQuestionCalls[0].projectId, "test-project");
    assert.strictEqual(writeQuestionCalls[0].contextId, "brain_789");
    const writtenQuestion = writeQuestionCalls[0].question as {
      question: string;
      options: string[] | null;
    };
    assert.strictEqual(writtenQuestion.question, question);
    assert.deepStrictEqual(writtenQuestion.options, options);
  });

  it("should emit brainstorm:message event", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_event" };
    const question = "What do you think?";

    await service.askAsync(context, question);

    const brainstormEvents = eventBusEmitCalls.filter(
      (c) => c.event === "brainstorm:message"
    );
    assert.strictEqual(brainstormEvents.length, 1);
    const eventData = brainstormEvents[0].data as {
      projectId: string;
      brainstormId: string;
      message: { type: string; text: string };
    };
    assert.strictEqual(eventData.projectId, "test-project");
    assert.strictEqual(eventData.brainstormId, "brain_event");
    assert.strictEqual(eventData.message.type, "question");
    assert.strictEqual(eventData.message.text, question);
  });

  it("should store options for number mapping", async () => {
    const options = ["Option A", "Option B", "Option C"];
    const context = { projectId: "test", brainstormId: "brain_options" };

    await service.askAsync(context, "Pick one", options);

    // Verify the options are stored in pendingOptions map
    const contextKey = (service as any).getContextKey(context);
    const storedOptions = (service as any).pendingOptions.get(contextKey);
    assert.deepStrictEqual(storedOptions, options);
  });

  it("should accept phase parameter", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_phase" };
    const question = "What phase is this?";
    const phase = "Refinement";

    await service.askAsync(context, question, undefined, phase);

    const writtenQuestion = writeQuestionCalls[0].question as {
      phase?: string;
    };
    assert.strictEqual(writtenQuestion.phase, phase);
  });

  it("should work with ticket context", async () => {
    const context = { projectId: "test-project", ticketId: "POT-123" };
    const question = "Is this a ticket?";

    const result = await service.askAsync(context, question);

    assert.strictEqual(result.status, "pending");
    assert.strictEqual(writeQuestionCalls[0].contextId, "POT-123");
  });

  it("should return empty questionId when no conversation exists", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_noconv" };

    // With our mock db returning null, there's no conversation
    const result = await service.askAsync(context, "Question without conversation");

    assert.strictEqual(result.status, "pending");
    // When no conversation, questionId is empty string
    assert.strictEqual(result.questionId, "");
  });

  it("should not add message when no conversationId", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_nomsg" };

    // With our mock db returning null, there's no conversation
    await service.askAsync(context, "Question not recorded");

    // addMessage should not be called when there's no conversation
    assert.strictEqual(addMessageCalls.length, 0);
  });

  it("should complete multiple calls independently", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_multi" };

    const result1 = await service.askAsync(context, "Question 1");
    const result2 = await service.askAsync(context, "Question 2");

    // Both should succeed with pending status
    assert.strictEqual(result1.status, "pending");
    assert.strictEqual(result2.status, "pending");
    // Both should have written questions
    assert.strictEqual(writeQuestionCalls.length, 2);
  });

  it("should not emit ticket:message event for brainstorm context", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_only" };

    await service.askAsync(context, "Brainstorm question");

    const ticketEvents = eventBusEmitCalls.filter(
      (c) => c.event === "ticket:message"
    );
    assert.strictEqual(ticketEvents.length, 0);
  });

  it("should emit ticket:message event for ticket context", async () => {
    const context = { projectId: "test-project", ticketId: "POT-999" };

    await service.askAsync(context, "Ticket suspend question");

    const ticketEvents = eventBusEmitCalls.filter(
      (c) => c.event === "ticket:message"
    );
    assert.strictEqual(ticketEvents.length, 1);
    const eventData = ticketEvents[0].data as {
      projectId: string;
      ticketId: string;
      message: { type: string; text: string };
    };
    assert.strictEqual(eventData.projectId, "test-project");
    assert.strictEqual(eventData.ticketId, "POT-999");
    assert.strictEqual(eventData.message.type, "question");
    assert.strictEqual(eventData.message.text, "Ticket suspend question");
  });

  it("should handle null options", async () => {
    const context = { projectId: "test-project", brainstormId: "brain_null" };

    await service.askAsync(context, "Question with no options", undefined);

    const writtenQuestion = writeQuestionCalls[0].question as {
      options: string[] | null;
    };
    assert.strictEqual(writtenQuestion.options, null);
  });

  it("should map telegram callback token to selected option in handleResponse", async () => {
    const context = { projectId: "test-project", ticketId: "POT-100" };
    readQuestionResult = {
      questionId: "q-1",
      options: ["Yes", "No", "Maybe"],
      ticketGeneration: 2,
    };

    const handled = await service.handleResponse("telegram", context, "answer_1");

    assert.strictEqual(handled, true);
    assert.strictEqual(writeResponseCalls.length, 1);
    const written = writeResponseCalls[0].response as { answer: string };
    assert.strictEqual(written.answer, "No");
  });

  it("should map numbered reply to selected option in handleResponse", async () => {
    const context = { projectId: "test-project", ticketId: "POT-101" };
    readQuestionResult = {
      questionId: "q-2",
      options: ["Alpha", "Beta", "Gamma"],
      ticketGeneration: 3,
    };

    const handled = await service.handleResponse("telegram", context, "3");

    assert.strictEqual(handled, true);
    assert.strictEqual(writeResponseCalls.length, 1);
    const written = writeResponseCalls[0].response as { answer: string };
    assert.strictEqual(written.answer, "Gamma");
  });
});
