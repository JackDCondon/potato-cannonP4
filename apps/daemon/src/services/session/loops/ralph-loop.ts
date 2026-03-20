// src/services/session/loops/ralph-loop.ts

import { isAgentWorker } from "../../../types/template.types.js";
import type { RalphLoopWorker, AgentWorker, Worker } from "../../../types/template.types.js";
import type { RalphLoopState, WorkerState } from "../../../types/orchestration.types.js";
import { createRalphLoopState } from "../worker-state.js";

export interface RalphLoopResult {
  status: "continue" | "approved" | "maxAttempts";
  nextWorkerIndex?: number;
  nextIteration?: number;
}

/**
 * Initialize ralph loop state
 */
export function initRalphLoop(worker: RalphLoopWorker): RalphLoopState {
  return createRalphLoopState(worker.id, worker.maxAttempts);
}

/**
 * Get the current worker to execute in the ralph loop
 */
export function getCurrentWorker(
  worker: RalphLoopWorker,
  state: RalphLoopState
): Worker | null {
  const currentWorkerIndex = getCurrentWorkerIndex(worker, state);
  if (currentWorkerIndex === null) {
    return null;
  }
  return worker.workers[currentWorkerIndex];
}

export function getCurrentWorkerIndex(
  worker: RalphLoopWorker,
  state: RalphLoopState
): number | null {
  let currentWorkerIndex = state.workerIndex;

  while (currentWorkerIndex < worker.workers.length) {
    const currentWorker = worker.workers[currentWorkerIndex];
    if (
      state.iteration === 1 &&
      isAgentWorker(currentWorker) &&
      currentWorker.skipOnFirstIteration
    ) {
      currentWorkerIndex += 1;
      continue;
    }
    return currentWorkerIndex;
  }

  return null;
}

/**
 * Handle agent completion within ralph loop
 * Returns next action based on ralph_loop_dock verdict
 */
export function handleAgentCompletion(
  worker: RalphLoopWorker,
  state: RalphLoopState,
  exitCode: number,
  verdict: { approved: boolean; feedback?: string }
): { nextState: RalphLoopState; result: RalphLoopResult } {
  const currentWorkerIndex = getCurrentWorkerIndex(worker, state);
  const iterationRejected = Boolean(state.iterationRejected) || !verdict.approved;

  // Agent failed
  if (exitCode !== 0) {
    // Treat as revision needed, restart iteration
    if (state.iteration >= worker.maxAttempts) {
      return {
        nextState: state,
        result: { status: "maxAttempts" },
      };
    }
    return {
      nextState: {
        ...state,
        iteration: state.iteration + 1,
        iterationRejected: false,
        workerIndex: 0,
        activeWorker: null,
      },
      result: { status: "continue", nextWorkerIndex: 0, nextIteration: state.iteration + 1 },
    };
  }

  // Check if more workers in this iteration
  const nextWorkerIndex =
    currentWorkerIndex === null
      ? null
      : getCurrentWorkerIndex(worker, { ...state, workerIndex: currentWorkerIndex + 1 });
  if (nextWorkerIndex !== null) {
    return {
      nextState: {
        ...state,
        iterationRejected,
        workerIndex: nextWorkerIndex,
        activeWorker: null,
      },
      result: { status: "continue", nextWorkerIndex },
    };
  }

  // All workers completed for this iteration - check verdict
  if (!iterationRejected) {
    return {
      nextState: state,
      result: { status: "approved" },
    };
  }

  // Revision needed - check max attempts
  if (state.iteration >= worker.maxAttempts) {
    return {
      nextState: state,
      result: { status: "maxAttempts" },
    };
  }

  // Start next iteration
  return {
    nextState: {
      ...state,
      iteration: state.iteration + 1,
      iterationRejected: false,
      workerIndex: 0,
      activeWorker: null,
    },
    result: { status: "continue", nextWorkerIndex: 0, nextIteration: state.iteration + 1 },
  };
}

/**
 * Capture the doer agent's Claude session ID into RalphLoopState so it can be
 * passed to `--resume` on the next iteration. Only captures when the agent has
 * `resumeOnRalphRetry: true` (i.e. it is the "doer" agent, not the reviewer).
 *
 * Must be called with the session ID captured at spawn time — NOT re-read from
 * DB after PTY exit, because resumed sessions get a transient new ID.
 */
export function captureDoerSessionIdIfNeeded(
  ralphState: RalphLoopState,
  agentWorker: AgentWorker,
  claudeSessionId: string
): void {
  if (agentWorker.resumeOnRalphRetry) {
    ralphState.lastDoerClaudeSessionId = claudeSessionId;
  }
}
