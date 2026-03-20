import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

let currentWorkerState: unknown = null;
const spawnCalls: Array<{ workerId: string }> = [];

await mock.module("fs", {
  defaultExport: {
    access: (_path: string, callback: (error: Error | null) => void) => callback(null),
    accessSync: () => {},
    constants: { F_OK: 0 },
    mkdirSync: () => {},
  },
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
    getWorkerState: async () => currentWorkerState,
    saveWorkerState: async (_projectId: string, _ticketId: string, state: unknown) => {
      currentWorkerState = state;
    },
    initWorkerState: async () => ({
      kind: "active",
      phaseId: "Build",
      executionGeneration: 2,
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    clearWorkerState: async () => {},
    createAgentState: (id: string) => ({ id, type: "agent" }),
    prepareForRecovery: (state: unknown) => state,
    hasMatchingExecutionGeneration: () => true,
    createRalphLoopState: (id: string, maxAttempts?: number) => ({
      id,
      type: "ralphLoop",
      iteration: 1,
      maxAttempts,
      workerIndex: 0,
      activeWorker: null,
    }),
  },
});

await mock.module("../phase-config.js", {
  namedExports: {
    getPhaseConfig: async () => ({
      id: "Build",
      workers: [
        {
          id: "qa-ralph-loop",
          type: "ralphLoop",
          maxAttempts: 3,
          workers: [
            {
              id: "qa-fixer-agent",
              type: "agent",
              source: "agents/qa-fixer.md",
              skipOnFirstIteration: true,
            },
            {
              id: "qa-agent",
              type: "agent",
              source: "agents/qa.md",
            },
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
    getTicket: () => ({ executionGeneration: 2, workflowId: "wf-1" }),
  },
});

await mock.module("../../../stores/project.store.js", {
  namedExports: {
    getProjectById: () => null,
  },
});

await mock.module("../../../stores/template.store.js", {
  namedExports: {
    WorkflowContextError: class WorkflowContextError extends Error {
      code: string;

      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    },
    installDefaultTemplates: async () => {},
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
    updateTaskStatus: () => null,
  },
});

await mock.module("../../chat.service.js", {
  namedExports: {
    chatService: {
      notify: async () => {},
    },
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
    handleTaskWorkersComplete: () => ({
      nextState: null,
      result: { status: "completed" },
    }),
    buildTaskContext: () => ({}),
  },
});

const { startPhase } = await import("../worker-executor.js");

const callbacks = {
  spawnAgent: async (
    _projectId: string,
    _ticketId: string,
    _phase: string,
    _projectPath: string,
    agentWorker: { id: string },
  ) => {
    spawnCalls.push({ workerId: agentWorker.id });
    return "sess_123";
  },
  onPhaseComplete: async () => {},
  onTicketBlocked: async () => {},
};

describe("worker-executor ralph first-iteration worker skipping", () => {
  beforeEach(() => {
    currentWorkerState = null;
    spawnCalls.length = 0;
  });

  it("skips the flagged first worker on iteration 1", async () => {
    await startPhase("proj-1", "POT-1", "Build", "D:/tmp/project", callbacks);

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].workerId, "qa-agent");
  });

  it("still runs the flagged worker on iteration 2", async () => {
    currentWorkerState = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: 2,
      workerIndex: 0,
      activeWorker: {
        id: "qa-ralph-loop",
        type: "ralphLoop",
        iteration: 2,
        maxAttempts: 3,
        workerIndex: 0,
        activeWorker: null,
      },
      updatedAt: new Date().toISOString(),
    };

    await startPhase("proj-1", "POT-1", "Build", "D:/tmp/project", callbacks);

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].workerId, "qa-fixer-agent");
  });
});
