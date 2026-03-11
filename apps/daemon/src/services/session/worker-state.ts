// src/services/session/worker-state.ts

import {
  getWorkerState as getWorkerStateFromStore,
  setWorkerState as setWorkerStateInStore,
  clearWorkerState as clearWorkerStateInStore,
} from "../../stores/ticket.store.js";
import type {
  ActiveWorkerStateRoot,
  OrchestrationState,
  SpawnPendingWorkerStateRoot,
  WorkerState,
  AgentState,
  RalphLoopState,
  TaskLoopState,
} from "../../types/orchestration.types.js";
import type { ContinuityPacket } from "./continuity.types.js";
import {
  isActiveWorkerStateRoot as isActiveRootGuard,
  isSpawnPendingWorkerStateRoot as isSpawnPendingRootGuard,
} from "../../types/orchestration.types.js";
import { listTasks } from "../../stores/task.store.js";
import { getTicket } from "../../stores/ticket.store.js";

interface LegacyOrchestrationState {
  phaseId?: unknown;
  executionGeneration?: unknown;
  workerIndex?: unknown;
  activeWorker?: unknown;
  updatedAt?: unknown;
}

function asLegacyState(value: unknown): LegacyOrchestrationState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as LegacyOrchestrationState;
}

function normalizeWorkerState(
  raw: unknown
): OrchestrationState | null {
  if (!raw) return null;

  if (isActiveRootGuard(raw) || isSpawnPendingRootGuard(raw)) {
    return raw;
  }

  const legacy = asLegacyState(raw);
  if (!legacy || typeof legacy.phaseId !== "string") {
    return null;
  }

  if (legacy.workerIndex !== undefined && legacy.activeWorker !== undefined) {
    return {
      kind: "active",
      phaseId: legacy.phaseId,
      // Legacy payloads without generation are treated as stale by comparison helpers.
      executionGeneration:
        typeof legacy.executionGeneration === "number"
          ? legacy.executionGeneration
          : -1,
      workerIndex:
        typeof legacy.workerIndex === "number" ? legacy.workerIndex : 0,
      activeWorker: (legacy.activeWorker as WorkerState | null) ?? null,
      updatedAt:
        typeof legacy.updatedAt === "string"
          ? legacy.updatedAt
          : new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Get the current orchestration state for a ticket
 */
export function getWorkerState(
  _projectId: string,
  ticketId: string
): OrchestrationState | null {
  return normalizeWorkerState(getWorkerStateFromStore(ticketId));
}

/**
 * Save orchestration state for a ticket
 */
export function saveWorkerState(
  _projectId: string,
  ticketId: string,
  state: OrchestrationState
): void {
  state.updatedAt = new Date().toISOString();
  setWorkerStateInStore(ticketId, state);
}

/**
 * Initialize orchestration state for a phase
 */
export function initWorkerState(
  projectId: string,
  ticketId: string,
  phaseId: string
): ActiveWorkerStateRoot {
  let ticketGeneration = 0;
  try {
    ticketGeneration = getTicket(projectId, ticketId).executionGeneration ?? 0;
  } catch {
    ticketGeneration = 0;
  }
  const state: ActiveWorkerStateRoot = {
    kind: "active",
    phaseId,
    executionGeneration: ticketGeneration,
    workerIndex: 0,
    activeWorker: null,
    updatedAt: new Date().toISOString(),
  };
  saveWorkerState(projectId, ticketId, state);
  return state;
}

/**
 * Clear orchestration state on phase completion
 * Note: File-based archiving is no longer done since state is in SQLite
 * and can be queried/archived through database mechanisms if needed.
 */
export function clearWorkerState(
  _projectId: string,
  ticketId: string
): void {
  clearWorkerStateInStore(ticketId);
}

/**
 * Create initial state for an agent worker
 */
export function createAgentState(workerId: string, sessionId?: string): AgentState {
  return {
    id: workerId,
    type: "agent",
    sessionId,
  };
}

/**
 * Create initial state for a ralphLoop worker
 */
export function createRalphLoopState(workerId: string, maxAttempts?: number): RalphLoopState {
  return {
    id: workerId,
    type: "ralphLoop",
    iteration: 1,
    maxAttempts,
    workerIndex: 0,
    activeWorker: null,
  };
}

/**
 * Create initial state for a taskLoop worker
 * Snapshots pending tasks from the task store
 */
export function createTaskLoopState(
  ticketId: string,
  workerId: string,
  phase: string
): TaskLoopState {
  // Snapshot all pending tasks for this phase
  const tasks = listTasks(ticketId, { phase });
  const pendingTasks = tasks
    .filter((t) => t.status === "pending")
    .map((t) => t.id);

  return {
    id: workerId,
    type: "taskLoop",
    currentTaskId: null,
    pendingTasks,
    completedTasks: [],
    workerIndex: 0,
    activeWorker: null,
  };
}

export function createSpawnPendingWorkerState(
  phaseId: string,
  executionGeneration: number,
  continuitySnapshot?: ContinuityPacket,
): SpawnPendingWorkerStateRoot {
  const now = new Date().toISOString();
  const state: SpawnPendingWorkerStateRoot = {
    kind: "spawn_pending",
    phaseId,
    executionGeneration,
    pendingSpawn: true,
    spawnRequestedAt: now,
    updatedAt: now,
  };
  if (continuitySnapshot) {
    state.continuitySnapshot = continuitySnapshot;
    state.continuitySnapshotCreatedAt = now;
  }
  return state;
}

export function consumeSpawnPendingContinuitySnapshot(
  projectId: string,
  ticketId: string,
  expectedPhase?: string,
  expectedGeneration?: number,
): ContinuityPacket | null {
  const state = getWorkerState(projectId, ticketId);
  if (!isSpawnPendingWorkerStateRoot(state)) {
    return null;
  }
  if (!state.continuitySnapshot) {
    return null;
  }
  if (expectedPhase && state.phaseId !== expectedPhase) {
    return null;
  }
  if (
    expectedGeneration !== undefined &&
    state.executionGeneration !== expectedGeneration
  ) {
    return null;
  }

  const snapshot = state.continuitySnapshot;
  const nextState: SpawnPendingWorkerStateRoot = {
    ...state,
    continuitySnapshot: undefined,
    continuitySnapshotCreatedAt: undefined,
  };
  saveWorkerState(projectId, ticketId, nextState);
  return snapshot;
}

export function isActiveWorkerStateRoot(
  state: OrchestrationState | null | undefined
): state is ActiveWorkerStateRoot {
  return isActiveRootGuard(state);
}

export function isSpawnPendingWorkerStateRoot(
  state: OrchestrationState | null | undefined
): state is SpawnPendingWorkerStateRoot {
  return isSpawnPendingRootGuard(state);
}

export function hasMatchingExecutionGeneration(
  state: OrchestrationState | null,
  ticketGeneration: number
): boolean {
  if (!state) return false;
  return state.executionGeneration === ticketGeneration;
}

/**
 * Check if there's a running agent (with sessionId) anywhere in the worker tree
 */
function hasRunningAgentInState(worker: WorkerState | null): boolean {
  if (!worker) return false;
  switch (worker.type) {
    case "agent":
      return !!(worker as AgentState).sessionId;
    case "ralphLoop":
      return hasRunningAgentInState((worker as RalphLoopState).activeWorker);
    case "taskLoop":
      return hasRunningAgentInState((worker as TaskLoopState).activeWorker);
    default:
      return false;
  }
}

/**
 * Check if worker state needs recovery action
 * - Running agent that crashed
 * - Ralph loop that exhausted max attempts
 */
function needsRecovery(worker: WorkerState | null): boolean {
  if (!worker) return false;

  // Check for running agent (existing logic)
  if (hasRunningAgentInState(worker)) return true;

  // Check for ralph loop at max attempts
  if (worker.type === "ralphLoop") {
    const loop = worker as RalphLoopState;
    if (loop.maxAttempts && loop.iteration >= loop.maxAttempts) return true;
    return needsRecovery(loop.activeWorker);
  }

  if (worker.type === "taskLoop") {
    return needsRecovery((worker as TaskLoopState).activeWorker);
  }

  return false;
}

/**
 * Recover a worker that had a running agent crash
 */
function recoverCrashedWorker(worker: WorkerState): WorkerState {
  switch (worker.type) {
    case "agent":
      // Clear session - will be re-spawned
      return { ...(worker as AgentState), sessionId: undefined };

    case "ralphLoop": {
      const loop = worker as RalphLoopState;

      // If at max attempts, reset for fresh retry
      if (loop.maxAttempts && loop.iteration >= loop.maxAttempts) {
        return {
          ...loop,
          iteration: 1,
          workerIndex: 0,
          activeWorker: null,
        };
      }

      // Otherwise, restart current iteration from beginning (existing behavior)
      return {
        ...loop,
        workerIndex: 0,
        activeWorker: null,
      };
    }

    case "taskLoop": {
      const loop = worker as TaskLoopState;

      // If nested worker needs recovery, recurse into it first
      if (loop.activeWorker && needsRecovery(loop.activeWorker)) {
        return {
          ...loop,
          activeWorker: recoverCrashedWorker(loop.activeWorker),
        };
      }

      // Re-queue current task (crash at task loop level)
      if (loop.currentTaskId) {
        return {
          ...loop,
          pendingTasks: [loop.currentTaskId, ...loop.pendingTasks],
          currentTaskId: null,
          workerIndex: 0,
          activeWorker: null,
        };
      }
      return loop;
    }

    default:
      return worker;
  }
}

/**
 * Prepare state for daemon restart recovery
 *
 * Only resets state if there was a running agent that crashed.
 * If no agent was running (previous work completed cleanly), preserves state as-is
 * so execution can continue from where it left off.
 */
export function prepareForRecovery(state: ActiveWorkerStateRoot): ActiveWorkerStateRoot {
  if (!state.activeWorker) return state;

  // Check if recovery is needed (crashed agent OR exhausted ralph loop)
  if (!needsRecovery(state.activeWorker)) {
    // No recovery needed, continue from current state
    return state;
  }

  // Recovery needed - reset appropriate worker state
  return {
    ...state,
    activeWorker: recoverCrashedWorker(state.activeWorker),
  };
}
