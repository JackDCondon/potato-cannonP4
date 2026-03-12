import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

const notifyCalls: Array<{ context: { projectId: string; ticketId?: string }; message: string }> = [];
const updateStatusCalls: Array<{ taskId: string; status: string }> = [];

await mock.module("fs", {
  defaultExport: {},
});

await mock.module("child_process", {
  namedExports: {
    spawnSync: () => ({ status: 0, stderr: "", stdout: "" }),
  },
});

await mock.module("../../../types/template.types.js", {
  namedExports: {
    isAgentWorker: (worker: { type?: string }) => worker?.type === "agent",
    isRalphLoopWorker: (worker: { type?: string }) => worker?.type === "ralphLoop",
    isTaskLoopWorker: (worker: { type?: string }) => worker?.type === "taskLoop",
  },
});

await mock.module("../worker-state.js", {
  namedExports: {
    getWorkerState: async () => ({
      kind: "active",
      phaseId: "Build",
      executionGeneration: 3,
      workerIndex: 0,
      activeWorker: {
        id: "build-task-loop",
        type: "taskLoop",
        workerIndex: 0,
        currentTaskId: "task-123",
        pendingTasks: [],
        completedTasks: [],
        failedTasks: [],
        activeWorker: {
          id: "builder",
          type: "agent",
          sessionId: "sess-builder",
        },
      },
      updatedAt: new Date().toISOString(),
    }),
    saveWorkerState: async () => {},
    initWorkerState: async () => ({}),
    clearWorkerState: async () => {},
    createAgentState: () => ({ id: "builder", type: "agent" }),
    prepareForRecovery: (state: unknown) => state,
    hasMatchingExecutionGeneration: () => true,
  },
});

await mock.module("../phase-config.js", {
  namedExports: {
    getPhaseConfig: async () => ({
      id: "Build",
      workers: [
        {
          id: "build-task-loop",
          type: "taskLoop",
          workers: [{ id: "builder", type: "agent", source: "agents/builder.md" }],
        },
      ],
    }),
    getNextEnabledPhase: async () => null,
    phaseRequiresIsolation: async () => false,
  },
});

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicket: () => ({
      executionGeneration: 3,
      workflowId: "wf-product-development",
    }),
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
    listTasks: () => [],
    getTask: () => ({
      id: "task-123",
      description: "Implement chatty notifications",
      status: "in_progress",
    }),
    updateTaskStatus: (taskId: string, status: string) => {
      updateStatusCalls.push({ taskId, status });
    },
  },
});

await mock.module("../ticket-logger.js", {
  namedExports: {
    logToDaemon: async () => {},
  },
});

await mock.module("../../chat.service.js", {
  namedExports: {
    chatService: {
      notify: async (context: { projectId: string; ticketId?: string }, message: string) => {
        notifyCalls.push({ context, message });
      },
    },
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

await mock.module("../loops/ralph-loop.js", {
  namedExports: {
    initRalphLoop: () => ({}),
    handleAgentCompletion: () => ({
      nextState: null,
      result: { status: "approved" },
    }),
  },
});

await mock.module("../loops/task-loop.js", {
  namedExports: {
    initTaskLoop: () => ({}),
    getNextTask: () => null,
    startTask: () => ({}),
    advanceWorkerIndex: () => ({}),
    handleTaskWorkersComplete: () => ({
      nextState: null,
      result: { status: "completed" },
    }),
    buildTaskContext: () => ({}),
  },
});

const { handleAgentCompletion } = await import("../worker-executor.js");

const callbacks = {
  spawnAgent: async () => "",
  onPhaseComplete: async () => {},
  onTicketBlocked: async () => {},
};

describe("worker executor task-close notifications", () => {
  beforeEach(() => {
    notifyCalls.length = 0;
    updateStatusCalls.length = 0;
  });

  it("notifies chat when a task-loop task transitions to completed", async () => {
    await handleAgentCompletion(
      "proj-1",
      "POT-1",
      "Build",
      "D:/tmp/project",
      0,
      "builder",
      { approved: true },
      callbacks,
      { sessionId: "sess-builder", executionGeneration: 3 },
    );

    assert.deepStrictEqual(updateStatusCalls, [{ taskId: "task-123", status: "completed" }]);
    assert.deepStrictEqual(notifyCalls, [
      {
        context: { projectId: "proj-1", ticketId: "POT-1" },
        message: "[Workflow]: Task closed: Implement chatty notifications",
      },
    ]);
  });
});
