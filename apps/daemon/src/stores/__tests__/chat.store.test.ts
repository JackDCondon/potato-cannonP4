import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  waitForResponse,
  createWaitController,
  cancelWaitForResponse,
  writeResponse,
  clearResponse,
  clearQuestion,
  getPendingQuestionsByProject,
  getPendingQuestionsByProjectFiltered,
  writeQuestion,
} from "../chat.store.js";

// Override BRAINSTORMS_DIR for testing
const TEST_DIR = path.join(os.tmpdir(), `potato-chat-test-${Date.now()}`);

describe("chat.store cancellation", () => {
  const projectId = "test-project";
  const contextsToCleanup: string[] = [];

  function createContextId(): string {
    const contextId = `brain_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    contextsToCleanup.push(contextId);
    return contextId;
  }

  before(async () => {
    // Create test directory
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    // Cleanup test directory
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  afterEach(async () => {
    for (const contextId of contextsToCleanup.splice(0)) {
      cancelWaitForResponse(contextId);
      await clearQuestion(projectId, contextId);
      await clearResponse(projectId, contextId);
    }
  });

  it("should cancel waitForResponse when abort signal is triggered", async () => {
    const contextId = createContextId();
    const controller = createWaitController(contextId);

    const waitPromise = waitForResponse(projectId, contextId, 10000, controller.signal);

    // Cancel after 100ms
    setTimeout(() => {
      cancelWaitForResponse(contextId);
    }, 100);

    await assert.rejects(
      waitPromise,
      { message: "Wait cancelled - session replaced" }
    );
  });

  it("should replace existing controller when creating a new one", () => {
    const contextId = createContextId();
    const controller1 = createWaitController(contextId);
    const controller2 = createWaitController(contextId);

    // First controller should be aborted
    assert.strictEqual(controller1.signal.aborted, true);
    assert.strictEqual(controller2.signal.aborted, false);
  });

  it("should return response when not cancelled", async () => {
    const contextId = createContextId();
    const controller = createWaitController(contextId);

    // Write response after 100ms
    setTimeout(async () => {
      await writeResponse(projectId, contextId, { answer: "test answer" });
    }, 100);

    const result = await waitForResponse(projectId, contextId, 10000, controller.signal);
    assert.strictEqual(result, "test answer");
  });

  it("should work without providing a signal (backwards compatibility)", async () => {
    const contextId = createContextId();
    // Write response after 100ms
    setTimeout(async () => {
      await writeResponse(projectId, contextId, { answer: "backwards compat" });
    }, 100);

    const result = await waitForResponse(projectId, contextId, 10000);
    assert.strictEqual(result, "backwards compat");
  });
});

describe("getPendingQuestionsByProject", () => {
  const projectId = "test-project";
  const ticketId1 = "ticket-1";
  const ticketId2 = "ticket-2";
  const ticketId3 = "ticket-3";

  afterEach(async () => {
    // Clean up all test tickets
    for (const id of [ticketId1, ticketId2, ticketId3]) {
      await clearQuestion(projectId, id);
    }
  });

  it("should return empty map when no pending questions exist", async () => {
    const result = await getPendingQuestionsByProject();
    const tickets = result.get(projectId);
    // Either undefined or empty array
    assert.ok(!tickets || tickets.length === 0);
  });

  it("should return ticket IDs with pending questions grouped by project", async () => {
    // Write pending questions for two tickets
    await writeQuestion(projectId, ticketId1, {
      conversationId: "conv-1",
      question: "What color?",
      options: null,
      askedAt: new Date().toISOString(),
    });
    await writeQuestion(projectId, ticketId2, {
      conversationId: "conv-2",
      question: "What size?",
      options: ["S", "M", "L"],
      askedAt: new Date().toISOString(),
    });

    const result = await getPendingQuestionsByProject();
    const tickets = result.get(projectId);
    assert.ok(tickets);
    assert.ok(tickets.includes(ticketId1));
    assert.ok(tickets.includes(ticketId2));
    assert.strictEqual(tickets.length, 2);
  });

  it("should not include tickets without pending questions", async () => {
    // Only write question for ticket1, not ticket2
    await writeQuestion(projectId, ticketId1, {
      conversationId: "conv-1",
      question: "What color?",
      options: null,
      askedAt: new Date().toISOString(),
    });

    const result = await getPendingQuestionsByProject();
    const tickets = result.get(projectId);
    assert.ok(tickets);
    assert.ok(tickets.includes(ticketId1));
    assert.ok(!tickets.includes(ticketId2));
  });

  it("should filter out pending questions when callback returns false", async () => {
    await writeQuestion(projectId, ticketId1, {
      conversationId: "conv-1",
      question: "Architecture question",
      options: null,
      askedAt: new Date().toISOString(),
      phase: "Architecture",
    });
    await writeQuestion(projectId, ticketId2, {
      conversationId: "conv-2",
      question: "Build question",
      options: null,
      askedAt: new Date().toISOString(),
      phase: "Build",
    });

    const result = await getPendingQuestionsByProjectFiltered(
      ({ question }) => question.phase !== "Architecture",
    );

    const tickets = result.get(projectId);
    assert.ok(tickets);
    assert.ok(!tickets.includes(ticketId1));
    assert.ok(tickets.includes(ticketId2));
    assert.strictEqual(tickets.length, 1);
  });
});
