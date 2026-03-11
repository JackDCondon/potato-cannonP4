import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";

let ticketGeneration = 2;
let saveCalls = 0;
let blockedCalls = 0;
const phaseConfigCalls: Array<[string, string, string | undefined]> = [];
let mockedWorkerState: Record<string, unknown> = {
  kind: "active",
  phaseId: "Build",
  executionGeneration: ticketGeneration,
  workerIndex: 0,
  activeWorker: null,
  updatedAt: new Date().toISOString(),
};

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
    isAgentWorker: (worker: { type: string }) => worker.type === "agent",
    isRalphLoopWorker: (worker: { type: string }) => worker.type === "ralphLoop",
    isTaskLoopWorker: (worker: { type: string }) => worker.type === "taskLoop",
  },
});

await mock.module("../worker-state.js", {
  namedExports: {
    getWorkerState: () => mockedWorkerState,
    saveWorkerState: () => {
      saveCalls++;
    },
    initWorkerState: () => ({}),
    clearWorkerState: () => {},
    createAgentState: () => ({ id: "a", type: "agent" }),
    prepareForRecovery: (s: unknown) => s,
    hasMatchingExecutionGeneration: () => true,
  },
});

await mock.module("../phase-config.js", {
  namedExports: {
    getPhaseConfig: async (
      projectId: string,
      phase: string,
      workflowId?: string,
    ) => {
      phaseConfigCalls.push([projectId, phase, workflowId]);
      return { id: "Build", workers: [{ id: "agent-1", type: "agent" }] };
    },
    getNextEnabledPhase: async () => null,
    phaseRequiresIsolation: async () => false,
  },
});

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicket: () => ({
      executionGeneration: ticketGeneration,
      workflowId: "wf-custom",
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
    updateTaskStatus: () => {},
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
  onTicketBlocked: async () => {
    blockedCalls++;
  },
};

describe("worker-executor stale callback fencing", () => {
  beforeEach(() => {
    ticketGeneration = 2;
    saveCalls = 0;
    blockedCalls = 0;
    phaseConfigCalls.length = 0;
    mockedWorkerState = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: ticketGeneration,
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    };
  });

  it("drops stale callback generations before mutating worker state", async () => {
    await handleAgentCompletion(
      "proj-1",
      "POT-1",
      "Build",
      "D:/tmp/project",
      0,
      "agent-1",
      { approved: true },
      callbacks,
      { sessionId: "sess-old", executionGeneration: 1 },
    );

    assert.strictEqual(saveCalls, 0);
  });

  it("allows matching callback generations to continue orchestration", async () => {
    await handleAgentCompletion(
      "proj-1",
      "POT-1",
      "Build",
      "D:/tmp/project",
      0,
      "agent-1",
      { approved: true },
      callbacks,
      { sessionId: "sess-current", executionGeneration: 2 },
    );

    assert.strictEqual(saveCalls, 1);
  });

  it("blocks gracefully when worker state points to a missing worker definition", async () => {
    mockedWorkerState = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: ticketGeneration,
      workerIndex: 99,
      activeWorker: {
        id: "loop-1",
        type: "ralphLoop",
        workerIndex: 0,
        iteration: 1,
        activeWorker: null,
      },
      updatedAt: new Date().toISOString(),
    };

    await assert.doesNotReject(async () => {
      await handleAgentCompletion(
        "proj-1",
        "POT-1",
        "Build",
        "D:/tmp/project",
        0,
        "agent-1",
        { approved: true },
        callbacks,
        { sessionId: "sess-current", executionGeneration: 2 },
      );
    });

    assert.strictEqual(blockedCalls, 1);
  });

  it("passes ticket workflowId into phase config resolution", async () => {
    await handleAgentCompletion(
      "proj-1",
      "POT-1",
      "Build",
      "D:/tmp/project",
      0,
      "agent-1",
      { approved: true },
      callbacks,
      { sessionId: "sess-current", executionGeneration: 2 },
    );

    assert.ok(phaseConfigCalls.length > 0);
    assert.deepStrictEqual(phaseConfigCalls[0], ["proj-1", "Build", "wf-custom"]);
  });
});
