import type { Express, Request, Response } from "express";
import { DEFAULT_PORT } from "@potato-cannon/shared";
import { allTools, allHandlers } from "../../mcp/tools/index.js";
import { getMcpAuthToken, isValidMcpAuthHeader } from "../../mcp/auth.js";
import { appendTicketLog } from "../../stores/ticket-log.store.js";
import type { McpContext } from "../../types/mcp.types.js";
import {
  AGENT_SOURCE_PATTERN,
  filterToolsByDisallowList,
  findAgentWorkerInWorkflow,
} from "./mcp-tools-filter.js";

const PROJECT_EXEMPT_TOOLS = new Set(["list_projects"]);

function ensureAuthorized(req: Request, res: Response): boolean {
  const expectedToken = getMcpAuthToken();
  if (isValidMcpAuthHeader(req.headers?.authorization, expectedToken)) {
    return true;
  }

  res.status(401).json({ error: "Unauthorized" });
  return false;
}

export function registerMcpRoutes(app: Express): void {
  // List available tools (optional ?scope=external to filter out session-only tools)
  // Optional ?mcpServer=ticket|pm narrows the server-specific tool set.
  // Optional ?agentSource=agents/builder.md&projectId=... to apply disallowTools filtering.
  app.get("/mcp/tools", async (req: Request, res: Response) => {
    if (!ensureAuthorized(req, res)) {
      return;
    }

    const scope = req.query.scope as string | undefined;
    const mcpServer = req.query.mcpServer as "ticket" | "pm" | undefined;
    const { agentSource, projectId } = req.query as {
      agentSource?: string;
      projectId?: string;
    };

    let tools = scope === "external"
      ? allTools.filter((t) => t.scope !== "session")
      : [...allTools];

    if (mcpServer === "ticket") {
      tools = tools.filter((t) => t.mcpServer !== "pm");
    } else if (mcpServer === "pm") {
      tools = tools.filter((t) => t.mcpServer === "pm");
    }

    // Apply disallowTools filtering when agentSource and projectId are present and valid
    if (agentSource && projectId && AGENT_SOURCE_PATTERN.test(agentSource)) {
      try {
        const agentWorker = await findAgentWorkerInWorkflow(projectId, agentSource);
        if (agentWorker?.disallowTools?.length) {
          tools = filterToolsByDisallowList(tools, agentWorker.disallowTools);
        }
      } catch (error) {
        // Non-fatal: if workflow lookup fails, return the full tool list
        console.warn('[MCP] disallowTools lookup failed:', error);
      }
    }

    res.json({ tools });
  });

  // Call a tool
  app.post("/mcp/call", async (req: Request, res: Response) => {
    if (!ensureAuthorized(req, res)) {
      return;
    }

    try {
      const { tool, args, context } = req.body as {
        tool: string;
        args: Record<string, unknown>;
        context: {
          projectId: string;
          ticketId?: string;
          brainstormId?: string;
          workflowId?: string;
          agentModel?: string;
          agentSource?: string;
        };
      };

      if (!tool) {
        res.status(400).json({ error: "Missing tool name" });
        return;
      }

      // Log the MCP tool call
      const contextId = context?.ticketId || context?.brainstormId || "unknown";
      console.log(`[MCP] ${tool} called for ${contextId}`);

      // Also log to ticket-specific log file
      if (context?.projectId && context?.ticketId) {
        await appendTicketLog(
          context.projectId,
          context.ticketId,
          `[MCP] ${tool} called`,
        );
      }

      if (!context?.projectId && !PROJECT_EXEMPT_TOOLS.has(tool)) {
        res.status(400).json({ error: "Missing context.projectId" });
        return;
      }

      const handler = allHandlers[tool];
      if (!handler) {
        res.status(404).json({ error: `Unknown tool: ${tool}` });
        return;
      }

      // Build MCP context with daemon URL
      const port = req.socket.localPort || DEFAULT_PORT;
      const mcpContext: McpContext = {
        projectId: context.projectId,
        ticketId: context.ticketId || undefined,
        brainstormId: context.brainstormId || undefined,
        workflowId: context.workflowId || undefined,
        agentModel: context.agentModel,
        agentSource: context.agentSource || undefined,
        daemonUrl: `http://localhost:${port}`,
      };

      const result = await handler(mcpContext, args || {});

      res.json({
        content: result.content,
      });
    } catch (error) {
      res.status(500).json({
        error: (error as Error).message,
        content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
      });
    }
  });
}
