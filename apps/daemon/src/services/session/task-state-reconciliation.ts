import type {
  ActiveWorkerStateRoot,
  OrchestrationState,
  RalphLoopState,
  TaskLoopState,
  WorkerState,
} from "../../types/orchestration.types.js";
import type { Task, TaskStatus } from "../../types/task.types.js";

const TRUSTED_AGENT_SOURCES = new Set([
  "agents/taskmaster.md",
  "agents/task-review.md",
  "agents/project-manager.md",
]);

const RESTRICTED_TASK_STATUSES = new Set<TaskStatus>([
  "in_progress",
  "failed",
  "completed",
]);

function findTaskLoopInWorker(worker: WorkerState | null): TaskLoopState | null {
  if (!worker) {
    return null;
  }

  if (worker.type === "taskLoop") {
    return worker;
  }

  if (worker.type === "ralphLoop") {
    return findTaskLoopInWorker((worker as RalphLoopState).activeWorker);
  }

  return null;
}

export function findActiveTaskLoopState(
  state: OrchestrationState | null | undefined,
): TaskLoopState | null {
  if (!state || state.kind !== "active") {
    return null;
  }

  return findTaskLoopInWorker(state.activeWorker);
}

function taskStatusMap(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

export function reconcileTaskLoopState(
  state: ActiveWorkerStateRoot | null | undefined,
  phaseTasks: Task[],
): { ok: boolean; issues: string[] } {
  const taskLoopState = findActiveTaskLoopState(state);
  if (!taskLoopState) {
    return { ok: true, issues: [] };
  }

  const tasksById = taskStatusMap(phaseTasks);
  const issues: string[] = [];

  for (const taskId of taskLoopState.completedTasks) {
    const task = tasksById.get(taskId);
    if (!task) {
      issues.push(`Completed task ${taskId} is missing from persisted task rows`);
      continue;
    }
    if (task.status !== "completed") {
      issues.push(`Completed task ${taskId} has persisted status ${task.status}`);
    }
  }

  if (taskLoopState.currentTaskId) {
    const currentTask = tasksById.get(taskLoopState.currentTaskId);
    if (!currentTask) {
      issues.push(`Current task ${taskLoopState.currentTaskId} is missing from persisted task rows`);
    } else if (currentTask.status === "completed" || currentTask.status === "cancelled") {
      issues.push(`Current task ${taskLoopState.currentTaskId} has invalid persisted status ${currentTask.status}`);
    }
  }

  for (const taskId of taskLoopState.pendingTasks) {
    const task = tasksById.get(taskId);
    if (!task) {
      issues.push(`Pending task ${taskId} is missing from persisted task rows`);
      continue;
    }
    if (task.status === "completed" || task.status === "in_progress") {
      issues.push(`Pending task ${taskId} has invalid persisted status ${task.status}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

export function buildTaskLoopRepairPlan(
  taskLoopState: TaskLoopState,
  phaseTasks: Task[],
): Array<{ taskId: string; expectedStatus: TaskStatus; currentStatus: TaskStatus }> {
  const expectedStatuses = new Map<string, TaskStatus>();

  for (const taskId of taskLoopState.completedTasks) {
    expectedStatuses.set(taskId, "completed");
  }
  if (taskLoopState.currentTaskId) {
    expectedStatuses.set(taskLoopState.currentTaskId, "in_progress");
  }
  for (const taskId of taskLoopState.pendingTasks) {
    if (!expectedStatuses.has(taskId)) {
      expectedStatuses.set(taskId, "pending");
    }
  }

  return phaseTasks
    .map((task) => ({
      taskId: task.id,
      expectedStatus: expectedStatuses.get(task.id),
      currentStatus: task.status,
    }))
    .filter(
      (
        item,
      ): item is { taskId: string; expectedStatus: TaskStatus; currentStatus: TaskStatus } =>
        item.expectedStatus !== undefined && item.expectedStatus !== item.currentStatus,
    );
}

export function evaluateTaskStatusUpdatePermission(args: {
  agentSource?: string;
  taskId: string;
  nextStatus: TaskStatus;
  orchestrationState: ActiveWorkerStateRoot | null | undefined;
  phaseTasks: Task[];
}): { allowed: boolean; reason?: string } {
  if (!args.agentSource || TRUSTED_AGENT_SOURCES.has(args.agentSource)) {
    return { allowed: true };
  }

  const taskLoopState = findActiveTaskLoopState(args.orchestrationState);
  if (!taskLoopState) {
    return { allowed: true };
  }

  const reconciliation = reconcileTaskLoopState(args.orchestrationState, args.phaseTasks);
  if (!reconciliation.ok) {
    return {
      allowed: false,
      reason: `Task state is inconsistent with worker state: ${reconciliation.issues.join("; ")}`,
    };
  }

  if (!RESTRICTED_TASK_STATUSES.has(args.nextStatus)) {
    return {
      allowed: false,
      reason: `Restricted agents may only set ${Array.from(RESTRICTED_TASK_STATUSES).join(", ")} on the current orchestrated task`,
    };
  }

  if (taskLoopState.currentTaskId !== args.taskId) {
    return {
      allowed: false,
      reason: `Restricted agents may only update the current orchestrated task (${taskLoopState.currentTaskId ?? "none"})`,
    };
  }

  return { allowed: true };
}
