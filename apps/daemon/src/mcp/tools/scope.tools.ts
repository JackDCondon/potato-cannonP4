import {
  ticketDependencyGetDependents,
} from "../../stores/ticket-dependency.store.js";
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
