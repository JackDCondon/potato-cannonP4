import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";

export const ralphTools: ToolDefinition[] = [
  {
    name: "ralph_loop_dock",
    scope: "session",
    description:
      "Signal the verdict for a ralph loop iteration. Call this to approve or reject work with feedback. If not called, the system falls back to using exit code (0 = approved).",
    inputSchema: {
      type: "object",
      properties: {
        approved: {
          type: "boolean",
          description: "Whether the work is approved",
        },
        feedback: {
          type: "string",
          description:
            "Feedback explaining why work was rejected. Required if approved is false.",
        },
      },
      required: ["approved"],
    },
  },
];

async function submitVerdict(
  ctx: McpContext,
  approved: boolean,
  feedback?: string,
): Promise<{ success: boolean }> {
  const response = await fetch(
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ctx.ticketId}/ralph-verdict`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved, feedback }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to submit verdict: ${response.statusText}`);
  }
  return response.json();
}

export const ralphHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  ralph_loop_dock: async (ctx, args) => {
    if (!ctx.ticketId) {
      throw new Error("Missing context.ticketId - ralph tools require a ticket context");
    }
    if (typeof args.approved !== "boolean") {
      throw new Error("Missing required field: approved (boolean)");
    }
    if (!args.approved && (!args.feedback || typeof args.feedback !== "string")) {
      throw new Error("Feedback is required when approved is false");
    }

    const feedback = typeof args.feedback === "string" ? args.feedback : undefined;
    await submitVerdict(ctx, args.approved, feedback);

    return {
      content: [
        {
          type: "text",
          text: args.approved
            ? "Verdict recorded: APPROVED"
            : `Verdict recorded: REJECTED - ${feedback}`,
        },
      ],
    };
  },
};
