import { getTicket, updateTicket } from "../../stores/ticket.store.js";
import { getPhaseConfig } from "../../services/session/phase-config.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";
import type { Complexity } from "../../types/ticket.types.js";

const VALID_COMPLEXITIES: readonly Complexity[] = [
  "simple",
  "standard",
  "complex",
];

function errorResult(message: string): McpToolResult & { isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function resolveTicketId(
  ctx: McpContext,
  args: Record<string, unknown>,
): string | undefined {
  return (args.ticketId as string | undefined) ?? ctx.ticketId;
}

export const pmTools: ToolDefinition[] = [
  {
    name: "move_ticket",
    mcpServer: "pm" as const,
    description:
      "Move a ticket to another phase. Uses the daemon ticket route so lifecycle invalidation and session management stay consistent.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to move. Defaults to the current session ticket when available.",
        },
        targetPhase: {
          type: "string",
          description: "Phase to move the ticket into.",
        },
        overrideDependencies: {
          type: "boolean",
          description: "Allow the move even when dependency guards would normally block it.",
        },
      },
      required: ["targetPhase"],
    },
  },
  {
    name: "update_ticket",
    mcpServer: "pm" as const,
    description:
      "Update a ticket's title and/or description metadata without changing lifecycle state.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to update. Defaults to the current session ticket when available.",
        },
        title: {
          type: "string",
          description: "Updated ticket title.",
        },
        description: {
          type: "string",
          description: "Updated ticket description.",
        },
      },
      required: [],
    },
  },
  {
    name: "set_ticket_complexity",
    mcpServer: "pm" as const,
    description:
      "Set a ticket's complexity metadata. Valid values: simple, standard, complex.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "Ticket ID to update. Defaults to the current session ticket when available.",
        },
        complexity: {
          type: "string",
          enum: [...VALID_COMPLEXITIES],
          description: "Complexity value to store on the ticket.",
        },
      },
      required: ["complexity"],
    },
  },
];

export const pmHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  move_ticket: async (ctx, args) => {
    const ticketId = resolveTicketId(ctx, args);
    const targetPhase = args.targetPhase as string | undefined;
    const overrideDependencies = args.overrideDependencies as boolean | undefined;

    if (!ticketId) {
      return errorResult(
        "Error: ticketId is required (pass as arg or use a session context)",
      );
    }

    if (!targetPhase) {
      return errorResult("Error: targetPhase is required");
    }

    const isPmBrainstormSession = !!ctx.brainstormId && !ctx.ticketId;
    if (isPmBrainstormSession && ctx.workflowId) {
      const ticket = getTicket(ctx.projectId, ticketId);
      const [currentPhaseConfig, targetPhaseConfig] = await Promise.all([
        getPhaseConfig(ctx.projectId, ticket.phase, ctx.workflowId),
        getPhaseConfig(ctx.projectId, targetPhase, ctx.workflowId),
      ]);

      if (currentPhaseConfig?.transitions?.manual) {
        return errorResult(
          `Error: PM agents cannot move ticket ${ticketId} out of manual phase '${ticket.phase}'. Notify the user and wait for direct human action instead.`,
        );
      }

      if (targetPhaseConfig?.transitions?.manual) {
        return errorResult(
          `Error: PM agents cannot move ticket ${ticketId} into manual phase '${targetPhase}'. Notify the user and wait for direct human action instead.`,
        );
      }
    }

    try {
      const response = await fetch(
        `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${encodeURIComponent(ticketId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phase: targetPhase,
            overrideDependencies: overrideDependencies ?? false,
          }),
        },
      );

      if (!response.ok) {
        return errorResult(`Error: Failed to move ticket: ${response.statusText}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Ticket ${ticketId} moved to ${targetPhase}`,
          },
        ],
      };
    } catch (error) {
      return errorResult(
        `Error: Failed to move ticket: ${(error as Error).message}`,
      );
    }
  },

  update_ticket: async (ctx, args) => {
    const ticketId = resolveTicketId(ctx, args);
    const title = args.title as string | undefined;
    const description = args.description as string | undefined;

    if (!ticketId) {
      return errorResult(
        "Error: ticketId is required (pass as arg or use a session context)",
      );
    }

    if (title === undefined && description === undefined) {
      return errorResult(
        "Error: At least one of title or description is required",
      );
    }

    await updateTicket(ctx.projectId, ticketId, {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    });

    return {
      content: [
        {
          type: "text",
          text: `Ticket ${ticketId} updated`,
        },
      ],
    };
  },

  set_ticket_complexity: async (ctx, args) => {
    const ticketId = resolveTicketId(ctx, args);
    const complexity = args.complexity as string | undefined;

    if (!ticketId) {
      return errorResult(
        "Error: ticketId is required (pass as arg or use a session context)",
      );
    }

    if (!complexity || !VALID_COMPLEXITIES.includes(complexity as Complexity)) {
      return errorResult(
        "Error: complexity must be one of: simple, standard, complex",
      );
    }

    await updateTicket(ctx.projectId, ticketId, {
      complexity: complexity as Complexity,
    });

    return {
      content: [
        {
          type: "text",
          text: `Ticket ${ticketId} complexity set to ${complexity}`,
        },
      ],
    };
  },
};
