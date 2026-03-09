// src/services/session/loops/task-loop.ts

import type { TaskLoopWorker, Worker } from "../../../types/template.types.js";
import type { TaskLoopState, TaskContext } from "../../../types/orchestration.types.js";
import type { Task } from "../../../types/task.types.js";
import { createTaskLoopState } from "../worker-state.js";
import { getTask, getTaskComments } from "../../../stores/task.store.js";

export interface TaskLoopResult {
  status: "continue" | "completed" | "taskFailed";
  nextTaskId?: string;
  failedTaskId?: string;
}

/**
 * Initialize task loop state with snapshot of pending tasks
 */
export function initTaskLoop(
  ticketId: string,
  worker: TaskLoopWorker,
  phase: string
): TaskLoopState {
  return createTaskLoopState(ticketId, worker.id, phase);
}

/**
 * Get the next task to process
 */
export function getNextTask(state: TaskLoopState): string | null {
  if (state.pendingTasks.length === 0) {
    return null;
  }
  return state.pendingTasks[0];
}

/**
 * Start processing a task - move from pending to current
 */
export function startTask(state: TaskLoopState, taskId: string): TaskLoopState {
  return {
    ...state,
    currentTaskId: taskId,
    pendingTasks: state.pendingTasks.filter((id) => id !== taskId),
    workerIndex: 0, // Reset to first worker for new task
    activeWorker: null,
  };
}

/**
 * Mark current task as completed
 */
export function completeTask(state: TaskLoopState): TaskLoopState {
  if (!state.currentTaskId) return state;

  return {
    ...state,
    completedTasks: [...state.completedTasks, state.currentTaskId],
    currentTaskId: null,
    workerIndex: 0, // Reset for next task
    activeWorker: null,
  };
}

/**
 * Advance to next worker in the task loop
 */
export function advanceWorkerIndex(state: TaskLoopState): TaskLoopState {
  return {
    ...state,
    workerIndex: state.workerIndex + 1,
    activeWorker: null,
  };
}

/**
 * Handle completion of nested workers for current task
 */
export function handleTaskWorkersComplete(
  state: TaskLoopState,
  success: boolean
): { nextState: TaskLoopState; result: TaskLoopResult } {
  if (!success) {
    // Task failed
    return {
      nextState: state,
      result: { status: "taskFailed", failedTaskId: state.currentTaskId || undefined },
    };
  }

  // Task succeeded - mark complete and check for more
  const completedState = completeTask(state);
  const nextTaskId = getNextTask(completedState);

  if (nextTaskId) {
    return {
      nextState: startTask(completedState, nextTaskId),
      result: { status: "continue", nextTaskId },
    };
  }

  // All tasks complete
  return {
    nextState: completedState,
    result: { status: "completed" },
  };
}

/**
 * Build task context for prompt injection
 */
export function buildTaskContext(taskId: string): TaskContext {
  const task = getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const comments = getTaskComments(taskId);

  return {
    taskId: task.id,
    phase: task.phase,
    status: task.status,
    attempt_count: task.attemptCount,
    description: task.description,
    body: task.body,
    comments: comments.map((c) => ({
      text: c.text,
      createdAt: c.createdAt,
    })),
    complexity: task.complexity,
  };
}

/**
 * Format task context for prompt injection
 */
export function formatTaskContext(context: TaskContext): string {
  let output = `## Current Task

- **taskId**: ${context.taskId}
- **phase**: ${context.phase}
- **status**: ${context.status}
- **attempt_count**: ${context.attempt_count}
- **description**: ${context.description}`;

  if (context.body) {
    output += `\n\n### Implementation Details\n\n${context.body}`;
  }

  if (context.comments.length > 0) {
    output += "\n\n### Comments\n";
    for (const comment of context.comments) {
      const date = new Date(comment.createdAt).toISOString().split("T")[0];
      output += `- [${date}] ${comment.text}\n`;
    }
  }

  return output;
}
