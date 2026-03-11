import fs from "fs/promises";
import path from "path";
import { TASKS_DIR, BRAINSTORMS_DIR, ARTIFACT_CHAT_DIR } from "../config/paths.js";

// =============================================================================
// Cancellation Registry
// =============================================================================

/**
 * Map of contextId -> AbortController for active waitForResponse calls.
 * When a session is replaced, we cancel the old wait so it doesn't
 * process the response meant for the new session.
 */
const waitControllers: Map<string, AbortController> = new Map();

/**
 * Cancel any active waitForResponse for the given context.
 * Called before spawning a new session to prevent duplicate processing.
 */
export function cancelWaitForResponse(contextId: string): void {
  const controller = waitControllers.get(contextId);
  if (controller) {
    controller.abort();
    waitControllers.delete(contextId);
  }
}

/**
 * Create a new AbortController for waitForResponse.
 * Cancels any existing controller for this context first.
 */
export function createWaitController(contextId: string): AbortController {
  // Cancel any existing wait first
  cancelWaitForResponse(contextId);

  const controller = new AbortController();
  waitControllers.set(contextId, controller);
  return controller;
}

// =============================================================================
// Path Helpers
// =============================================================================

function getBasePath(projectId: string, contextId: string): string {
  const safeProject = projectId.replace(/\//g, "__");

  if (contextId.startsWith("brain_")) {
    return path.join(BRAINSTORMS_DIR, safeProject, contextId);
  }
  if (contextId.startsWith("artchat_")) {
    return path.join(ARTIFACT_CHAT_DIR, safeProject, contextId);
  }
  // Default: tickets
  return path.join(TASKS_DIR, safeProject, contextId);
}

function getQuestionPath(projectId: string, contextId: string): string {
  return path.join(getBasePath(projectId, contextId), "pending-question.json");
}

function getResponsePath(projectId: string, contextId: string): string {
  return path.join(getBasePath(projectId, contextId), "pending-response.json");
}

export interface PendingQuestion {
  conversationId: string;
  questionId?: string;
  question: string;
  options: string[] | null;
  askedAt: string;
  phase?: string;
  ticketGeneration?: number;
  phaseAtAsk?: string;
}

export interface PendingResponse {
  answer: string;
  questionId?: string;
  ticketGeneration?: number;
}

export async function writeQuestion(
  projectId: string,
  contextId: string,
  question: PendingQuestion,
): Promise<void> {
  const questionPath = getQuestionPath(projectId, contextId);
  await fs.mkdir(path.dirname(questionPath), { recursive: true });
  await fs.writeFile(questionPath, JSON.stringify(question, null, 2));
}

export async function readQuestion(
  projectId: string,
  contextId: string,
): Promise<PendingQuestion | null> {
  const questionPath = getQuestionPath(projectId, contextId);
  try {
    return JSON.parse(await fs.readFile(questionPath, "utf-8"));
  } catch {
    return null;
  }
}

export async function clearQuestion(
  projectId: string,
  contextId: string,
): Promise<void> {
  const questionPath = getQuestionPath(projectId, contextId);
  try {
    await fs.unlink(questionPath);
  } catch {
    // Ignore
  }
}

export async function writeResponse(
  projectId: string,
  contextId: string,
  response: PendingResponse,
): Promise<void> {
  const responsePath = getResponsePath(projectId, contextId);
  await fs.mkdir(path.dirname(responsePath), { recursive: true });
  await fs.writeFile(responsePath, JSON.stringify(response, null, 2));
}

export async function readResponse(
  projectId: string,
  contextId: string,
): Promise<PendingResponse | null> {
  const responsePath = getResponsePath(projectId, contextId);
  try {
    return JSON.parse(await fs.readFile(responsePath, "utf-8"));
  } catch {
    return null;
  }
}

export async function clearResponse(
  projectId: string,
  contextId: string,
): Promise<void> {
  const responsePath = getResponsePath(projectId, contextId);
  try {
    await fs.unlink(responsePath);
  } catch {
    // Ignore
  }
}

export async function clearPendingInteraction(
  projectId: string,
  contextId: string,
): Promise<void> {
  await clearQuestion(projectId, contextId);
  await clearResponse(projectId, contextId);
}

/**
 * Wait for a response to be written for the given context.
 *
 * @param projectId - The project ID
 * @param contextId - The context ID (ticket, brainstorm, or artifact chat)
 * @param timeoutMs - Maximum time to wait (default 24 hours)
 * @param signal - Optional AbortSignal to cancel the wait
 * @returns The response answer
 * @throws Error if cancelled or timeout
 */
export async function waitForResponse(
  projectId: string,
  contextId: string,
  timeoutMs: number = 86400000,
  signal?: AbortSignal,
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check for abort
    if (signal?.aborted) {
      throw new Error("Wait cancelled - session replaced");
    }

    const response = await readResponse(projectId, contextId);
    if (response) {
      await clearResponse(projectId, contextId);
      await clearQuestion(projectId, contextId);
      return response.answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Timeout waiting for response");
}

export interface PendingContext {
  projectId: string;
  contextId: string;
  type: "ticket" | "brainstorm";
  response: PendingResponse;
  question: PendingQuestion | null;
}

/**
 * Scan all tickets and brainstorms for pending responses that need session resumption.
 */
export async function scanPendingResponses(): Promise<PendingContext[]> {
  const results: PendingContext[] = [];

  // Scan tickets
  try {
    const projectDirs = await fs.readdir(TASKS_DIR);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(TASKS_DIR, projectDir);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const ticketDirs = await fs.readdir(projectPath);
      for (const ticketDir of ticketDirs) {
        const responsePath = path.join(
          projectPath,
          ticketDir,
          "pending-response.json",
        );
        try {
          const responseData = await fs.readFile(responsePath, "utf-8");
          const response = JSON.parse(responseData) as PendingResponse;
          const projectId = projectDir.replace(/__/g, "/");

          // Also try to read the question for context
          const questionPath = path.join(
            projectPath,
            ticketDir,
            "pending-question.json",
          );
          let question: PendingQuestion | null = null;
          try {
            question = JSON.parse(await fs.readFile(questionPath, "utf-8"));
          } catch {
            // No question file
          }

          results.push({
            projectId,
            contextId: ticketDir,
            type: "ticket",
            response,
            question,
          });
        } catch {
          // No pending response for this ticket
        }
      }
    }
  } catch {
    // TASKS_DIR may not exist
  }

  // Scan brainstorms
  try {
    const projectDirs = await fs.readdir(BRAINSTORMS_DIR);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(BRAINSTORMS_DIR, projectDir);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const brainstormDirs = await fs.readdir(projectPath);
      for (const brainstormDir of brainstormDirs) {
        const responsePath = path.join(
          projectPath,
          brainstormDir,
          "pending-response.json",
        );
        try {
          const responseData = await fs.readFile(responsePath, "utf-8");
          const response = JSON.parse(responseData) as PendingResponse;
          const projectId = projectDir.replace(/__/g, "/");

          // Also try to read the question for context
          const questionPath = path.join(
            projectPath,
            brainstormDir,
            "pending-question.json",
          );
          let question: PendingQuestion | null = null;
          try {
            question = JSON.parse(await fs.readFile(questionPath, "utf-8"));
          } catch {
            // No question file
          }

          results.push({
            projectId,
            contextId: brainstormDir,
            type: "brainstorm",
            response,
            question,
          });
        } catch {
          // No pending response for this brainstorm
        }
      }
    }
  } catch {
    // BRAINSTORMS_DIR may not exist
  }

  return results;
}

/**
 * Scan all tickets for pending questions (pending-question.json files).
 * Returns ticket IDs grouped by project ID.
 * Used by the processing:sync heartbeat to provide authoritative pending state.
 */
export async function getPendingQuestionsByProject(): Promise<
  Map<string, string[]>
> {
  return getPendingQuestionsByProjectFiltered();
}

export type PendingQuestionFilter = (args: {
  projectId: string;
  ticketId: string;
  question: PendingQuestion;
}) => boolean | Promise<boolean>;

/**
 * Scan all tickets for pending questions (pending-question.json files).
 * Returns ticket IDs grouped by project ID.
 * Optional filter allows callers to hide stale questions without rewriting store scans.
 */
export async function getPendingQuestionsByProjectFiltered(
  includeQuestion?: PendingQuestionFilter,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  try {
    const projectDirs = await fs.readdir(TASKS_DIR);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(TASKS_DIR, projectDir);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const ticketDirs = await fs.readdir(projectPath);
      const pendingTicketIds: string[] = [];

      for (const ticketDir of ticketDirs) {
        const questionPath = path.join(projectPath, ticketDir, "pending-question.json");
        try {
          const questionData = await fs.readFile(questionPath, "utf-8");
          const question = JSON.parse(questionData) as PendingQuestion;
          const projectId = projectDir.replace(/__/g, "/");

          if (includeQuestion) {
            const include = await includeQuestion({
              projectId,
              ticketId: ticketDir,
              question,
            });
            if (!include) {
              continue;
            }
          }

          pendingTicketIds.push(ticketDir);
        } catch {
          // No pending question for this ticket
        }
      }

      if (pendingTicketIds.length > 0) {
        const projectId = projectDir.replace(/__/g, "/");
        result.set(projectId, pendingTicketIds);
      }
    }
  } catch {
    // TASKS_DIR may not exist
  }

  return result;
}
