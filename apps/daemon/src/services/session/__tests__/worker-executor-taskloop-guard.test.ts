import { describe, it, mock } from "node:test";
import assert from "node:assert";

// Track callback invocations
const blockedCalls: Array<{ projectId: string; ticketId: string; reason: string }> = [];

// Mock all required modules before importing SUT
// (Follow the pattern from worker-executor-p4.test.ts)

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicket: () => ({ id: "TEST-1", phase: "Build", executionGeneration: 1, workflowId: "wf1" }),
    updateTicket: () => ({}),
    getWorkerState: () => ({
      kind: "active",
      phaseId: "Build",
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    setWorkerState: () => {},
    clearWorkerState: () => {},
  },
});

await mock.module("../../../stores/task.store.js", {
  namedExports: {
    listTasks: () => [],  // No pending tasks
    getTask: () => null,
    updateTaskStatus: () => null,
    getTaskComments: () => [],
  },
});

await mock.module("../../../stores/project.store.js", {
  namedExports: {
    getProjectById: () => ({ id: "proj1", path: "/test", templateName: "product-development" }),
    getProjects: () => [],
    updateProjectTemplate: () => {},
    updateProject: () => {},
    createProject: () => ({}),
    deleteProject: () => {},
  },
});

await mock.module("../../../utils/event-bus.js", {
  namedExports: { eventBus: { emit: () => {} } },
});

await mock.module("../ticket-logger.js", {
  namedExports: { logToDaemon: async () => {}, savePrompt: async () => {} },
});

await mock.module("../phase-config.js", {
  namedExports: {
    getPhaseConfig: async () => ({
      id: "Build",
      name: "Build",
      workers: [
        { id: "build-task-loop", type: "taskLoop", maxAttempts: 100, workers: [] },
      ],
      transitions: { next: "Pull Requests" },
    }),
    getNextEnabledPhase: async () => "Pull Requests",
    phaseRequiresIsolation: async () => false,
  },
});

await mock.module("../worker-state.js", {
  namedExports: {
    getWorkerState: () => ({
      kind: "active",
      phaseId: "Build",
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    saveWorkerState: () => {},
    initWorkerState: () => ({
      kind: "active",
      phaseId: "Build",
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    clearWorkerState: () => {},
    createAgentState: (id: string) => ({ id, type: "agent" }),
    prepareForRecovery: (s: unknown) => s,
    hasMatchingExecutionGeneration: () => true,
    createSpawnPendingWorkerState: () => ({}),
    consumeSpawnPendingContinuitySnapshot: () => null,
    createTaskLoopState: () => ({
      id: "build-task-loop",
      type: "taskLoop",
      currentTaskId: null,
      pendingTasks: [],
      completedTasks: [],
      workerIndex: 0,
      activeWorker: null,
    }),
  },
});

await mock.module("../../../stores/ralph-feedback.store.js", {
  namedExports: {
    createRalphFeedback: () => ({}),
    getRalphFeedbackForLoop: () => null,
    addRalphIteration: () => null,
    updateRalphFeedbackStatus: () => null,
  },
});

await mock.module("../../../stores/chat.store.js", {
  namedExports: {
    readQuestion: async () => null,
    clearQuestion: async () => {},
  },
});

await mock.module("../../chat.service.js", {
  namedExports: {
    chatService: { notify: async () => {} },
  },
});

await mock.module("../loops/ralph-loop.js", {
  namedExports: {
    initRalphLoop: () => ({ id: "rl", type: "ralphLoop", iteration: 1, workerIndex: 0, activeWorker: null }),
    handleAgentCompletion: () => ({ loopComplete: true }),
  },
});

await mock.module("../loops/task-loop.js", {
  namedExports: {
    initTaskLoop: () => ({
      id: "build-task-loop", type: "taskLoop", currentTaskId: null,
      pendingTasks: [], completedTasks: [], workerIndex: 0, activeWorker: null,
    }),
    getNextTask: () => null,  // No pending tasks
    startTask: () => ({}),
    advanceWorkerIndex: () => ({}),
    handleTaskWorkersComplete: () => ({ nextState: {}, result: { status: "completed" } }),
    buildTaskContext: () => ({}),
    formatTaskContext: () => "",
  },
});

const { startPhase } = await import("../worker-executor.js");

describe("task-loop empty guard", () => {
  it("blocks ticket when task-loop has zero pending tasks", async () => {
    blockedCalls.length = 0;

    const callbacks = {
      spawnAgent: async () => {
        return "session-id";
      },
      onPhaseComplete: async () => {},
      onTicketBlocked: async (projectId: string, ticketId: string, reason: string) => {
        blockedCalls.push({ projectId, ticketId, reason });
      },
    };

    await startPhase("proj1", "TEST-1", "Build", "/test", callbacks);

    assert.strictEqual(blockedCalls.length, 1, "Should have blocked the ticket");
    assert.ok(
      blockedCalls[0].reason.includes("no pending tasks"),
      `Reason should mention no pending tasks, got: ${blockedCalls[0].reason}`
    );
  });
});
