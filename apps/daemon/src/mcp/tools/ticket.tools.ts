import fs from "fs/promises";
import path from "path";
import { TASKS_DIR } from "../../config/paths.js";
import { eventBus } from "../../utils/event-bus.js";
import { getTicket as getTicketFromStore } from "../../stores/ticket.store.js";
import { addMessage } from "../../stores/conversation.store.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";
import type { ArtifactManifest, ArtifactEntry } from "../../types/index.js";
import type { DependencyTier } from "@potato-cannon/shared";

export const ticketTools: ToolDefinition[] = [
  {
    name: "get_ticket",
    description:
      "Get ticket details including phase, title, and description. Pass ticketId to query a specific ticket; omit to use session context.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to query (e.g. 'POT-14'). Required in headless/external mode.",
        },
      },
      required: [],
    },
  },
  {
    name: "attach_artifact",
    scope: "session",
    description:
      "Attach an artifact file to the ticket. The file path should be relative to the worktree.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Path to the artifact file (relative to worktree or absolute)",
        },
        artifact_type: {
          type: "string",
          description:
            'File extension of the artifact (e.g., ".md", ".txt", ".pdf")',
        },
        description: {
          type: "string",
          description: "Brief description of the artifact",
        },
      },
      required: ["file_path", "artifact_type"],
    },
  },
  {
    name: "add_ticket_comment",
    mcpServer: "pm" as const,
    description:
      "Add a comment/note to the ticket for tracking progress or issues",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to comment on. Required in headless/external mode.",
        },
        comment: {
          type: "string",
          description: "The comment text",
        },
      },
      required: ["comment"],
    },
  },
  {
    name: "create_ticket",
    mcpServer: "pm" as const,
    description:
      "Create a new ticket in the current project. Use this to convert a brainstorm into a formal ticket.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The ticket title",
        },
        description: {
          type: "string",
          description: "The ticket description (markdown)",
        },
        brainstormId: {
          type: "string",
          description: "Optional brainstorm ID this ticket originated from",
        },
        dependsOn: {
          type: "array",
          description:
            "Optional dependencies to create for the new ticket.",
          items: {
            type: "object",
            properties: {
              ticketId: {
                type: "string",
                description: "The ticket this new ticket depends on.",
              },
              tier: {
                type: "string",
                enum: ["artifact-ready", "code-ready"],
                description: "The dependency tier to enforce.",
              },
            },
            required: ["ticketId", "tier"],
          },
        },
      },
      required: ["title"],
    },
  },
  {
    name: "set_ticket_complexity",
    scope: "session",
    description:
      "Set the complexity rating of the current ticket. Call after estimating complexity using the potato:estimate-complexity skill. Valid values: simple, standard, complex.",
    inputSchema: {
      type: "object",
      properties: {
        complexity: {
          type: "string",
          enum: ["simple", "standard", "complex"],
          description:
            "Complexity rating: simple (<=1 file, <=1 step), standard (2-3 files, routine), complex (4+ files, new patterns, security, integration)",
        },
      },
      required: ["complexity"],
    },
  },
  {
    name: "list_tickets",
    mcpServer: "pm" as const,
    description:
      "List tickets for the current project. Returns a compact array with id, title, phase, complexity, and active session status.",
    inputSchema: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          description: "Optional phase filter (e.g., 'Build', 'Review'). Omit to return all tickets.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_project_overview",
    description:
      "Get a compact overview of the current project: tickets grouped by phase, active sessions, blocked tickets, and totals.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_projects",
    scope: "external" as const,
    description:
      "List all registered projects. Returns id, name, slug, and template for each. Use this to discover projectIds before calling other tools.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

interface CommentEntry {
  text: string;
  createdAt: string;
}

interface CreateTicketDependencyInput {
  ticketId: string;
  tier: DependencyTier;
}

async function getTicket(ctx: McpContext, ticketId: string): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ticketId}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to get ticket: ${response.statusText}`);
  }
  return await response.json();
}

async function attachArtifact(
  ctx: McpContext,
  filePath: string,
  artifactType: string,
  description?: string,
): Promise<{ filename: string; type: string; isNewVersion: boolean }> {
  const cwd = process.cwd();
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(cwd, filePath);

  const content = await fs.readFile(fullPath, "utf-8");
  const filename = path.basename(fullPath);

  const safeProject = ctx.projectId.replace(/\//g, "__");
  const artifactsDir = path.join(
    TASKS_DIR,
    safeProject,
    ctx.ticketId!,
    "artifacts",
  );
  await fs.mkdir(artifactsDir, { recursive: true });

  // Fetch the current ticket phase
  let currentPhase: string | undefined;
  try {
    const ticket = await getTicketFromStore(ctx.projectId, ctx.ticketId!);
    currentPhase = ticket.phase;
  } catch {
    // Ticket may not exist, phase will be undefined
  }

  const manifestPath = path.join(artifactsDir, "manifest.json");
  let manifest: ArtifactManifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  } catch {
    // File doesn't exist yet
  }

  const now = new Date().toISOString();
  const artifactPath = path.join(artifactsDir, filename);
  let isNewVersion = false;

  if (manifest[filename]) {
    // Existing artifact - create a version
    const existing = manifest[filename];
    const nextVersion = existing.versions.length + 1;

    // Copy current file to versioned filename
    const versionedFilename = `${filename}.v${nextVersion}`;
    const versionedPath = path.join(artifactsDir, versionedFilename);
    await fs.copyFile(artifactPath, versionedPath);

    // Push current metadata to versions array
    existing.versions.push({
      version: nextVersion,
      savedAt: existing.savedAt,
      description: existing.description,
      path: existing.path,
    });

    // Update current entry
    existing.savedAt = now;
    existing.description = description || existing.description;
    existing.path = filePath;
    existing.phase = currentPhase;
    existing.type = artifactType as ArtifactEntry["type"];

    isNewVersion = true;
  } else {
    // New artifact
    manifest[filename] = {
      type: artifactType as ArtifactEntry["type"],
      description: description || "",
      savedAt: now,
      path: filePath,
      phase: currentPhase,
      versions: [],
    };
  }

  // Write the new content
  await fs.writeFile(artifactPath, content);

  // Save manifest
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Add artifact message to conversation (if ticket has one)
  const ticket = await getTicketFromStore(ctx.projectId, ctx.ticketId!);
  if (ticket.conversationId) {
    addMessage(ticket.conversationId, {
      type: "artifact",
      text: description || filename,
      metadata: {
        artifact: { filename, description: description || undefined },
      },
    });
  }

  // Emit event so frontend can refresh artifact list
  eventBus.emit("ticket:updated", {
    projectId: ctx.projectId,
    ticketId: ctx.ticketId,
  });

  return { filename, type: artifactType, isNewVersion };
}

async function addTicketComment(
  ctx: McpContext,
  ticketId: string,
  comment: string,
): Promise<{ success: boolean }> {
  const safeProject = ctx.projectId.replace(/\//g, "__");
  const ticketDir = path.join(TASKS_DIR, safeProject, ticketId);
  await fs.mkdir(ticketDir, { recursive: true });

  const commentsFile = path.join(ticketDir, "comments.json");
  let comments: CommentEntry[] = [];
  try {
    comments = JSON.parse(await fs.readFile(commentsFile, "utf-8"));
  } catch {
    // File doesn't exist yet
  }

  comments.push({
    text: comment,
    createdAt: new Date().toISOString(),
  });

  await fs.writeFile(commentsFile, JSON.stringify(comments, null, 2));

  return { success: true };
}

async function createTicket(
  ctx: McpContext,
  title: string,
  description?: string,
  brainstormId?: string,
): Promise<unknown> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: description || "",
        brainstormId,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to create ticket: ${response.statusText}`);
  }
  return await response.json();
}

async function createTicketDependency(
  ctx: McpContext,
  ticketId: string,
  dependency: CreateTicketDependencyInput,
): Promise<void> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${encodeURIComponent(ticketId)}/dependencies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dependsOn: dependency.ticketId,
        tier: dependency.tier,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to create dependency on ${dependency.ticketId}: ${response.statusText}`,
    );
  }
}

export const ticketHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  get_ticket: async (ctx, args) => {
    const ticketId = (args.ticketId as string) ?? ctx.ticketId;
    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required (pass as arg or use a session context)" }] };
    }
    const ticket = await getTicket(ctx, ticketId);
    return {
      content: [{ type: "text", text: JSON.stringify(ticket, null, 2) }],
    };
  },

  attach_artifact: async (ctx, args) => {
    if (!ctx.ticketId) {
      return { content: [{ type: "text", text: "Error: attach_artifact requires a ticket session context" }] };
    }
    const result = await attachArtifact(
      ctx,
      args.file_path as string,
      args.artifact_type as string,
      args.description as string | undefined,
    );
    const versionMsg = result.isNewVersion ? " (new version)" : "";
    return {
      content: [
        {
          type: "text",
          text: `Artifact attached: ${result.filename} (${result.type})${versionMsg}`,
        },
      ],
    };
  },

  add_ticket_comment: async (ctx, args) => {
    const ticketId = (args.ticketId as string) ?? ctx.ticketId;
    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required (pass as arg or use a session context)" }] };
    }
    await addTicketComment(ctx, ticketId, args.comment as string);
    return {
      content: [{ type: "text", text: "Comment added" }],
    };
  },

  create_ticket: async (ctx, args) => {
    const dependsOn = (Array.isArray(args.dependsOn)
      ? args.dependsOn
      : []) as CreateTicketDependencyInput[];
    const ticket = (await createTicket(
      ctx,
      args.title as string,
      args.description as string | undefined,
      args.brainstormId as string | undefined,
    )) as { id: string; title: string };

    for (const dependency of dependsOn) {
      try {
        await createTicketDependency(ctx, ticket.id, dependency);
      } catch (error) {
        console.warn(
          `[create_ticket] Failed to create dependency ${ticket.id} -> ${dependency.ticketId}: ${(error as Error).message}`,
        );
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Ticket created: ${ticket.id} - ${ticket.title}`,
        },
      ],
    };
  },

  list_tickets: async (ctx, args) => {
    const phase = args.phase as string | undefined;
    let url = `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}`;
    if (phase) {
      url += `?phase=${encodeURIComponent(phase)}`;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to list tickets: ${response.statusText}`);
    }
    const tickets = (await response.json()) as Array<{
      id: string;
      title: string;
      phase: string;
      complexity?: string;
      hasActiveSession?: boolean;
    }>;
    const compact = tickets.map((t) => ({
      id: t.id,
      title: t.title,
      phase: t.phase,
      complexity: t.complexity ?? null,
      hasActiveSession: t.hasActiveSession ?? false,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
    };
  },

  get_project_overview: async (ctx) => {
    // Fetch all tickets for the project
    const response = await fetch(
      `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch tickets: ${response.statusText}`);
    }
    const tickets = (await response.json()) as Array<{
      id: string;
      title: string;
      phase: string;
      complexity?: string;
      hasActiveSession?: boolean;
      blockedBy?: Array<{ ticketId: string; satisfied: boolean }>;
    }>;

    // Group by phase
    const ticketsByPhase: Record<string, Array<{ id: string; title: string }>> = {};
    let activeSessions = 0;
    const blockedTickets: Array<{ id: string; title: string; blockedBy: string[] }> = [];

    for (const t of tickets) {
      if (!ticketsByPhase[t.phase]) {
        ticketsByPhase[t.phase] = [];
      }
      ticketsByPhase[t.phase].push({ id: t.id, title: t.title });

      if (t.hasActiveSession) {
        activeSessions++;
      }

      const unsatisfied = (t.blockedBy ?? []).filter((b) => !b.satisfied);
      if (unsatisfied.length > 0) {
        blockedTickets.push({
          id: t.id,
          title: t.title,
          blockedBy: unsatisfied.map((b) => b.ticketId),
        });
      }
    }

    const overview = {
      projectId: ctx.projectId,
      activeSessions,
      ticketsByPhase,
      blockedTickets,
      totalTickets: tickets.length,
      as_of: new Date().toISOString(),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(overview, null, 2) }],
    };
  },

  list_projects: async (ctx) => {
    const response = await fetch(`${ctx.daemonUrl}/api/projects`);
    if (!response.ok) {
      throw new Error(`Failed to list projects: ${response.statusText}`);
    }
    const projects = (await response.json()) as Array<{
      id: string;
      displayName: string;
      slug?: string;
      template?: { name: string };
    }>;
    const compact = projects.map((p) => ({
      id: p.id,
      name: p.displayName,
      slug: p.slug ?? null,
      template: p.template?.name ?? null,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
    };
  },

  set_ticket_complexity: async (ctx, args) => {
    if (!ctx.ticketId) {
      return { content: [{ type: 'text', text: 'Error: set_ticket_complexity requires a ticket context' }] };
    }
    const { complexity } = args as { complexity: string };
    const response = await fetch(
      `${ctx.daemonUrl}/api/projects/${encodeURIComponent(ctx.projectId)}/tickets/${ctx.ticketId}/complexity`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ complexity }),
      },
    );
    if (!response.ok) {
      return { content: [{ type: "text", text: `Error: ${response.statusText}` }] };
    }
    return { content: [{ type: "text", text: `Complexity set to: ${complexity}` }] };
  },
};
