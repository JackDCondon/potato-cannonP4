// src/types/orchestration.types.ts

import type { Complexity } from "@potato-cannon/shared";
import type { Task } from "./task.types.js";
import type { ContinuityPacket } from "../services/session/continuity.types.js";

/**
 * Base state for any active worker
 */
export interface BaseWorkerState {
  id: string;
  type: "agent" | "ralphLoop" | "taskLoop";
}

/**
 * State for an active agent
 */
export interface AgentState extends BaseWorkerState {
  type: "agent";
  sessionId?: string;
}

/**
 * State for an active ralphLoop
 */
export interface RalphLoopState extends BaseWorkerState {
  type: "ralphLoop";
  iteration: number;
  maxAttempts?: number;
  iterationRejected?: boolean;
  workerIndex: number;
  activeWorker: WorkerState | null;
  lastDoerClaudeSessionId?: string;
}

/**
 * State for an active taskLoop
 */
export interface TaskLoopState extends BaseWorkerState {
  type: "taskLoop";
  currentTaskId: string | null;
  pendingTasks: string[];
  completedTasks: string[];
  workerIndex: number; // Tracks progress through workers array for current task
  activeWorker: WorkerState | null;
}

export type WorkerState = AgentState | RalphLoopState | TaskLoopState;

/**
 * Top-level orchestration state for a ticket
 */
export interface ActiveWorkerStateRoot {
  kind: "active";
  phaseId: string;
  executionGeneration: number;
  workerIndex: number;
  activeWorker: WorkerState | null;
  updatedAt: string;
}

export interface SpawnPendingWorkerStateRoot {
  kind: "spawn_pending";
  phaseId: string;
  executionGeneration: number;
  pendingSpawn: true;
  continuitySnapshot?: ContinuityPacket;
  continuitySnapshotCreatedAt?: string;
  spawnRequestedAt: string;
  updatedAt: string;
}

export type OrchestrationState = ActiveWorkerStateRoot | SpawnPendingWorkerStateRoot;

/**
 * Task context injected into agent prompts when running inside a taskLoop
 */
export interface TaskContext {
  taskId: string;
  phase: string;
  status: string;
  attempt_count: number;
  description: string;
  body?: string;
  comments: Array<{ text: string; createdAt: string }>;
  complexity?: Complexity;
}

// Type guards
export function isAgentState(state: WorkerState): state is AgentState {
  return state.type === "agent";
}

export function isRalphLoopState(state: WorkerState): state is RalphLoopState {
  return state.type === "ralphLoop";
}

export function isTaskLoopState(state: WorkerState): state is TaskLoopState {
  return state.type === "taskLoop";
}

export function isActiveWorkerStateRoot(
  state: unknown
): state is ActiveWorkerStateRoot {
  return !!state && typeof state === "object" && (state as { kind?: string }).kind === "active";
}

export function isSpawnPendingWorkerStateRoot(
  state: unknown
): state is SpawnPendingWorkerStateRoot {
  return !!state && typeof state === "object" && (state as { kind?: string }).kind === "spawn_pending";
}
