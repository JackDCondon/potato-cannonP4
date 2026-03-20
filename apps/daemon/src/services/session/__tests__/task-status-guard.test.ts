import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActiveWorkerStateRoot } from "../../../types/orchestration.types.js";
import type { Task } from "../../../types/task.types.js";
import { evaluateTaskStatusUpdatePermission } from "../task-state-reconciliation.js";

function makeTask(id: string, status: Task["status"]): Task {
  return {
    id,
    ticketId: "POT-1",
    displayNumber: Number(id.replace(/\D/g, "")) || 0,
    phase: "Build",
    status,
    attemptCount: 0,
    description: id,
    complexity: "standard",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
  };
}

function makeState(): ActiveWorkerStateRoot {
  return {
    kind: "active",
    phaseId: "Build",
    executionGeneration: 1,
    workerIndex: 0,
    updatedAt: "2026-03-20T00:00:00.000Z",
    activeWorker: {
      id: "build-task-loop",
      type: "taskLoop",
      currentTaskId: "task-10",
      pendingTasks: ["task-11"],
      completedTasks: ["task-9"],
      workerIndex: 0,
      activeWorker: null,
    },
  };
}

describe("evaluateTaskStatusUpdatePermission", () => {
  const phaseTasks = [
    makeTask("task-9", "completed"),
    makeTask("task-10", "in_progress"),
    makeTask("task-11", "pending"),
  ];

  it("allows restricted agents to update only the current task", () => {
    const result = evaluateTaskStatusUpdatePermission({
      agentSource: "agents/builder.md",
      taskId: "task-10",
      nextStatus: "completed",
      orchestrationState: makeState(),
      phaseTasks,
    });

    assert.equal(result.allowed, true);
  });

  it("rejects restricted agents updating future tasks", () => {
    const result = evaluateTaskStatusUpdatePermission({
      agentSource: "agents/builder.md",
      taskId: "task-11",
      nextStatus: "completed",
      orchestrationState: makeState(),
      phaseTasks,
    });

    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /current orchestrated task/i);
  });

  it("allows trusted agents to update tasks outside the current task loop position", () => {
    const result = evaluateTaskStatusUpdatePermission({
      agentSource: "agents/taskmaster.md",
      taskId: "task-11",
      nextStatus: "completed",
      orchestrationState: makeState(),
      phaseTasks,
    });

    assert.equal(result.allowed, true);
  });

  it("rejects restricted updates when task-loop state is already inconsistent", () => {
    const result = evaluateTaskStatusUpdatePermission({
      agentSource: "agents/builder.md",
      taskId: "task-10",
      nextStatus: "completed",
      orchestrationState: makeState(),
      phaseTasks: [
        makeTask("task-9", "completed"),
        makeTask("task-10", "in_progress"),
        makeTask("task-11", "completed"),
      ],
    });

    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /inconsistent/i);
  });
});
