import { getTicketsByBrainstormId } from "../../stores/ticket.store.js";
import {
  getBrainstorm,
  updateBrainstormPmConfig,
} from "../../stores/brainstorm.store.js";
import { listTasks } from "../../stores/task.store.js";
import { ticketDependencyGetForTicket } from "../../stores/ticket-dependency.store.js";
import { getPendingQuestion } from "../../stores/conversation.store.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";
import type { Ticket } from "../../types/index.js";
import {
  DEFAULT_PM_CONFIG,
  type BlockedByEntry,
  type PmMode,
} from "@potato-cannon/shared";

// =============================================================================
// Tool Definitions
// =============================================================================

export const epicTools: ToolDefinition[] = [
  {
    name: "get_epic_status",
    mcpServer: "pm" as const,
    description:
      "Get a structured snapshot of an entire epic's state: all tickets with their phase, tasks, dependencies, and how long they have been in the current phase. Use this to understand epic health and identify stuck or blocked tickets.",
    inputSchema: {
      type: "object",
      properties: {
        brainstormId: {
          type: "string",
          description:
            "The epic/brainstorm ID to query. Defaults to the session's brainstorm context if omitted.",
        },
      },
      required: [],
    },
    scope: "session",
  },
  {
    name: "set_epic_pm_mode",
    mcpServer: "pm" as const,
    description:
      'Set the PM monitoring mode for the current epic. Use "passive" to disable monitoring, "watching" to enable alerts, "executing" to enable autonomous advancement.',
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["passive", "watching", "executing"],
          description: "The PM mode to set.",
        },
        brainstormId: {
          type: "string",
          description:
            "Epic/brainstorm ID. Defaults to the current session context.",
        },
      },
      required: ["mode"],
    },
    scope: "session",
  },
];

// =============================================================================
// Types
// =============================================================================

interface TicketSnapshot {
  id: string;
  title: string;
  phase: string;
  complexity: string;
  stuckSince: string | null;
  hasPendingQuestion: boolean;
  taskCounts: { total: number; completed: number; failed: number };
  blockedBy: Array<{ ticketId: string; title: string; currentPhase: string; tier: string; satisfied: boolean }>;
}

interface EpicStatusResult {
  epicId: string;
  title: string;
  pmEnabled: boolean;
  tickets: TicketSnapshot[];
  summary: {
    total: number;
    done: number;
    active: number;
    blocked: number;
    withActiveSessions: number;
  };
  as_of: string;
}

// =============================================================================
// Handler Helpers
// =============================================================================

function buildTicketSnapshot(ticket: Ticket): TicketSnapshot {
  const tasks = listTasks(ticket.id);
  const deps: BlockedByEntry[] = ticketDependencyGetForTicket(ticket.id);

  // Find the entered_at for the current phase from history
  const currentHistoryEntry = ticket.history
    .slice()
    .reverse()
    .find((h) => h.phase === ticket.phase && !h.endedAt);
  const stuckSince = currentHistoryEntry?.at ?? null;

  const taskCounts = {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    failed: tasks.filter((t) => t.status === "failed").length,
  };

  const blockedBy = deps.map((dep) => ({
    ticketId: dep.ticketId,
    title: dep.title,
    currentPhase: dep.currentPhase,
    tier: dep.tier,
    satisfied: dep.satisfied,
  }));

  const hasPendingQuestion = ticket.conversationId
    ? Boolean(getPendingQuestion(ticket.conversationId))
    : false;

  return {
    id: ticket.id,
    title: ticket.title,
    phase: ticket.phase,
    complexity: ticket.complexity,
    stuckSince,
    hasPendingQuestion,
    taskCounts,
    blockedBy,
  };
}

// =============================================================================
// Handlers
// =============================================================================

export const epicHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  get_epic_status: async (ctx, args) => {
    const brainstormId = (args.brainstormId as string | undefined) ?? ctx.brainstormId;

    if (!brainstormId) {
      return {
        content: [
          {
            type: "text",
            text: "Error: brainstormId is required (pass as arg or use a brainstorm session context)",
          },
        ],
      };
    }

    // Load brainstorm metadata
    const brainstorm = await getBrainstorm(ctx.projectId, brainstormId);
    if (!brainstorm) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Epic/brainstorm '${brainstormId}' not found in project '${ctx.projectId}'`,
          },
        ],
      };
    }

    // Load all non-archived tickets for this epic
    const tickets = getTicketsByBrainstormId(brainstormId);

    // Build per-ticket snapshots
    const ticketSnapshots = tickets.map(buildTicketSnapshot);

    // Compute summary counts
    const doneCount = ticketSnapshots.filter((t) => t.phase === "Done").length;
    const blockedCount = ticketSnapshots.filter(
      (t) => t.blockedBy.some((b) => !b.satisfied)
    ).length;

    const result: EpicStatusResult = {
      epicId: brainstormId,
      title: brainstorm.name,
      pmEnabled: brainstorm.pmEnabled ?? false,
      tickets: ticketSnapshots,
      summary: {
        total: ticketSnapshots.length,
        done: doneCount,
        active: ticketSnapshots.length - doneCount,
        blocked: blockedCount,
        withActiveSessions: 0, // Session tracking is runtime state — not queried here
      },
      as_of: new Date().toISOString(),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
  set_epic_pm_mode: async (ctx, args) => {
    const brainstormId = (args.brainstormId as string | undefined) ?? ctx.brainstormId;
    const mode = args.mode as PmMode | undefined;

    if (!brainstormId) {
      return {
        content: [
          {
            type: "text",
            text: "Error: no brainstormId in context or args",
          },
        ],
      };
    }

    if (mode !== "passive" && mode !== "watching" && mode !== "executing") {
      return {
        content: [
          {
            type: "text",
            text: "Error: mode must be one of: passive, watching, executing",
          },
        ],
      };
    }

    let brainstorm;
    try {
      brainstorm = await getBrainstorm(ctx.projectId, brainstormId);
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `Error: epic '${brainstormId}' not found`,
          },
        ],
      };
    }

    const pmEnabled = mode !== "passive";
    const existing = brainstorm.pmConfig ?? DEFAULT_PM_CONFIG;
    const updatedPmConfig = {
      ...DEFAULT_PM_CONFIG,
      ...existing,
      mode,
      polling: {
        ...DEFAULT_PM_CONFIG.polling,
        ...(existing.polling ?? {}),
      },
      alerts: {
        ...DEFAULT_PM_CONFIG.alerts,
        ...(existing.alerts ?? {}),
      },
    };

    updateBrainstormPmConfig(brainstormId, {
      pmEnabled,
      pmConfig: updatedPmConfig,
    });

    return {
      content: [
        {
          type: "text",
          text: `PM mode for epic '${brainstorm.name}' set to '${mode}'`,
        },
      ],
    };
  },
};
