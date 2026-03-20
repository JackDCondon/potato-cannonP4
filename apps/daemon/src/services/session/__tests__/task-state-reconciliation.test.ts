import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActiveWorkerStateRoot, TaskLoopState } from "../../../types/orchestration.types.js";
import type { Task } from "../../../types/task.types.js";
import {
  buildTaskLoopRepairPlan,
  findActiveTaskLoopState,
  reconcileTaskLoopState,
} from "../task-state-reconciliation.js";

function makeTask(
  id: string,
  status: Task["status"],
  phase = "Build",
): Task {
  return {
    id,
    ticketId: "POT-1",
    displayNumber: Number(id.replace(/\D/g, "")) || 0,
    phase,
    status,
    attemptCount: 0,
    description: id,
    complexity: "standard",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
  };
}

function makeRoot(taskLoopState: TaskLoopState): ActiveWorkerStateRoot {
  return {
    kind: "active",
    phaseId: "Build",
    executionGeneration: 1,
    workerIndex: 0,
    activeWorker: taskLoopState,
    updatedAt: "2026-03-20T00:00:00.000Z",
  };
}

describe("findActiveTaskLoopState", () => {
  it("returns the nested task loop state from an active root", () => {
    const taskLoopState: TaskLoopState = {
      id: "task-loop",
      type: "taskLoop",
      currentTaskId: "task-10",
      pendingTasks: ["task-11"],
      completedTasks: ["task-9"],
      workerIndex: 0,
      activeWorker: null,
    };

    const result = findActiveTaskLoopState(makeRoot(taskLoopState));
    assert.deepStrictEqual(result, taskLoopState);
  });
});

describe("reconcileTaskLoopState", () => {
  it("accepts matching worker state and task rows", () => {
    const state = makeRoot({
      id: "task-loop",
      type: "taskLoop",
      currentTaskId: "task-10",
      pendingTasks: ["task-11"],
      completedTasks: ["task-9"],
      workerIndex: 0,
      activeWorker: null,
    });

    const result = reconcileTaskLoopState(
      state,
      [makeTask("task-9", "completed"), makeTask("task-10", "in_progress"), makeTask("task-11", "pending")],
    );

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.issues, []);
  });

  it("rejects future tasks that are completed while still pending in worker state", () => {
    const state = makeRoot({
      id: "task-loop",
      type: "taskLoop",
      currentTaskId: "task-10",
      pendingTasks: ["task-11"],
      completedTasks: ["task-9"],
      workerIndex: 0,
      activeWorker: null,
    });

    const result = reconcileTaskLoopState(
      state,
      [makeTask("task-9", "completed"), makeTask("task-10", "in_progress"), makeTask("task-11", "completed")],
    );

    assert.equal(result.ok, false);
    assert.match(result.issues[0] ?? "", /pending.*task-11/i);
  });
});

describe("buildTaskLoopRepairPlan", () => {
  it("derives expected statuses from task-loop state", () => {
    const taskLoopState: TaskLoopState = {
      id: "task-loop",
      type: "taskLoop",
      currentTaskId: "task-10",
      pendingTasks: ["task-11", "task-12"],
      completedTasks: ["task-9"],
      workerIndex: 0,
      activeWorker: null,
    };

    const result = buildTaskLoopRepairPlan(
      taskLoopState,
      [makeTask("task-9", "completed"), makeTask("task-10", "pending"), makeTask("task-11", "completed"), makeTask("task-12", "pending")],
    );

    assert.deepStrictEqual(result, [
      { taskId: "task-10", expectedStatus: "in_progress", currentStatus: "pending" },
      { taskId: "task-11", expectedStatus: "pending", currentStatus: "completed" },
    ]);
  });
});
