import { ticketTools, ticketHandlers } from "./ticket.tools.js";
import { chatTools, chatHandlers } from "./chat.tools.js";
import { taskTools, taskHandlers } from "./task.tools.js";
import { ralphTools, ralphHandlers } from "./ralph.tools.js";
import { artifactTools, artifactHandlers } from "./artifact.tools.js";
import { dependencyTools, dependencyHandlers } from "./dependency.tools.js";
import { scopeTools, scopeHandlers } from "./scope.tools.js";
import { epicTools, epicHandlers } from "./epic.tools.js";
import { pmTools, pmHandlers } from "./pm.tools.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";

export const allTools: ToolDefinition[] = [...ticketTools, ...chatTools, ...taskTools, ...ralphTools, ...artifactTools, ...dependencyTools, ...scopeTools, ...epicTools, ...pmTools];

export const allHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  ...ticketHandlers,
  ...chatHandlers,
  ...taskHandlers,
  ...ralphHandlers,
  ...artifactHandlers,
  ...dependencyHandlers,
  ...scopeHandlers,
  ...epicHandlers,
  ...pmHandlers,
};

export { ticketTools, chatTools, taskTools, ralphTools, artifactTools, dependencyTools, scopeTools, epicTools, pmTools };
export { ticketHandlers, chatHandlers, taskHandlers, ralphHandlers, artifactHandlers, dependencyHandlers, scopeHandlers, epicHandlers, pmHandlers };
