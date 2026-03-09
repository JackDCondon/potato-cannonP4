import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";
import type { Task } from "../../types/task.types.js";

export const taskTools: ToolDefinition[] = [
  {
    name: "list_tasks",
    description:
      "List all tasks for the current ticket. Returns tasks with their IDs, descriptions, statuses, and bodies. Use this to check what tasks already exist before creating new ones.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_task",
    description: "Get details of a specific task by its ID",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID (e.g., 'task1', 'task2')",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task for the current ticket. The task will be created in the ticket's current phase.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short title/summary of the task (displayed in task lists)",
        },
        body: {
          type: "string",
          description: "Full implementation details including code, commands, verification steps, and expected outputs. This is what the builder will execute.",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "update_task_status",
    description: "Update the status of a task. Valid statuses: pending, in_progress, completed, failed, cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID (e.g., 'task1', 'task2')",
        },
        status: {
          type: "string",
          description: "New status: pending, in_progress, completed, or failed",
        },
      },
      required: ["taskId", "status"],
    },
  },
  {
    name: "add_comment_to_task",
    description: "Add a comment to an existing task",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID (e.g., 'task1', 'task2')",
        },
        text: {
          type: "string",
          description: "The comment text",
        },
      },
      required: ["taskId", "text"],
    },
  },
];

async function getTask(ctx: McpContext, taskId: string): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ctx.ticketId}/tasks/${taskId}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to get task: ${response.statusText}`);
  }
  return response.json();
}

async function createTask(
  ctx: McpContext,
  description: string,
  body?: string,
): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ctx.ticketId}/tasks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, ...(body && { body }) }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to create task: ${response.statusText}`);
  }
  return response.json();
}

async function updateTaskStatus(
  ctx: McpContext,
  taskId: string,
  status: string,
): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ctx.ticketId}/tasks/${taskId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to update task: ${response.statusText}`);
  }
  return response.json();
}

async function addCommentToTask(
  ctx: McpContext,
  taskId: string,
  text: string,
): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ctx.ticketId}/tasks/${taskId}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to add comment: ${response.statusText}`);
  }
  return response.json();
}

async function listTasksForTicket(ctx: McpContext): Promise<Task[]> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ctx.ticketId}/tasks`,
  );
  if (!response.ok) {
    throw new Error(`Failed to list tasks: ${response.statusText}`);
  }
  return response.json();
}

const VALID_TASK_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];

export const taskHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  list_tasks: async (ctx) => {
    if (!ctx.ticketId) {
      throw new Error("Missing context.ticketId - task tools require a ticket context");
    }
    const tasks = await listTasksForTicket(ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
    };
  },

  get_task: async (ctx, args) => {
    if (!ctx.ticketId) {
      throw new Error("Missing context.ticketId - task tools require a ticket context");
    }
    if (!args.taskId || typeof args.taskId !== "string") {
      throw new Error("Missing required field: taskId");
    }
    const task = await getTask(ctx, args.taskId);
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    };
  },

  create_task: async (ctx, args) => {
    if (!ctx.ticketId) {
      throw new Error("Missing context.ticketId - task tools require a ticket context");
    }
    if (!args.description || typeof args.description !== "string") {
      throw new Error("Missing required field: description");
    }
    const body = typeof args.body === "string" ? args.body : undefined;
    const task = await createTask(ctx, args.description, body);
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    };
  },

  update_task_status: async (ctx, args) => {
    if (!ctx.ticketId) {
      throw new Error("Missing context.ticketId - task tools require a ticket context");
    }
    if (!args.taskId || typeof args.taskId !== "string") {
      throw new Error("Missing required field: taskId");
    }
    if (!args.status || typeof args.status !== "string") {
      throw new Error("Missing required field: status");
    }
    if (!VALID_TASK_STATUSES.includes(args.status)) {
      throw new Error(
        `Invalid status: "${args.status}". Must be one of: ${VALID_TASK_STATUSES.join(", ")}`,
      );
    }
    const task = await updateTaskStatus(ctx, args.taskId, args.status);
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    };
  },

  add_comment_to_task: async (ctx, args) => {
    if (!ctx.ticketId) {
      throw new Error("Missing context.ticketId - task tools require a ticket context");
    }
    if (!args.taskId || typeof args.taskId !== "string") {
      throw new Error("Missing required field: taskId");
    }
    if (!args.text || typeof args.text !== "string") {
      throw new Error("Missing required field: text");
    }
    const task = await addCommentToTask(ctx, args.taskId, args.text);
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    };
  },
};
