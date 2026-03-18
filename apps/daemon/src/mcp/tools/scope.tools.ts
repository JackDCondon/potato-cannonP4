import {
  ticketDependencyGetDependents,
  ticketDependencyGetForTicket,
} from "../../stores/ticket-dependency.store.js";
import { getTicketsByBrainstormId } from "../../stores/ticket.store.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";

// =============================================================================
// Tool Definitions
// =============================================================================

export const scopeTools: ToolDefinition[] = [
  {
    name: "set_plan_summary",
    description:
      "Store a plan summary for the current brainstorm. Call this after creating all tickets to describe the overall goal and each ticket's role. This summary will be shown to every agent working on tickets from this brainstorm.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Concise plan summary (100-200 words). One paragraph for the goal, then a bullet per ticket describing its role.",
        },
      },
      required: ["summary"],
    },
    scope: "session",
  },
  {
    name: "get_dependents",
    description:
      "Get tickets that depend on this ticket (reverse dependency lookup). Shows what downstream work is waiting for your completion.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to check. Defaults to current session ticket.",
        },
      },
      required: [],
    },
    scope: "session",
  },
  {
    name: "get_scope_context",
    description:
      "Get a complete scope briefing for the current ticket: its role in the broader plan, sibling tickets, upstream dependencies, and downstream dependents. Call this once at the start of your session to understand your scope.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to query. Defaults to current session ticket.",
        },
      },
      required: [],
    },
    scope: "session",
  },
];

// =============================================================================
// Handlers
// =============================================================================

export const scopeHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  set_plan_summary: async (ctx, args) => {
    const summary = args.summary as string;
    if (!summary) {
      return {
        content: [{ type: "text", text: "Error: summary is required" }],
        isError: true,
      } as McpToolResult & { isError: true };
    }

    if (!ctx.brainstormId) {
      return {
        content: [
          {
            type: "text",
            text: "Error: set_plan_summary can only be called in a brainstorm session context",
          },
        ],
        isError: true,
      } as McpToolResult & { isError: true };
    }

    const response = await fetch(
      `${ctx.daemonUrl}/api/brainstorms/${encodeURIComponent(ctx.projectId)}/${encodeURIComponent(ctx.brainstormId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planSummary: summary }),
      },
    );

    if (!response.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Failed to set plan summary: ${response.statusText}`,
          },
        ],
        isError: true,
      } as McpToolResult & { isError: true };
    }

    return {
      content: [{ type: "text", text: "Plan summary saved successfully." }],
    };
  },

  get_scope_context: async (ctx, args) => {
    const ticketId = (args.ticketId as string) || ctx.ticketId;
    if (!ticketId) {
      return {
        content: [{ type: "text", text: "Error: no ticketId available" }],
        isError: true,
      } as McpToolResult & { isError: true };
    }

    // Fetch ticket
    let ticketResponse: Response;
    try {
      ticketResponse = await fetch(
        `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${encodeURIComponent(ticketId)}`,
      );
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: failed to fetch ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      } as McpToolResult & { isError: true };
    }
    if (!ticketResponse.ok) {
      return {
        content: [{ type: "text", text: `Error: ticket ${ticketId} not found` }],
        isError: true,
      } as McpToolResult & { isError: true };
    }
    const ticket = (await ticketResponse.json()) as {
      id: string;
      title: string;
      description?: string;
      phase: string;
      complexity: string;
      brainstormId?: string;
    };

    // Truncate description to keep token budget lean
    const desc = ticket.description || "";
    const truncatedDesc = desc.length > 500 ? desc.slice(0, 500) + "..." : desc;

    // Fetch origin (brainstorm) if linked
    let origin: {
      brainstormId: string;
      brainstormName: string;
      planSummary: string | null;
    } | null = null;
    let siblings: {
      ticketId: string;
      title: string;
      phase: string;
      complexity: string;
    }[] = [];

    if (ticket.brainstormId) {
      try {
        const brainstormResponse = await fetch(
          `${ctx.daemonUrl}/api/brainstorms/${encodeURIComponent(ctx.projectId)}/${encodeURIComponent(ticket.brainstormId)}`,
        );
        if (brainstormResponse.ok) {
          const brainstorm = (await brainstormResponse.json()) as {
            id: string;
            name: string;
            planSummary?: string;
          };
          origin = {
            brainstormId: brainstorm.id,
            brainstormName: brainstorm.name,
            planSummary: brainstorm.planSummary ?? null,
          };
        }
      } catch {
        // Brainstorm fetch failed, continue without origin
      }

      // Get sibling tickets (same brainstorm, excluding self)
      const allSiblings = getTicketsByBrainstormId(ticket.brainstormId);
      siblings = allSiblings
        .filter((t) => t.id !== ticketId)
        .map((t) => ({
          ticketId: t.id,
          title: t.title,
          phase: t.phase,
          complexity: t.complexity,
        }));
    }

    // Dependencies (upstream)
    const deps = ticketDependencyGetForTicket(ticketId);
    const dependsOn = deps.map((d) => ({
      ticketId: d.ticketId,
      title: d.title,
      currentPhase: d.currentPhase,
      tier: d.tier,
      satisfied: d.satisfied,
    }));

    // Dependents (downstream)
    const rawDependents = ticketDependencyGetDependents(ticketId);
    const dependedOnBy = rawDependents.map((d) => ({
      ticketId: d.ticketId,
      title: d.title,
      currentPhase: d.currentPhase,
      tier: d.tier,
      satisfied: d.satisfied,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ticket: {
                id: ticket.id,
                title: ticket.title,
                description: truncatedDesc,
                phase: ticket.phase,
                complexity: ticket.complexity,
              },
              origin,
              dependsOn,
              dependedOnBy,
              siblings,
            },
            null,
            2,
          ),
        },
      ],
    };
  },

  get_dependents: async (ctx, args) => {
    const ticketId = (args.ticketId as string) || ctx.ticketId;
    if (!ticketId) {
      return {
        content: [{ type: "text", text: "Error: no ticketId available" }],
        isError: true,
      } as McpToolResult & { isError: true };
    }

    const dependents = ticketDependencyGetDependents(ticketId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ dependents }, null, 2),
        },
      ],
    };
  },
};
