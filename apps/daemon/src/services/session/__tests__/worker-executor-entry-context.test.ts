import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

let phaseTasks: Array<{ id: string; description: string; status: string }> = [];
const spawnCalls: Array<{ phaseEntryContext?: unknown }> = [];

await mock.module("fs", {
  defaultExport: {
    access: (_path: string, callback: (error: Error | null) => void) => callback(null),
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
    getWorkerState: async () => null,
    saveWorkerState: async () => {},
    initWorkerState: async () => ({
      kind: "active",
      phaseId: "Build",
      executionGeneration: 2,
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    clearWorkerState: async () => {},
    createAgentState: () => ({ id: "taskmaster", type: "agent" }),
    prepareForRecovery: (state: unknown) => state,
    hasMatchingExecutionGeneration: () => true,
  },
});

await mock.module("../phase-config.js", {
  namedExports: {
    getPhaseConfig: async () => ({
      id: "Build",
      workers: [{ id: "taskmaster", type: "agent", source: "agents/taskmaster.md" }],
    }),
    getNextEnabledPhase: async () => null,
    phaseRequiresIsolation: async () => false,
  },
});

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicket: () => ({ executionGeneration: 2 }),
    listArtifacts: () => [],
    getArtifactContent: async () => "",
    getTicketsByBrainstormId: () => [],
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
    listTasks: () => phaseTasks,
    updateTaskStatus: () => {},
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
    getRalphIterations: () => [],
  },
});

await mock.module("../../../stores/ticket-dependency.store.js", {
  namedExports: {
    ticketDependencyGetForTicket: () => [],
  },
});

await mock.module("../loops/ralph-loop.js", {
  namedExports: {
    initRalphLoop: () => ({}),
    handleAgentCompletion: () => ({
      nextState: null,
      result: { status: "approved" },
    }),
    captureDoerSessionIdIfNeeded: () => {},
    getCurrentWorker: () => null,
    getCurrentWorkerIndex: () => 0,
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
const { buildAgentPrompt, formatContinuityHandoff } = await import("../prompts.js");

const callbacks = {
  spawnAgent: async (
    _projectId: string,
    _ticketId: string,
    _phase: string,
    _projectPath: string,
    _agentWorker: unknown,
    _taskContext?: unknown,
    _ralphContext?: unknown,
    phaseEntryContext?: unknown,
  ) => {
    spawnCalls.push({ phaseEntryContext });
    return "sess_123";
  },
  onPhaseComplete: async () => {},
  onTicketBlocked: async () => {},
};

describe("worker-executor phase entry context", () => {
  beforeEach(() => {
    phaseTasks = [];
    spawnCalls.length = 0;
  });

  it("marks entry as fresh when the phase has no actionable tasks", async () => {
    await startPhase("proj-1", "POT-1", "Build", "D:/tmp/project", callbacks);

    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(spawnCalls[0].phaseEntryContext, {
      mode: "fresh_entry",
      taskSummary: {
        totalInPhase: 0,
        actionableInPhase: 0,
        pendingCount: 0,
        inProgressCount: 0,
        failedCount: 0,
        completedCount: 0,
        cancelledCount: 0,
        sampleTasks: [],
      },
    });
  });

  it("marks entry as re-entry when actionable tasks already exist in phase", async () => {
    phaseTasks = [
      { id: "task-1", description: "Implement API", status: "pending" },
      { id: "task-2", description: "Wire UI", status: "completed" },
    ];

    await startPhase("proj-1", "POT-1", "Build", "D:/tmp/project", callbacks);

    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(spawnCalls[0].phaseEntryContext, {
      mode: "re_entry",
      taskSummary: {
        totalInPhase: 2,
        actionableInPhase: 1,
        pendingCount: 1,
        inProgressCount: 0,
        failedCount: 0,
        completedCount: 1,
        cancelledCount: 0,
        sampleTasks: [
          { id: "task-1", description: "Implement API", status: "pending" },
          { id: "task-2", description: "Wire UI", status: "completed" },
        ],
      },
    });
  });
});

describe("continuity handoff prompt formatting", () => {
  it("includes one continuity section before phase entry context with mode/reason/scope", async () => {
    const prompt = await buildAgentPrompt(
      "proj-1",
      "POT-1",
      {
        id: "POT-1",
        title: "Implement continuity",
        description: "Carry context between sessions",
      } as any,
      "Build",
      { id: "taskmaster", type: "agent", source: "agents/taskmaster.md" } as any,
      [],
      undefined,
      undefined,
      {
        mode: "re_entry",
        taskSummary: {
          totalInPhase: 2,
          actionableInPhase: 1,
          pendingCount: 1,
          inProgressCount: 0,
          failedCount: 0,
          completedCount: 1,
          cancelledCount: 0,
          sampleTasks: [{ id: "task-1", description: "Implement API", status: "pending" }],
        },
      },
      {
        mode: "handoff",
        reason: "packet_available",
        scope: "same_lifecycle",
        packet: {
          scope: "same_lifecycle",
          conversationTurns: [{ role: "user", text: "Please continue from last run." }],
          sessionHighlights: [{ summary: "Created initial scaffolding" }],
          unresolvedQuestions: ["Which API route should we use?"],
        },
      },
    );

    assert.strictEqual((prompt.match(/## Continuity Handoff/g) ?? []).length, 1);
    assert.ok(prompt.includes("- mode: handoff"));
    assert.ok(prompt.includes("- reason: packet_available"));
    assert.ok(prompt.includes("- scope: same_lifecycle"));
    assert.ok(prompt.indexOf("## Continuity Handoff") < prompt.indexOf("## Phase Entry Context"));
  });

  it("does not inject handoff content for resume mode decisions", () => {
    const section = formatContinuityHandoff({
      mode: "resume",
      reason: "same_lifecycle_resume",
      sourceSessionId: "claude_123",
    });

    assert.strictEqual(section, "");
  });
});
