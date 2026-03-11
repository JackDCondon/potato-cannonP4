// src/services/session/worker-executor.ts

import fs from "fs";
import { spawnSync } from "child_process";
import type { TicketPhase } from "../../types/ticket.types.js";
import type {
  Phase,
  Worker,
  AgentWorker,
  RalphLoopWorker,
  TaskLoopWorker,
} from "../../types/template.types.js";
import {
  isAgentWorker,
  isRalphLoopWorker,
  isTaskLoopWorker,
} from "../../types/template.types.js";
import type {
  ActiveWorkerStateRoot,
  OrchestrationState,
  WorkerState,
  RalphLoopState,
  TaskLoopState,
  TaskContext,
} from "../../types/orchestration.types.js";
import { isActiveWorkerStateRoot as isActiveRoot } from "../../types/orchestration.types.js";
import {
  getWorkerState,
  saveWorkerState,
  initWorkerState,
  clearWorkerState,
  createAgentState,
  prepareForRecovery,
  hasMatchingExecutionGeneration,
} from "./worker-state.js";
import { initRalphLoop, handleAgentCompletion as handleRalphLoopAgentCompletion } from "./loops/ralph-loop.js";
import {
  initTaskLoop,
  getNextTask,
  startTask,
  advanceWorkerIndex,
  handleTaskWorkersComplete,
  buildTaskContext,
} from "./loops/task-loop.js";
import { getPhaseConfig, getNextEnabledPhase, phaseRequiresIsolation } from "./phase-config.js";
import { getTicket } from "../../stores/ticket.store.js";
import { getProjectById } from "../../stores/project.store.js";
import { readQuestion, clearQuestion } from "../../stores/chat.store.js";
import { listTasks, updateTaskStatus } from "../../stores/task.store.js";
import { logToDaemon } from "./ticket-logger.js";
import {
  createRalphFeedback,
  addRalphIteration,
  updateRalphFeedbackStatus,
  getRalphFeedbackForLoop,
} from "../../stores/ralph-feedback.store.js";
import type { SessionCallbackIdentity } from "./types.js";
import type { PhaseEntryContext, PhaseEntryTaskSummary } from "./types.js";

/**
 * Callbacks for spawning sessions and handling transitions
 */
export interface ExecutorCallbacks {
  spawnAgent: (
    projectId: string,
    ticketId: string,
    phase: TicketPhase,
    projectPath: string,
    agentWorker: AgentWorker,
    taskContext?: TaskContext,
    ralphContext?: { phaseId: string; ralphLoopId: string; taskId: string | null },
    phaseEntryContext?: PhaseEntryContext,
  ) => Promise<string>;
  onPhaseComplete: (
    projectId: string,
    ticketId: string,
    phase: TicketPhase,
    projectPath: string
  ) => Promise<void>;
  onTicketBlocked: (
    projectId: string,
    ticketId: string,
    reason: string
  ) => Promise<void>;
}

function buildPhaseEntryTaskSummary(
  ticketId: string,
  phase: TicketPhase,
): PhaseEntryTaskSummary {
  const phaseTasks = listTasks(ticketId, { phase });
  const pendingCount = phaseTasks.filter((task) => task.status === "pending").length;
  const inProgressCount = phaseTasks.filter((task) => task.status === "in_progress").length;
  const failedCount = phaseTasks.filter((task) => task.status === "failed").length;
  const completedCount = phaseTasks.filter((task) => task.status === "completed").length;
  const cancelledCount = phaseTasks.filter((task) => task.status === "cancelled").length;
  const actionableInPhase = pendingCount + inProgressCount + failedCount;

  return {
    totalInPhase: phaseTasks.length,
    actionableInPhase,
    pendingCount,
    inProgressCount,
    failedCount,
    completedCount,
    cancelledCount,
    sampleTasks: phaseTasks.slice(0, 5).map((task) => ({
      id: task.id,
      description: task.description,
      status: task.status,
    })),
  };
}

/**
 * Count taskLoops in a worker tree (for validation)
 */
function countTaskLoops(workers: Worker[]): number {
  let count = 0;
  for (const worker of workers) {
    if (isTaskLoopWorker(worker)) {
      count++;
    }
    if (isRalphLoopWorker(worker) || isTaskLoopWorker(worker)) {
      count += countTaskLoops(worker.workers);
    }
  }
  return count;
}

/**
 * Find taskLoop state by walking down the state tree
 * Used to get task context for nested agents (e.g., taskLoop > ralphLoop > agent)
 */
function findTaskLoopInState(workerState: WorkerState | null): TaskLoopState | null {
  if (!workerState) return null;

  if (workerState.type === "taskLoop") {
    return workerState as TaskLoopState;
  }

  if (workerState.type === "ralphLoop") {
    const ralphState = workerState as RalphLoopState;
    return findTaskLoopInState(ralphState.activeWorker);
  }

  return null;
}

/**
 * Get active task ID from state if inside a task loop
 */
function getActiveTaskId(state: OrchestrationState): string | null {
  if (!isActiveRoot(state) || !state.activeWorker) return null;
  if (state.activeWorker.type === "taskLoop") {
    return (state.activeWorker as TaskLoopState).currentTaskId;
  }
  return null;
}

/**
 * Get ralph context from state if inside a ralph loop
 * Used to inject previous feedback into agent prompts
 */
function getRalphContext(
  state: OrchestrationState,
  phase: string
): { phaseId: string; ralphLoopId: string; taskId: string | null } | undefined {
  if (!isActiveRoot(state) || !state.activeWorker) return undefined;

  // Direct ralph loop
  if (state.activeWorker.type === "ralphLoop") {
    return {
      phaseId: phase,
      ralphLoopId: state.activeWorker.id,
      taskId: null,
    };
  }

  // Ralph loop nested in task loop
  if (state.activeWorker.type === "taskLoop") {
    const taskState = state.activeWorker as TaskLoopState;
    if (taskState.activeWorker?.type === "ralphLoop") {
      return {
        phaseId: phase,
        ralphLoopId: taskState.activeWorker.id,
        taskId: taskState.currentTaskId,
      };
    }
  }

  return undefined;
}

/**
 * Validate phase has at most one taskLoop
 */
export function validatePhaseWorkers(phase: Phase): void {
  const taskLoopCount = countTaskLoops(phase.workers);
  if (taskLoopCount > 1) {
    throw new Error(`Phase "${phase.id}" has ${taskLoopCount} taskLoops, maximum is 1`);
  }
}

/**
 * Get the current worker to execute based on state
 */
function getCurrentWorker(
  workers: Worker[],
  state: ActiveWorkerStateRoot
): { worker: Worker; path: string[] } | null {
  if (state.workerIndex >= workers.length) {
    return null;
  }

  const topWorker = workers[state.workerIndex];

  if (!state.activeWorker) {
    return { worker: topWorker, path: [topWorker.id] };
  }

  // Traverse into active worker
  return getNestedCurrentWorker(topWorker, state.activeWorker, [topWorker.id]);
}

function getNestedCurrentWorker(
  worker: Worker,
  activeState: WorkerState,
  path: string[]
): { worker: Worker; path: string[] } | null {
  if (isAgentWorker(worker)) {
    return { worker, path };
  }

  if (isRalphLoopWorker(worker) && activeState.type === "ralphLoop") {
    const ralphState = activeState as RalphLoopState;
    if (!ralphState.activeWorker) {
      const currentWorker = worker.workers[ralphState.workerIndex];
      if (currentWorker) {
        return { worker: currentWorker, path: [...path, currentWorker.id] };
      }
      return null;
    }
    const nestedWorker = worker.workers[ralphState.workerIndex];
    return getNestedCurrentWorker(nestedWorker, ralphState.activeWorker, [...path, nestedWorker.id]);
  }

  if (isTaskLoopWorker(worker) && activeState.type === "taskLoop") {
    const taskState = activeState as TaskLoopState;
    if (!taskState.activeWorker) {
      // Return current worker based on workerIndex
      const currentWorker = worker.workers[taskState.workerIndex];
      if (currentWorker) {
        return { worker: currentWorker, path: [...path, currentWorker.id] };
      }
      return null;
    }
    // Find nested active worker using workerIndex
    const nestedWorker = worker.workers[taskState.workerIndex];
    if (nestedWorker && nestedWorker.id === taskState.activeWorker.id) {
      return getNestedCurrentWorker(nestedWorker, taskState.activeWorker, [...path, nestedWorker.id]);
    }
  }

  return null;
}

/**
 * Validate P4 prerequisites before starting an isolation phase.
 * Returns an error message string if validation fails, or null if all checks pass.
 * Skips validation entirely for Git projects (no p4Stream set).
 */
export function validateP4Prerequisites(projectId: string): string | null {
  const project = getProjectById(projectId);

  // Git project — skip P4 validation
  if (!project?.p4Stream) {
    return null;
  }
  if (!project.p4Stream.trim()) {
    return "P4 pre-build validation failed: p4Stream is empty.";
  }

  // Check 1: agentWorkspaceRoot non-empty
  if (!project.agentWorkspaceRoot || !project.agentWorkspaceRoot.trim()) {
    return "P4 pre-build validation failed: project agentWorkspaceRoot is not set.";
  }

  // Check 3: agentWorkspaceRoot directory exists or is creatable
  const workspaceRoot = project.agentWorkspaceRoot;
  try {
    fs.accessSync(workspaceRoot, fs.constants.F_OK);
  } catch {
    // Directory does not exist — try to create it
    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
    } catch (mkdirErr) {
      return `P4 pre-build validation failed: agentWorkspaceRoot "${workspaceRoot}" does not exist and could not be created: ${(mkdirErr as Error).message}`;
    }
  }

  // Check 4: P4 CLI on PATH and server reachable
  const p4Result = spawnSync("p4", ["info"], { encoding: "utf-8" });
  if (p4Result.status !== 0) {
    const stderr = p4Result.stderr?.trim() || "";
    const detail = stderr || (p4Result.error ? p4Result.error.message : "non-zero exit code");
    return `P4 pre-build validation failed: "p4 info" exited with error — ${detail}. Ensure the P4 CLI is on PATH and the Perforce server is reachable.`;
  }

  return null;
}

/**
 * Start execution of a phase
 */
export async function startPhase(
  projectId: string,
  ticketId: string,
  phase: TicketPhase,
  projectPath: string,
  callbacks: ExecutorCallbacks
): Promise<string | null> {
  const phaseConfig = await getPhaseConfig(projectId, phase);
  if (!phaseConfig) {
    console.log(`[WorkerExecutor] No phase config for ${phase}`);
    return null;
  }

  // Clear any stale pending question from a previous suspended session
  // This prevents a new phase execution from being misidentified as suspended on exit
  await clearQuestion(projectId, ticketId);

  // Run P4 pre-build validation for isolation phases
  const needsIsolation = await phaseRequiresIsolation(projectId, phase);
  if (needsIsolation) {
    const validationError = validateP4Prerequisites(projectId);
    if (validationError) {
      await logToDaemon(projectId, ticketId, validationError);
      await callbacks.onTicketBlocked(projectId, ticketId, validationError);
      return null;
    }
  }

  // Validate phase
  validatePhaseWorkers(phaseConfig);

  // Check for existing state (recovery)
  let state = await getWorkerState(projectId, ticketId);
  const ticket = getTicket(projectId, ticketId);
  const ticketGeneration = ticket?.executionGeneration ?? 0;
  if (
    state &&
    isActiveRoot(state) &&
    state.phaseId === phase &&
    hasMatchingExecutionGeneration(state, ticketGeneration)
  ) {
    // Recovery - prepare state
    state = prepareForRecovery(state);
    await saveWorkerState(projectId, ticketId, state);
  } else {
    // Fresh start
    state = await initWorkerState(projectId, ticketId, phase);
  }

  if (phaseConfig.workers.length === 0) {
    console.log(`[WorkerExecutor] Phase ${phase} has no workers`);
    return null;
  }

  return executeNextWorker(projectId, ticketId, phase, projectPath, phaseConfig, state, callbacks);
}

/**
 * Execute the next worker in the phase
 */
async function executeNextWorker(
  projectId: string,
  ticketId: string,
  phase: TicketPhase,
  projectPath: string,
  phaseConfig: Phase,
  state: ActiveWorkerStateRoot,
  callbacks: ExecutorCallbacks
): Promise<string | null> {
  const current = getCurrentWorker(phaseConfig.workers, state);
  if (!current) {
    // Phase complete
    await handlePhaseComplete(projectId, ticketId, phase, projectPath, callbacks);
    return null;
  }

  const { worker, path } = current;
  await logToDaemon(projectId, ticketId, `Executing worker: ${path.join(" > ")}`);

  if (isAgentWorker(worker)) {
    // Get task context if inside a task loop (walk up state tree)
    let taskContext: TaskContext | undefined;
    const taskState = findTaskLoopInState(state.activeWorker);
    if (taskState?.currentTaskId) {
      taskContext = buildTaskContext(taskState.currentTaskId);
      // Mark task as in_progress
      updateTaskStatus(taskState.currentTaskId, "in_progress");
    }

    // Update state with agent
    const agentState = createAgentState(worker.id);
    const newState = updateStateWithActiveWorker(state, agentState);
    await saveWorkerState(projectId, ticketId, newState);

    // Get ralph context for feedback injection
    const ralphContext = getRalphContext(state, phase);
    const isPhaseEntryWorker = state.workerIndex === 0 && !state.activeWorker;
    const phaseEntrySummary = isPhaseEntryWorker
      ? buildPhaseEntryTaskSummary(ticketId, phase)
      : null;
    const phaseEntryContext: PhaseEntryContext | undefined = phaseEntrySummary
      ? {
          mode: phaseEntrySummary.actionableInPhase > 0 ? "re_entry" : "fresh_entry",
          taskSummary: phaseEntrySummary,
        }
      : undefined;

    return callbacks.spawnAgent(
      projectId,
      ticketId,
      phase,
      projectPath,
      worker,
      taskContext,
      ralphContext,
      phaseEntryContext,
    );
  }

  if (isRalphLoopWorker(worker)) {
    // Check if we're inside a taskLoop that needs a task selected first
    // This can happen during recovery when currentTaskId is null but pendingTasks exist
    const taskLoopState = findTaskLoopInState(state.activeWorker);
    if (taskLoopState && !taskLoopState.currentTaskId && taskLoopState.pendingTasks.length > 0) {
      // Need to start the next task before entering the ralphLoop
      const nextTaskId = taskLoopState.pendingTasks[0];
      const startedState: TaskLoopState = {
        ...taskLoopState,
        currentTaskId: nextTaskId,
        pendingTasks: taskLoopState.pendingTasks.slice(1),
        workerIndex: 0,
        activeWorker: null,
      };
      const newState = updateStateWithActiveWorker(
        { ...state, activeWorker: null },
        startedState
      );
      await saveWorkerState(projectId, ticketId, newState);
      // Recurse with updated state - getCurrentWorker will return the ralphLoop again
      // but now with a task selected
      return executeNextWorker(projectId, ticketId, phase, projectPath, phaseConfig, newState, callbacks);
    }

    // Get task context if inside a task loop
    const taskId = getActiveTaskId(state);

    // Initialize ralph loop with feedback in SQLite
    createRalphFeedback({
      ticketId,
      phaseId: phase,
      ralphLoopId: worker.id,
      taskId: taskId || undefined,
      maxAttempts: worker.maxAttempts,
    });

    const ralphState = initRalphLoop(worker);
    const newState = updateStateWithActiveWorker(state, ralphState);
    await saveWorkerState(projectId, ticketId, newState);

    // Recurse to get first agent
    return executeNextWorker(projectId, ticketId, phase, projectPath, phaseConfig, newState, callbacks);
  }

  if (isTaskLoopWorker(worker)) {
    // Initialize task loop
    const taskState = initTaskLoop(ticketId, worker, phase);
    const firstTaskId = getNextTask(taskState);

    if (!firstTaskId) {
      // No tasks - skip this worker
      const newState: OrchestrationState = {
        ...state,
        workerIndex: state.workerIndex + 1,
        activeWorker: null,
      };
      await saveWorkerState(projectId, ticketId, newState);
      return executeNextWorker(projectId, ticketId, phase, projectPath, phaseConfig, newState, callbacks);
    }

    // Start first task
    const startedState = startTask(taskState, firstTaskId);
    const newState = updateStateWithActiveWorker(state, startedState);
    await saveWorkerState(projectId, ticketId, newState);

    // Recurse to get first agent in task loop
    return executeNextWorker(projectId, ticketId, phase, projectPath, phaseConfig, newState, callbacks);
  }

  return null;
}

/**
 * Update state tree with new active worker
 */
function updateStateWithActiveWorker(
  state: ActiveWorkerStateRoot,
  newActiveWorker: WorkerState
): ActiveWorkerStateRoot {
  if (!state.activeWorker) {
    return { ...state, activeWorker: newActiveWorker };
  }

  // Need to update nested state
  return {
    ...state,
    activeWorker: updateNestedActiveWorker(state.activeWorker, newActiveWorker),
  };
}

function updateNestedActiveWorker(
  current: WorkerState,
  newWorker: WorkerState
): WorkerState {
  if (current.type === "ralphLoop") {
    const ralph = current as RalphLoopState;
    if (!ralph.activeWorker) {
      return { ...ralph, activeWorker: newWorker };
    }
    return { ...ralph, activeWorker: updateNestedActiveWorker(ralph.activeWorker, newWorker) };
  }

  if (current.type === "taskLoop") {
    const task = current as TaskLoopState;
    if (!task.activeWorker) {
      return { ...task, activeWorker: newWorker };
    }
    return { ...task, activeWorker: updateNestedActiveWorker(task.activeWorker, newWorker) };
  }

  return newWorker;
}

/**
 * Handle agent completion - coordinate next steps
 */
export async function handleAgentCompletion(
  projectId: string,
  ticketId: string,
  phase: TicketPhase,
  projectPath: string,
  exitCode: number,
  agentId: string,
  verdict: { approved: boolean; feedback?: string },
  callbacks: ExecutorCallbacks,
  callbackIdentity?: SessionCallbackIdentity,
): Promise<void> {
  const strictStaleDrop =
    process.env.POTATO_LIFECYCLE_STRICT_STALE_DROP !== "false";
  const currentTicket = getTicket(projectId, ticketId);
  const ticketGeneration = currentTicket?.executionGeneration ?? 0;
  const callbackGeneration = callbackIdentity?.executionGeneration;
  const isStaleCallback =
    callbackGeneration === undefined ||
    callbackGeneration === null ||
    callbackGeneration !== ticketGeneration;
  if (isStaleCallback && strictStaleDrop) {
    await logToDaemon(projectId, ticketId, `Dropping stale completion callback`, {
      agentId,
      callbackIdentity,
      ticketGeneration,
    });
    return;
  }
  if (isStaleCallback) {
    await logToDaemon(
      projectId,
      ticketId,
      `Strict stale-drop disabled; allowing callback despite generation mismatch`,
      {
        agentId,
        callbackIdentity,
        ticketGeneration,
      },
    );
  }

  const phaseConfig = await getPhaseConfig(projectId, phase);
  if (!phaseConfig) return;

  const state = await getWorkerState(projectId, ticketId);
  if (!state || !isActiveRoot(state)) return;

  // Check if this exit is a suspension (pending question exists, no response yet)
  // A suspended session exits cleanly (code 0) after calling chat_ask with suspend: true.
  // We must NOT advance the worker tree — the session will resume when the user responds.
  if (exitCode === 0 && ticketId) {
    const pendingQuestion = await readQuestion(projectId, ticketId);
    if (pendingQuestion) {
      await logToDaemon(projectId, ticketId, `Session suspended — awaiting user response`, {
        agentId,
        questionConversationId: pendingQuestion.conversationId,
      });
      // Emit event so frontend knows ticket is waiting
      const ticket = getTicket(projectId, ticketId);
      const { eventBus } = await import("../../utils/event-bus.js");
      eventBus.emit("ticket:updated", { projectId, ticket });
      return; // Critical: return without advancing worker state
    }
  }

  await logToDaemon(projectId, ticketId, `Agent ${agentId} completed`, {
    exitCode,
    verdict: verdict.approved ? "APPROVED" : "REVISION_NEEDED",
    callbackIdentity,
  });

  // Handle based on where we are in the worker tree
  const newState = await processAgentCompletion(
    projectId,
    ticketId,
    phase,
    projectPath,
    phaseConfig,
    state,
    exitCode,
    verdict,
    callbacks
  );

  if (newState) {
    await saveWorkerState(projectId, ticketId, newState);
    await executeNextWorker(projectId, ticketId, phase, projectPath, phaseConfig, newState, callbacks);
  }
}

async function processAgentCompletion(
  projectId: string,
  ticketId: string,
  phase: TicketPhase,
  projectPath: string,
  phaseConfig: Phase,
  state: ActiveWorkerStateRoot,
  exitCode: number,
  verdict: { approved: boolean; feedback?: string },
  callbacks: ExecutorCallbacks
): Promise<ActiveWorkerStateRoot | null> {
  if (!state.activeWorker) {
    // Top-level agent completed
    if (exitCode !== 0) {
      await callbacks.onTicketBlocked(projectId, ticketId, `Agent failed with exit code ${exitCode}`);
      return null;
    }
    // Advance to next worker
    return {
      ...state,
      workerIndex: state.workerIndex + 1,
      activeWorker: null,
    };
  }

  // Get taskId from state if inside a task loop
  const taskId = getActiveTaskId(state);

  // Handle nested completion
  const result = await processNestedCompletion(
    projectId,
    ticketId,
    phase,
    phaseConfig.workers[state.workerIndex],
    state.activeWorker,
    exitCode,
    verdict,
    callbacks,
    taskId
  );

  if (result.blocked) {
    return null;
  }

  if (result.loopComplete) {
    // Loop finished - advance to next top-level worker
    return {
      ...state,
      workerIndex: state.workerIndex + 1,
      activeWorker: null,
    };
  }

  return {
    ...state,
    activeWorker: result.newState,
  };
}

interface NestedCompletionResult {
  newState: WorkerState | null;
  loopComplete: boolean;
  blocked: boolean;
}

async function processNestedCompletion(
  projectId: string,
  ticketId: string,
  phase: TicketPhase,
  worker: Worker,
  workerState: WorkerState,
  exitCode: number,
  verdict: { approved: boolean; feedback?: string },
  callbacks: ExecutorCallbacks,
  taskId: string | null = null
): Promise<NestedCompletionResult> {
  if (workerState.type === "agent") {
    // This shouldn't happen at this level
    return { newState: null, loopComplete: true, blocked: false };
  }

  if (workerState.type === "ralphLoop" && isRalphLoopWorker(worker)) {
    const ralphState = workerState as RalphLoopState;

    if (ralphState.activeWorker && ralphState.activeWorker.type !== "agent") {
      // Nested loop - recurse
      const nestedResult = await processNestedCompletion(
        projectId,
        ticketId,
        phase,
        worker.workers[ralphState.workerIndex],
        ralphState.activeWorker,
        exitCode,
        verdict,
        callbacks,
        taskId
      );

      if (nestedResult.blocked) {
        return nestedResult;
      }

      if (nestedResult.loopComplete) {
        // Nested loop complete - treat as agent success
        exitCode = 0;
        verdict = { approved: true };
      } else {
        return {
          newState: { ...ralphState, activeWorker: nestedResult.newState },
          loopComplete: false,
          blocked: false,
        };
      }
    }

    // Handle ralph loop agent completion
    const { nextState, result } = handleRalphLoopAgentCompletion(worker, ralphState, exitCode, verdict);

    // Record iteration if this was the final reviewer (last worker in iteration)
    const isLastWorkerInIteration = ralphState.workerIndex === worker.workers.length - 1;
    if (isLastWorkerInIteration) {
      const reviewerAgent = worker.workers[ralphState.workerIndex];
      // Look up the feedback record to add iteration
      const feedback = getRalphFeedbackForLoop(ticketId, phase, worker.id, taskId || undefined);
      if (feedback) {
        addRalphIteration(feedback.id, {
          iteration: ralphState.iteration,
          approved: verdict.approved,
          feedback: verdict.feedback,
          reviewer: reviewerAgent.id,
        });
      }
    }

    if (result.status === "maxAttempts") {
      const feedback = getRalphFeedbackForLoop(ticketId, phase, worker.id, taskId || undefined);
      if (feedback) {
        updateRalphFeedbackStatus(feedback.id, "max_attempts");
      }
      await callbacks.onTicketBlocked(projectId, ticketId, `Ralph loop "${worker.id}" exceeded max attempts`);
      return { newState: null, loopComplete: false, blocked: true };
    }

    if (result.status === "approved") {
      const feedback = getRalphFeedbackForLoop(ticketId, phase, worker.id, taskId || undefined);
      if (feedback) {
        updateRalphFeedbackStatus(feedback.id, "approved");
      }
      return { newState: null, loopComplete: true, blocked: false };
    }

    return { newState: nextState, loopComplete: false, blocked: false };
  }

  if (workerState.type === "taskLoop" && isTaskLoopWorker(worker)) {
    const taskState = workerState as TaskLoopState;

    if (taskState.activeWorker) {
      // Nested worker in task loop
      if (taskState.activeWorker.type === "ralphLoop") {
        // Find the ralph loop worker
        const ralphWorker = worker.workers.find(
          (w) => w.id === taskState.activeWorker!.id
        ) as RalphLoopWorker;

        const nestedResult = await processNestedCompletion(
          projectId,
          ticketId,
          phase,
          ralphWorker,
          taskState.activeWorker,
          exitCode,
          verdict,
          callbacks,
          taskState.currentTaskId
        );

        if (nestedResult.blocked) {
          // Task failed - mark and block ticket
          if (taskState.currentTaskId) {
            updateTaskStatus(taskState.currentTaskId, "failed");
          }
          return nestedResult;
        }

        if (nestedResult.loopComplete) {
          // Nested worker complete - check if more workers for this task
          const nextWorkerIndex = taskState.workerIndex + 1;

          if (nextWorkerIndex < worker.workers.length) {
            // More workers for this task - advance workerIndex
            return {
              newState: advanceWorkerIndex(taskState),
              loopComplete: false,
              blocked: false,
            };
          }

          // All workers done - mark task success
          if (taskState.currentTaskId) {
            updateTaskStatus(taskState.currentTaskId, "completed");
          }
          const { nextState, result } = handleTaskWorkersComplete(taskState, true);

          if (result.status === "completed") {
            return { newState: null, loopComplete: true, blocked: false };
          }

          return { newState: nextState, loopComplete: false, blocked: false };
        }

        return {
          newState: { ...taskState, activeWorker: nestedResult.newState },
          loopComplete: false,
          blocked: false,
        };
      }

      // Direct agent in task loop
      if (exitCode !== 0) {
        if (taskState.currentTaskId) {
          updateTaskStatus(taskState.currentTaskId, "failed");
        }
        await callbacks.onTicketBlocked(projectId, ticketId, `Task "${taskState.currentTaskId}" failed`);
        return { newState: null, loopComplete: false, blocked: true };
      }

      // Agent success - check if more workers for this task using workerIndex
      const nextWorkerIndex = taskState.workerIndex + 1;

      if (nextWorkerIndex < worker.workers.length) {
        // More workers for this task - advance workerIndex
        return {
          newState: advanceWorkerIndex(taskState),
          loopComplete: false,
          blocked: false,
        };
      }

      // Task complete
      if (taskState.currentTaskId) {
        updateTaskStatus(taskState.currentTaskId, "completed");
      }
      const { nextState, result } = handleTaskWorkersComplete(taskState, true);

      if (result.status === "completed") {
        return { newState: null, loopComplete: true, blocked: false };
      }

      return { newState: nextState, loopComplete: false, blocked: false };
    }
  }

  return { newState: null, loopComplete: true, blocked: false };
}

/**
 * Handle phase completion - transition to next
 */
async function handlePhaseComplete(
  projectId: string,
  ticketId: string,
  phase: TicketPhase,
  projectPath: string,
  callbacks: ExecutorCallbacks
): Promise<void> {
  await logToDaemon(projectId, ticketId, `Phase ${phase} complete`);
  await clearWorkerState(projectId, ticketId);
  await callbacks.onPhaseComplete(projectId, ticketId, phase, projectPath);
}
