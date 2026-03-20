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

const makeRalphLoopState = (overrides: Record<string, unknown> = {}) => ({
  id: "ralph-1",
  type: "ralphLoop",
  iteration: 1,
  workerIndex: 0, // builder agent is at index 0
  activeWorker: null,
  ...overrides,
});

const makeOrchestratingState = (ralphOverrides: Record<string, unknown> = {}) => ({
  kind: "active",
  phaseId: "Build",
  executionGeneration: 1,
  workerIndex: 0, // ralph-1 is at index 0 in phase.workers
  activeWorker: makeRalphLoopState(ralphOverrides),
  updatedAt: new Date().toISOString(),
});

// Mutable so individual tests can override the starting state
let currentWorkerState: unknown = makeOrchestratingState();

// ── Module mocks ──────────────────────────────────────────────────────────────

await mock.module("../worker-state.js", {
  namedExports: {
    getWorkerState: () => currentWorkerState,
    saveWorkerState: (_projectId: string, _ticketId: string, state: unknown) => {
      savedStates.push(state);
    },
    initWorkerState: () => ({}),
    clearWorkerState: () => {},
    createAgentState: (id: string) => ({ id, type: "agent" }),
    createRalphLoopState: () => makeRalphLoopState(),
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
    currentWorkerState = makeOrchestratingState(); // builder at workerIndex 0, iteration 1

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
    currentWorkerState = makeOrchestratingState();

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

describe("worker-executor: resumeClaudeSessionId threading to spawnAgent on iteration 2+", () => {
  it("passes lastDoerClaudeSessionId as resumeClaudeSessionId to spawnAgent when spawning doer on iteration 2", async () => {
    // Reviewer (last worker at workerIndex=1) is completing at end of iteration 1.
    // The ralph loop state already has lastDoerClaudeSessionId from when the builder ran.
    // After the reviewer rejects, the loop moves to iteration 2 and executeNextWorker
    // spawns the builder — it should receive resumeClaudeSessionId.
    latestSessionId = null; // reviewer completion should NOT update the session ID
    savedStates = [];
    currentWorkerState = makeOrchestratingState({
      workerIndex: 1, // reviewer is at index 1 (last worker in loop)
      lastDoerClaudeSessionId: "claude-session-doer-prev",
    });

    const spawnArgs: unknown[][] = [];
    const spyCallbacks = {
      spawnAgent: async (...args: unknown[]) => {
        spawnArgs.push(args);
        return "new-session-spawned";
      },
      onPhaseComplete: async () => {},
      onTicketBlocked: async () => {},
    };

    // Reviewer completes successfully (exit 0) but rejects (approved: false)
    await handleAgentCompletion(
      "project-1",
      "ticket-1",
      "Build" as never,
      "/tmp/project",
      0, // reviewer exited cleanly
      "reviewer",
      { approved: false, feedback: "builder needs more work" },
      spyCallbacks,
      { sessionId: "sess-reviewer", executionGeneration: 1 },
    );

    // After rejection, executeNextWorker should spawn builder for iteration 2
    assert.ok(spawnArgs.length >= 1, "spawnAgent should be called to spawn builder for iteration 2");
    // spawnAgent signature: (projectId, ticketId, phase, projectPath, agentWorker, taskContext, ralphContext, phaseEntryContext, resumeClaudeSessionId)
    const lastSpawn = spawnArgs[spawnArgs.length - 1];
    const resumeArg = lastSpawn[8];
    assert.equal(
      resumeArg,
      "claude-session-doer-prev",
      "spawnAgent should receive resumeClaudeSessionId = lastDoerClaudeSessionId from previous iteration",
    );
  });

  it("does not pass resumeClaudeSessionId on first iteration (iteration 1)", async () => {
    // First iteration: builder spawned fresh (no resume)
    latestSessionId = null;
    savedStates = [];
    currentWorkerState = makeOrchestratingState(); // iteration: 1, workerIndex: 0

    // Simulating startPhase-like scenario by calling handleAgentCompletion on a previous
    // phase completion that advances to the ralph loop. Instead, use a minimal state where
    // the phase has no activeWorker (top-level agent just completed) to trigger executeNextWorker.
    // For simplicity, test the iteration guard through a rejection at iteration 1 reviewer,
    // which spawns builder at iteration 2 WITH resume — confirming iteration 1 itself
    // never spawns with resume (only iteration 2+).
    // The above test covers the positive case; this test verifies no resume on iteration 1.

    // Set state to builder at iteration 1 (fresh start — no lastDoerClaudeSessionId)
    currentWorkerState = makeOrchestratingState({ workerIndex: 0, lastDoerClaudeSessionId: undefined });

    const spawnArgs: unknown[][] = [];
    const spyCallbacks = {
      spawnAgent: async (...args: unknown[]) => {
        spawnArgs.push(args);
        return "new-session-spawned";
      },
      onPhaseComplete: async () => {},
      onTicketBlocked: async () => {},
    };

    // Builder at iteration 1 completes (transitions to reviewer, not a re-spawn)
    await handleAgentCompletion(
      "project-1",
      "ticket-1",
      "Build" as never,
      "/tmp/project",
      0,
      "builder",
      { approved: false, feedback: "needs review" },
      spyCallbacks,
      { sessionId: "sess-1", executionGeneration: 1 },
    );

    // spawnAgent spawns the reviewer (next in loop) — should have no resumeClaudeSessionId
    assert.ok(spawnArgs.length >= 1, "spawnAgent should be called for reviewer");
    const lastSpawn = spawnArgs[spawnArgs.length - 1];
    const resumeArg = lastSpawn[8];
    assert.equal(
      resumeArg,
      undefined,
      "spawnAgent should NOT receive resumeClaudeSessionId on first iteration",
    );
  });
});
