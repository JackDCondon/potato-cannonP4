import fs from "fs/promises";
import path from "path";
import { TASKS_DIR } from "../../config/paths.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";
import type { Task } from "../../types/task.types.js";
import type { BodyFrom } from "@potato-cannon/shared";

/**
 * Extract a section from content using literal string markers.
 * - Includes start_marker line in output
 * - Excludes end_marker line from output
 * - If no end_marker, extracts to EOF
 */
export function extractSection(
  content: string,
  startMarker: string,
  endMarker?: string,
): string {
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`Start marker not found: ${startMarker}`);
  }

  if (endMarker) {
    const endIdx = content.indexOf(endMarker, startIdx + startMarker.length);
    if (endIdx === -1) {
      throw new Error(`End marker not found after start marker: ${endMarker}`);
    }
    return content.slice(startIdx, endIdx).trimEnd();
  }

  return content.slice(startIdx).trimEnd();
}

/**
 * Extract and normalize the description prefix for duplicate detection.
 * Compares the portion before the first colon, lowercased and trimmed.
 * If no colon, uses the full description.
 */
export function extractDescriptionPrefix(description: string): string {
  const colonIdx = description.indexOf(":");
  const prefix = colonIdx !== -1
    ? description.slice(0, colonIdx)
    : description;
  return prefix.trim().toLowerCase();
}

/**
 * Resolve body_from reference by reading artifact content from disk
 * and extracting the section between markers.
 */
async function resolveBodyFrom(
  ctx: McpContext,
  ticketId: string,
  bodyFrom: BodyFrom,
): Promise<string> {
  const safeProject = ctx.projectId.replace(/\//g, "__");
  const artifactsDir = path.join(TASKS_DIR, safeProject, ticketId, "artifacts");
  const artifactPath = path.join(artifactsDir, bodyFrom.artifact);

  // Guard against path traversal (e.g., "../../etc/passwd")
  const resolvedPath = path.resolve(artifactPath);
  const resolvedDir = path.resolve(artifactsDir);
  if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
    throw new Error(`Invalid artifact filename: '${bodyFrom.artifact}'`);
  }

  let content: string;
  try {
    content = await fs.readFile(artifactPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Artifact '${bodyFrom.artifact}' not found for this ticket`,
      );
    }
    throw error;
  }

  try {
    return extractSection(content, bodyFrom.start_marker, bodyFrom.end_marker);
  } catch (error) {
    throw new Error(
      `${(error as Error).message} in artifact '${bodyFrom.artifact}'`,
    );
  }
}

export const taskTools: ToolDefinition[] = [
  {
    name: "list_tasks",
    description:
      "List all tasks for a ticket. Returns tasks with their IDs, descriptions, statuses, and bodies. Use this to check what tasks already exist before creating new ones.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to list tasks for. Required in headless/external mode.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_task",
    description: "Get details of a specific task by its ID",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID the task belongs to. Required in headless/external mode.",
        },
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
    description: "Create a new task for a ticket. The task will be created in the ticket's current phase.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to create the task in. Required in headless/external mode.",
        },
        description: {
          type: "string",
          description: "Short title/summary of the task (displayed in task lists)",
        },
        body: {
          type: "string",
          description: "Full implementation details including code, commands, verification steps, and expected outputs. This is what the builder will execute.",
        },
        complexity: {
          type: "string",
          enum: ["simple", "standard", "complex"],
          description: "Task complexity: simple (<=1 non-test file, <=1 step), standard (2-3 files, routine — default), complex (4+ files, new patterns, security, integration)",
        },
        body_from: {
          type: "object",
          description:
            "Reference to extract body content from an artifact. If provided, reads the artifact file and extracts the section between start_marker and end_marker. Takes precedence over 'body' if both are provided.",
          properties: {
            artifact: {
              type: "string",
              description: "Artifact filename (e.g., 'specification.md')",
            },
            start_marker: {
              type: "string",
              description:
                "Literal string to find — extraction starts here (inclusive)",
            },
            end_marker: {
              type: "string",
              description:
                "Literal string marking end of extraction (exclusive). If omitted, extracts to end of file.",
            },
          },
          required: ["artifact", "start_marker"],
        },
        force: {
          type: "boolean",
          description: "If true, bypass the session-active write guard and proceed even if a session is running on this ticket.",
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
        ticketId: {
          type: "string",
          description: "Ticket ID the task belongs to. Required in headless/external mode.",
        },
        taskId: {
          type: "string",
          description: "The task ID (e.g., 'task1', 'task2')",
        },
        status: {
          type: "string",
          description: "New status: pending, in_progress, completed, or failed",
        },
        force: {
          type: "boolean",
          description: "If true, bypass the session-active write guard and proceed even if a session is running on this ticket.",
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
        ticketId: {
          type: "string",
          description: "Ticket ID the task belongs to. Required in headless/external mode.",
        },
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

async function getTask(ctx: McpContext, ticketId: string, taskId: string): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ticketId}/tasks/${taskId}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to get task: ${response.statusText}`);
  }
  return response.json();
}

async function createTask(
  ctx: McpContext,
  ticketId: string,
  description: string,
  body?: string,
  complexity?: string,
): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ticketId}/tasks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, ...(body && { body }), ...(complexity && { complexity }) }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to create task: ${response.statusText}`);
  }
  return response.json();
}

async function updateTaskStatus(
  ctx: McpContext,
  ticketId: string,
  taskId: string,
  status: string,
): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ticketId}/tasks/${taskId}`,
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
  ticketId: string,
  taskId: string,
  text: string,
): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ticketId}/tasks/${taskId}/comments`,
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

async function listTasksForTicket(ctx: McpContext, ticketId: string): Promise<Task[]> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ticketId}/tasks`,
  );
  if (!response.ok) {
    throw new Error(`Failed to list tasks: ${response.statusText}`);
  }
  return response.json();
}

async function getActiveSession(
  ctx: McpContext,
  ticketId: string,
): Promise<{ id: string } | null> {
  try {
    const response = await fetch(
      `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ticketId}/active-session`,
    );
    if (!response.ok) return null;
    const data = await response.json() as { session?: { id: string } };
    return data.session ?? null;
  } catch {
    return null;
  }
}

const VALID_TASK_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];

export const taskHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  list_tasks: async (ctx, args) => {
    const ticketId = (args.ticketId as string) ?? ctx.ticketId;
    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required (pass as arg or use a session context)" }] };
    }
    const tasks = await listTasksForTicket(ctx, ticketId);
    return {
      content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
    };
  },

  get_task: async (ctx, args) => {
    const ticketId = (args.ticketId as string) ?? ctx.ticketId;
    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required (pass as arg or use a session context)" }] };
    }
    if (!args.taskId || typeof args.taskId !== "string") {
      throw new Error("Missing required field: taskId");
    }
    const task = await getTask(ctx, ticketId, args.taskId);
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    };
  },

  create_task: async (ctx, args) => {
    const ticketId = (args.ticketId as string) ?? ctx.ticketId;
    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required (pass as arg or use a session context)" }] };
    }
    if (!args.description || typeof args.description !== "string") {
      throw new Error("Missing required field: description");
    }
    // Session-active write guard
    if (!args.force) {
      const activeSession = await getActiveSession(ctx, ticketId);
      if (activeSession) {
        return {
          content: [{
            type: "text",
            text: `Warning: ticket ${ticketId} has an active session (${activeSession.id}). ` +
                  `Mutating its state from outside may conflict with the running agent. ` +
                  `Pass force: true in args to proceed anyway.`,
          }],
          isError: false,
        };
      }
    }
    // Duplicate detection: check if a task with the same description prefix exists
    let existingTasks: Task[];
    try {
      existingTasks = await listTasksForTicket(ctx, ticketId);
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to fetch existing tasks for dedup check: ${err instanceof Error ? err.message : String(err)}. Aborting task creation to prevent duplicates.` }],
        isError: true,
      };
    }
    const newPrefix = extractDescriptionPrefix(args.description);
    if (newPrefix) {
      const duplicate = existingTasks.find(
        (t) => t.status !== "cancelled" && extractDescriptionPrefix(t.description) === newPrefix
      );
      if (duplicate) {
        return {
          content: [{
            type: "text",
            text: `Duplicate detected: task "${duplicate.id}" already has description prefix "${newPrefix}". ` +
                  `Skipping creation. Existing task: ${JSON.stringify({ id: duplicate.id, description: duplicate.description, status: duplicate.status })}`,
          }],
          isError: false,
        };
      }
    }
    // Resolve body: body_from takes precedence over body
    let body: string | undefined;
    if (args.body_from && typeof args.body_from === "object") {
      const bodyFrom = args.body_from as BodyFrom;
      if (!bodyFrom.artifact || !bodyFrom.start_marker) {
        throw new Error("body_from requires 'artifact' and 'start_marker' fields");
      }
      body = await resolveBodyFrom(ctx, ticketId, bodyFrom);
    } else {
      body = typeof args.body === "string" ? args.body : undefined;
    }
    const complexity = typeof args.complexity === "string" ? args.complexity : undefined;
    // Nudge: warn if using inline body when specification.md exists
    let specExists = false;
    if (args.body && !args.body_from) {
      try {
        const safeProject = ctx.projectId.replace(/\//g, "__");
        const specPath = path.join(TASKS_DIR, safeProject, ticketId, "artifacts", "specification.md");
        await fs.access(specPath);
        specExists = true;
      } catch {
        // specification.md doesn't exist, proceed normally
      }
    }
    const task = await createTask(ctx, ticketId, args.description, body, complexity);
    if (specExists) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(task, null, 2) +
                "\n\n⚠️ Warning: specification.md exists for this ticket. " +
                "Consider using body_from with artifact markers instead of inline body to save tokens and preserve exact spec content.",
        }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    };
  },

  update_task_status: async (ctx, args) => {
    const ticketId = (args.ticketId as string) ?? ctx.ticketId;
    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required (pass as arg or use a session context)" }] };
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
    // Session-active write guard
    if (!args.force) {
      const activeSession = await getActiveSession(ctx, ticketId);
      if (activeSession) {
        return {
          content: [{
            type: "text",
            text: `Warning: ticket ${ticketId} has an active session (${activeSession.id}). ` +
                  `Mutating its state from outside may conflict with the running agent. ` +
                  `Pass force: true in args to proceed anyway.`,
          }],
          isError: false,
        };
      }
    }
    const task = await updateTaskStatus(ctx, ticketId, args.taskId, args.status);
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    };
  },

  add_comment_to_task: async (ctx, args) => {
    const ticketId = (args.ticketId as string) ?? ctx.ticketId;
    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required (pass as arg or use a session context)" }] };
    }
    if (!args.taskId || typeof args.taskId !== "string") {
      throw new Error("Missing required field: taskId");
    }
    if (!args.text || typeof args.text !== "string") {
      throw new Error("Missing required field: text");
    }
    const task = await addCommentToTask(ctx, ticketId, args.taskId, args.text);
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
    };
  },
};
