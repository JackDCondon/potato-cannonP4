import type { Express, Request, Response } from "express";
import {
  createTask as createTaskStore,
  getTask,
  getTaskByDisplayNumber,
  listTasks,
  updateTaskStatus,
  addTaskComment,
} from "../../stores/task.store.js";
import { getTicket } from "../../stores/ticket.store.js";
import { eventBus } from "../../utils/event-bus.js";
import type { TaskStatus } from "../../types/task.types.js";
import type { Task } from "../../types/task.types.js";
import type { Complexity } from "@potato-cannon/shared";

/**
 * Resolves a task ID parameter to a Task object.
 * Supports both UUID format and legacy "task1", "task2" format.
 */
function resolveTaskId(ticketId: string, taskIdParam: string): Task | null {
  // Check for legacy task ID format (e.g., "task1", "task2")
  const legacyMatch = taskIdParam.match(/^task(\d+)$/);
  if (legacyMatch) {
    const displayNumber = parseInt(legacyMatch[1], 10);
    return getTaskByDisplayNumber(ticketId, displayNumber);
  }

  // Otherwise, treat as UUID
  return getTask(taskIdParam);
}

export function registerTaskRoutes(app: Express): void {
  // Create task
  app.post(
    "/api/tickets/:project/:id/tasks",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const { description, body, complexity } = req.body as { description?: string; body?: string; complexity?: Complexity };

        if (!description) {
          res.status(400).json({ error: "Missing description" });
          return;
        }

        // Get the ticket to determine current phase
        const ticket = await getTicket(projectId, ticketId);
        if (!ticket) {
          res.status(404).json({ error: "Ticket not found" });
          return;
        }

        const task = createTaskStore(ticketId, ticket.phase, { description, body, complexity });

        // Emit SSE event for real-time updates
        eventBus.emit("ticket:task-updated", {
          projectId,
          ticketId,
          taskId: task.id,
          task,
        });

        res.json(task);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // List tasks
  app.get(
    "/api/tickets/:project/:id/tasks",
    (req: Request, res: Response) => {
      try {
        const ticketId = req.params.id;
        const phase = req.query.phase as string | undefined;

        const tasks = listTasks(ticketId, phase ? { phase } : undefined);
        res.json(tasks);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Get single task
  app.get(
    "/api/tickets/:project/:id/tasks/:taskId",
    (req: Request, res: Response) => {
      try {
        const ticketId = req.params.id;
        const taskIdParam = req.params.taskId;

        const task = resolveTaskId(ticketId, taskIdParam);
        if (!task) {
          res.status(404).json({ error: "Task not found" });
          return;
        }
        res.json(task);
      } catch (error) {
        res.status(404).json({ error: "Task not found" });
      }
    },
  );

  // Update task status
  app.put(
    "/api/tickets/:project/:id/tasks/:taskId",
    (req: Request, res: Response) => {
      try {
        const ticketId = req.params.id;
        const taskIdParam = req.params.taskId;
        const { status } = req.body as { status?: TaskStatus };

        if (!status) {
          res.status(400).json({ error: "Missing status" });
          return;
        }

        const validStatuses: TaskStatus[] = ["pending", "in_progress", "completed", "failed", "cancelled"];
        if (!validStatuses.includes(status)) {
          res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
          return;
        }

        // First resolve the task ID (could be UUID or legacy format)
        const existingTask = resolveTaskId(ticketId, taskIdParam);
        if (!existingTask) {
          res.status(404).json({ error: "Task not found" });
          return;
        }

        // Now update using the actual UUID
        const task = updateTaskStatus(existingTask.id, status);
        if (!task) {
          res.status(500).json({ error: "Failed to update task status" });
          return;
        }

        // Emit SSE event for real-time updates
        const projectId = decodeURIComponent(req.params.project);
        eventBus.emit("ticket:task-updated", {
          projectId,
          ticketId,
          taskId: task.id,
          task,
        });

        res.json(task);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Add comment to task
  app.post(
    "/api/tickets/:project/:id/tasks/:taskId/comments",
    (req: Request, res: Response) => {
      try {
        const ticketId = req.params.id;
        const taskIdParam = req.params.taskId;
        const { text } = req.body as { text?: string };

        if (!text) {
          res.status(400).json({ error: "Missing text" });
          return;
        }

        // First resolve the task ID (could be UUID or legacy format)
        const existingTask = resolveTaskId(ticketId, taskIdParam);
        if (!existingTask) {
          res.status(404).json({ error: "Task not found" });
          return;
        }

        // Now add comment using the actual UUID
        const comment = addTaskComment(existingTask.id, text);
        if (!comment) {
          res.status(500).json({ error: "Failed to add comment" });
          return;
        }

        // Emit SSE event for real-time updates (refetch task list)
        const projectId = decodeURIComponent(req.params.project);
        eventBus.emit("ticket:task-updated", {
          projectId,
          ticketId,
          taskId: existingTask.id,
          task: existingTask,
        });

        res.json(comment);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );
}
