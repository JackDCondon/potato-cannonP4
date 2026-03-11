import { describe, it } from "node:test";
import assert from "node:assert";
import type {
  ActiveWorkerStateRoot,
  OrchestrationState,
  RalphLoopState,
  TaskLoopState,
} from "../../../types/orchestration.types.js";
import {
  isActiveWorkerStateRoot,
  isSpawnPendingWorkerStateRoot,
} from "../../../types/orchestration.types.js";

describe("prepareForRecovery", () => {
  // Dynamic import to get the actual implementation
  const getModule = async () => import("../worker-state.js");

  it("should reset ralph loop when iteration >= maxAttempts", async () => {
    const { prepareForRecovery } = await getModule();

    const state: ActiveWorkerStateRoot = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: 3,
      workerIndex: 0,
      activeWorker: {
        id: "test-ralph-loop",
        type: "ralphLoop",
        iteration: 2,
        maxAttempts: 2,
        workerIndex: 2,
        activeWorker: { id: "verifier", type: "agent" },
      } as RalphLoopState,
      updatedAt: new Date().toISOString(),
    };

    const result = prepareForRecovery(state);
    const ralphState = result.activeWorker as RalphLoopState;

    assert.strictEqual(ralphState.iteration, 1, "iteration should reset to 1");
    assert.strictEqual(ralphState.workerIndex, 0, "workerIndex should reset to 0");
    assert.strictEqual(ralphState.activeWorker, null, "activeWorker should be null");
  });

  it("should preserve iteration when below maxAttempts", async () => {
    const { prepareForRecovery } = await getModule();

    const state: ActiveWorkerStateRoot = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: 3,
      workerIndex: 0,
      activeWorker: {
        id: "test-ralph-loop",
        type: "ralphLoop",
        iteration: 1,
        maxAttempts: 2,
        workerIndex: 1,
        activeWorker: { id: "agent", type: "agent", sessionId: "sess_123" },
      } as RalphLoopState,
      updatedAt: new Date().toISOString(),
    };

    const result = prepareForRecovery(state);
    const ralphState = result.activeWorker as RalphLoopState;

    // Has running agent, so workerIndex resets but iteration preserved
    assert.strictEqual(ralphState.iteration, 1, "iteration should stay 1");
    assert.strictEqual(ralphState.workerIndex, 0, "workerIndex should reset to 0");
  });

  it("should handle ralph loop without maxAttempts (backward compat)", async () => {
    const { prepareForRecovery } = await getModule();

    const state: ActiveWorkerStateRoot = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: 3,
      workerIndex: 0,
      activeWorker: {
        id: "test-ralph-loop",
        type: "ralphLoop",
        iteration: 2,
        // No maxAttempts field
        workerIndex: 2,
        activeWorker: { id: "verifier", type: "agent" },
      } as RalphLoopState,
      updatedAt: new Date().toISOString(),
    };

    const result = prepareForRecovery(state);

    // No running agent and no maxAttempts, should return unchanged
    assert.strictEqual(result, state, "state should be unchanged");
  });

  it("should reset nested ralph loop inside task loop", async () => {
    const { prepareForRecovery } = await getModule();

    const state: ActiveWorkerStateRoot = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: 3,
      workerIndex: 1,
      activeWorker: {
        id: "task-loop",
        type: "taskLoop",
        currentTaskId: "task-123",
        pendingTasks: ["task-456"],
        completedTasks: ["task-000"],
        workerIndex: 0,
        activeWorker: {
          id: "build-ralph-loop",
          type: "ralphLoop",
          iteration: 2,
          maxAttempts: 2,
          workerIndex: 2,
          activeWorker: { id: "verifier", type: "agent" },
        } as RalphLoopState,
      } as TaskLoopState,
      updatedAt: new Date().toISOString(),
    };

    const result = prepareForRecovery(state);
    const taskState = result.activeWorker as TaskLoopState;
    const ralphState = taskState.activeWorker as RalphLoopState;

    // Task loop state preserved
    assert.strictEqual(taskState.currentTaskId, "task-123");
    assert.deepStrictEqual(taskState.pendingTasks, ["task-456"]);
    assert.deepStrictEqual(taskState.completedTasks, ["task-000"]);

    // Ralph loop reset
    assert.strictEqual(ralphState.iteration, 1);
    assert.strictEqual(ralphState.workerIndex, 0);
    assert.strictEqual(ralphState.activeWorker, null);
  });
});

describe("worker state root guards and generation helpers", () => {
  const getModule = async () => import("../worker-state.js");

  it("detects active and spawn_pending root kinds", () => {
    const active: OrchestrationState = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: 2,
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    };
    const pending: OrchestrationState = {
      kind: "spawn_pending",
      phaseId: "Build",
      executionGeneration: 2,
      pendingSpawn: true,
      spawnRequestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    assert.equal(isActiveWorkerStateRoot(active), true);
    assert.equal(isSpawnPendingWorkerStateRoot(active), false);
    assert.equal(isActiveWorkerStateRoot(pending), false);
    assert.equal(isSpawnPendingWorkerStateRoot(pending), true);
  });

  it("treats legacy root without generation as stale for generation checks", async () => {
    const { hasMatchingExecutionGeneration } = await getModule();
    const legacyLike = {
      kind: "active",
      phaseId: "Build",
      executionGeneration: -1,
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    } as ActiveWorkerStateRoot;

    assert.equal(hasMatchingExecutionGeneration(legacyLike, 0), false);
    assert.equal(hasMatchingExecutionGeneration(legacyLike, 7), false);
  });

  it("createSpawnPendingWorkerState sets required marker fields", async () => {
    const { createSpawnPendingWorkerState } = await getModule();
    const state = createSpawnPendingWorkerState("Build", 9);

    assert.equal(state.kind, "spawn_pending");
    assert.equal(state.phaseId, "Build");
    assert.equal(state.executionGeneration, 9);
    assert.equal(state.pendingSpawn, true);
    assert.ok(state.spawnRequestedAt);
  });

  it("createSpawnPendingWorkerState preserves optional continuity snapshot payload", async () => {
    const { createSpawnPendingWorkerState } = await getModule();
    const state = createSpawnPendingWorkerState("Build", 9, {
      scope: "safe_user_context_only",
      reasonForRestart: "manual restart",
      conversationTurns: [{ role: "user", text: "Keep this context" }],
      sessionHighlights: [],
      unresolvedQuestions: [],
    });

    assert.ok(state.continuitySnapshot);
    assert.equal(state.continuitySnapshot?.scope, "safe_user_context_only");
    assert.ok(state.continuitySnapshotCreatedAt);
  });
});
