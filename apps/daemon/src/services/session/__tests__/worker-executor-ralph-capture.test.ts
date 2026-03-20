import { describe, it, mock } from "node:test";
import assert from "node:assert";

/**
 * Call-site integration test for doer session ID capture in the ralph loop.
 *
 * Verifies that processNestedCompletion (via handleAgentCompletion) correctly:
 *  1. Calls getLatestClaudeSessionIdForTicket to look up the session ID
 *  2. Passes it to captureDoerSessionIdIfNeeded
 *  3. Persists it into RalphLoopState via saveWorkerState
 *
 * Uses the REAL ralph-loop.ts (captureDoerSessionIdIfNeeded + handleAgentCompletion)
 * and mocks session.store to control the returned session ID.
 *
 * Mocked modules (prevents SQLite / native module initialisation):
 *  - ../worker-state.js
 *  - ../../../types/template.types.js
 *  - ../phase-config.js
 *  - ../../../stores/ticket.store.js
 *  - ../../../stores/session.store.js   ← key mock (controls latestSessionId)
 *  - ../../../stores/project.store.js
 *  - ../../../stores/chat.store.js
 *  - ../../../stores/task.store.js
 *  - ../../chat.service.js
 *  - ../ticket-logger.js
 *  - ../../../stores/ralph-feedback.store.js
 *  - ../loops/task-loop.js
 *
 * NOT mocked: ../loops/ralph-loop.js (real implementation under test)
 */

// ── Shared mutable state ──────────────────────────────────────────────────────

let savedStates: unknown[] = [];
let latestSessionId: string | null = "claude-session-doer-xyz";

const ralphLoopWorkerState = () => ({
  id: "ralph-1",
  type: "ralphLoop",
  iteration: 1,
  workerIndex: 0, // builder agent is at index 0
  activeWorker: null,
});

const orchestrationState = () => ({
  kind: "active",
  phaseId: "Build",
  executionGeneration: 1,
  workerIndex: 0, // ralph-1 is at index 0 in phase.workers
  activeWorker: ralphLoopWorkerState(),
  updatedAt: new Date().toISOString(),
});

// ── Module mocks ──────────────────────────────────────────────────────────────

await mock.module("../worker-state.js", {
  namedExports: {
    getWorkerState: () => orchestrationState(),
    saveWorkerState: (_projectId: string, _ticketId: string, state: unknown) => {
      savedStates.push(state);
    },
    initWorkerState: () => ({}),
    clearWorkerState: () => {},
    createAgentState: (id: string) => ({ id, type: "agent" }),
    createRalphLoopState: () => ralphLoopWorkerState(),
    prepareForRecovery: (s: unknown) => s,
    hasMatchingExecutionGeneration: () => true,
    updateStateWithActiveWorker: (state: Record<string, unknown>, activeWorker: unknown) => ({
      ...state,
      activeWorker,
    }),
  },
});

await mock.module("../../../types/template.types.js", {
  namedExports: {
    isAgentWorker: (w: { type: string }) => w.type === "agent",
    isRalphLoopWorker: (w: { type: string }) => w.type === "ralphLoop",
    isTaskLoopWorker: (w: { type: string }) => w.type === "taskLoop",
  },
});

await mock.module("../phase-config.js", {
  namedExports: {
    getPhaseConfig: async () => ({
      id: "Build",
      workers: [
        {
          id: "ralph-1",
          type: "ralphLoop",
          maxAttempts: 3,
          workers: [
            { id: "builder", type: "agent", source: "agents/builder.md", resumeOnRalphRetry: true },
            { id: "reviewer", type: "agent", source: "agents/reviewer.md" },
          ],
        },
      ],
    }),
    getNextEnabledPhase: async () => null,
    phaseRequiresIsolation: async () => false,
  },
});

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicket: () => ({ executionGeneration: 1, workflowId: "wf-1" }),
  },
});

// KEY: controls what getLatestClaudeSessionIdForTicket returns
await mock.module("../../../stores/session.store.js", {
  namedExports: {
    getLatestClaudeSessionIdForTicket: () => latestSessionId,
    updateSessionTokens: () => true,
  },
});

await mock.module("../../../stores/project.store.js", {
  namedExports: {
    getProjectById: () => null,
  },
});

await mock.module("../../../stores/chat.store.js", {
  namedExports: {
    readQuestion: async () => null,
    clearQuestion: async () => {},
  },
});

await mock.module("../../../stores/task.store.js", {
  namedExports: {
    getTask: () => null,
    listTasks: () => [],
    updateTaskStatus: () => {},
  },
});

await mock.module("../../chat.service.js", {
  namedExports: {
    chatService: { notify: async () => {} },
  },
});

await mock.module("../ticket-logger.js", {
  namedExports: {
    logToDaemon: async () => {},
  },
});

await mock.module("../../../stores/ralph-feedback.store.js", {
  namedExports: {
    createRalphFeedback: () => {},
    addRalphIteration: () => {},
    updateRalphFeedbackStatus: () => {},
    getRalphFeedbackForLoop: () => null,
  },
});

await mock.module("../loops/task-loop.js", {
  namedExports: {
    initTaskLoop: () => ({}),
    getNextTask: () => null,
    startTask: () => ({}),
    advanceWorkerIndex: () => ({}),
    handleTaskWorkersComplete: () => ({ nextState: null, result: { status: "completed" } }),
    buildTaskContext: () => ({}),
  },
});

// ralph-loop.js is NOT mocked — real captureDoerSessionIdIfNeeded is under test

const { handleAgentCompletion } = await import("../worker-executor.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const callbacks = {
  spawnAgent: async () => "new-session-id",
  onPhaseComplete: async () => {},
  onTicketBlocked: async () => {},
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("worker-executor: doer session ID capture via processNestedCompletion", () => {
  it("sets lastDoerClaudeSessionId in RalphLoopState when builder completes and session ID is available", async () => {
    latestSessionId = "claude-session-doer-xyz";
    savedStates = [];

    await handleAgentCompletion(
      "project-1",
      "ticket-1",
      "Build" as never,
      "/tmp/project",
      0, // exitCode = 0 (success)
      "builder",
      { approved: false, feedback: "needs more work" },
      callbacks,
      { sessionId: "sess-1", executionGeneration: 1 },
    );

    // The first saveWorkerState call captures state after processNestedCompletion
    assert.ok(savedStates.length >= 1, "saveWorkerState should be called at least once");
    const firstSaved = savedStates[0] as {
      activeWorker: { lastDoerClaudeSessionId?: string };
    };
    assert.equal(
      firstSaved.activeWorker?.lastDoerClaudeSessionId,
      "claude-session-doer-xyz",
      "lastDoerClaudeSessionId should be set from getLatestClaudeSessionIdForTicket",
    );
  });

  it("does not set lastDoerClaudeSessionId when getLatestClaudeSessionIdForTicket returns null", async () => {
    latestSessionId = null;
    savedStates = [];

    await handleAgentCompletion(
      "project-1",
      "ticket-1",
      "Build" as never,
      "/tmp/project",
      0,
      "builder",
      { approved: false, feedback: "needs more work" },
      callbacks,
      { sessionId: "sess-1", executionGeneration: 1 },
    );

    assert.ok(savedStates.length >= 1, "saveWorkerState should be called at least once");
    const firstSaved = savedStates[0] as {
      activeWorker: { lastDoerClaudeSessionId?: string };
    };
    assert.equal(
      firstSaved.activeWorker?.lastDoerClaudeSessionId,
      undefined,
      "lastDoerClaudeSessionId should NOT be set when session ID is null",
    );
  });
});
