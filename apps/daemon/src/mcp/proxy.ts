#!/usr/bin/env node

/**
 * MCP Proxy - Thin stdio↔HTTP bridge to daemon
 *
 * This proxy handles Claude Code's MCP protocol over stdio and forwards
 * tool calls to the daemon's HTTP API. This allows the daemon to handle
 * all tool logic with access to registered providers (Telegram, etc).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'node:url';

// Context from environment (set by session spawner)
const PROJECT_ID = process.env.POTATO_PROJECT_ID || '';
const TICKET_ID = process.env.POTATO_TICKET_ID || '';
const BRAINSTORM_ID = process.env.POTATO_BRAINSTORM_ID || '';
const WORKFLOW_ID = process.env.POTATO_WORKFLOW_ID || '';
const AGENT_MODEL = process.env.POTATO_AGENT_MODEL || '';
const AGENT_SOURCE = process.env.POTATO_AGENT_SOURCE ?? '';
const MCP_SCOPE = process.env.POTATO_MCP_SCOPE === 'pm' ? 'pm' : 'ticket';

export function getMcpServerName(): string {
  return `potato-${MCP_SCOPE}`;
}

export function buildToolsUrl(
  daemonUrl: string,
  agentSource: string,
  projectId: string,
  mcpScope: 'ticket' | 'pm',
): string {
  const url = new URL(`${daemonUrl}/mcp/tools`);
  if (agentSource) url.searchParams.set('agentSource', agentSource);
  if (projectId) url.searchParams.set('projectId', projectId);
  url.searchParams.set('mcpServer', mcpScope);
  return url.toString();
}

export function buildCallToolPayload(
  tool: string,
  args: Record<string, unknown>
): {
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
} {
  return {
    tool,
    args,
    context: {
      projectId: PROJECT_ID,
      ticketId: TICKET_ID || undefined,
      brainstormId: BRAINSTORM_ID || undefined,
      workflowId: WORKFLOW_ID || undefined,
      agentModel: AGENT_MODEL || undefined,
      agentSource: AGENT_SOURCE || undefined,
    },
  };
}

async function getDaemonUrl(): Promise<string> {
  const daemonFile = path.join(os.homedir(), '.potato-cannon', 'daemon.json');
  try {
    const data = JSON.parse(await fs.readFile(daemonFile, 'utf-8'));
    return `http://localhost:${data.port}`;
  } catch {
    return 'http://localhost:8443';
  }
}

async function fetchTools(daemonUrl: string, agentSource?: string, projectId?: string): Promise<unknown[]> {
  try {
    const url = buildToolsUrl(daemonUrl, agentSource ?? '', projectId ?? '', MCP_SCOPE);
    const response = await fetch(url);
    const data = await response.json();
    return data.tools || [];
  } catch (error) {
    console.error('[MCP Proxy] Failed to fetch tools:', (error as Error).message);
    return [];
  }
}

async function callTool(
  daemonUrl: string,
  tool: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; error?: string }> {
  const response = await fetch(`${daemonUrl}/mcp/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildCallToolPayload(tool, args)),
  });

  return response.json();
}

// Create MCP server
const server = new Server(
  { name: getMcpServerName(), version: '4.0.0' },
  { capabilities: { tools: {} } }
);

let daemonUrl: string;
let cachedTools: unknown[] = [];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (cachedTools.length === 0) {
    cachedTools = await fetchTools(daemonUrl, AGENT_SOURCE, PROJECT_ID);
  }
  return { tools: cachedTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;

  try {
    const result = await callTool(daemonUrl, name, args || {});

    if (result.error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: result.content.map((c) => ({ type: 'text' as const, text: c.text })),
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
      isError: true,
    };
  }
});

async function main() {
  if (!PROJECT_ID) {
    console.error('Error: POTATO_PROJECT_ID environment variable is required');
    process.exit(1);
  }
  if (!TICKET_ID && !BRAINSTORM_ID) {
    console.error('Error: Either POTATO_TICKET_ID or POTATO_BRAINSTORM_ID is required');
    process.exit(1);
  }

  daemonUrl = await getDaemonUrl();

  // Pre-fetch tools to validate daemon connection
  cachedTools = await fetchTools(daemonUrl, AGENT_SOURCE, PROJECT_ID);
  if (cachedTools.length === 0) {
    console.error('Warning: No tools fetched from daemon - is it running?');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run main if this module is being executed directly (not imported for testing)
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl && import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error('MCP proxy error:', error);
    process.exit(1);
  });
}
