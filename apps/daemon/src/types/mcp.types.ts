export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** Scope tag for filtering. 'session' = session-proxy only. Default (undefined) = both. */
  scope?: 'session' | 'external' | 'both';
}

export interface McpContext {
  projectId: string;
  ticketId?: string;        // optional — absent in headless/external mode
  brainstormId?: string;    // optional — absent in headless/external mode
  workflowId?: string;      // optional — absent in headless/external mode
  agentModel?: string;
  daemonUrl: string;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

export interface McpRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ChatInfo {
  chatId: string;
  messageThreadId?: number;
  projectId: string;
  ticketId: string;
  title: string;
  createdAt: string;
}

export interface TopicData {
  topicId: number;
  topicName: string;
  ticketId: string;
  createdAt: string;
}
