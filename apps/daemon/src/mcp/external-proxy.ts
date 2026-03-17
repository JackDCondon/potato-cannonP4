#!/usr/bin/env node

/**
 * External MCP Proxy - Headless stdio↔HTTP bridge to daemon
 *
 * Unlike proxy.ts which requires POTATO_TICKET_ID or POTATO_BRAINSTORM_ID,
 * this proxy only requires POTATO_PROJECT_ID (or POTATO_PROJECT_SLUG).
 * It exposes non-session tools for use by external Claude Code instances.
 *
 * Tools that require a session context (chat_ask, chat_notify, etc.) are
 * filtered out. Read/write tools accept ticketId as an explicit argument.
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

// Context from environment
const PROJECT_ID_ENV = process.env.POTATO_PROJECT_ID || '';
const PROJECT_SLUG_ENV = process.env.POTATO_PROJECT_SLUG || '';
const DAEMON_URL_ENV = process.env.POTATO_DAEMON_URL || '';

async function getDaemonUrl(): Promise<string> {
  if (DAEMON_URL_ENV) {
    return DAEMON_URL_ENV;
  }
  const daemonFile = path.join(os.homedir(), '.potato-cannon', 'daemon.json');
  try {
    const data = JSON.parse(await fs.readFile(daemonFile, 'utf-8'));
    return `http://localhost:${data.port}`;
  } catch {
    return 'http://localhost:8443';
  }
}

async function resolveProjectId(daemonUrl: string): Promise<string> {
  if (PROJECT_ID_ENV) {
    return PROJECT_ID_ENV;
  }
  if (!PROJECT_SLUG_ENV) {
    return '';
  }

  // Resolve slug to project ID via daemon API
  try {
    const response = await fetch(`${daemonUrl}/api/projects`);
    if (!response.ok) {
      console.error(`[External MCP] Failed to fetch projects: ${response.statusText}`);
      return '';
    }
    const projects = (await response.json()) as Array<{ id: string; slug: string }>;
    const match = projects.find(
      (p) => p.slug === PROJECT_SLUG_ENV,
    );
    if (!match) {
      console.error(`[External MCP] No project found with slug: ${PROJECT_SLUG_ENV}`);
      return '';
    }
    return match.id;
  } catch (error) {
    console.error(`[External MCP] Failed to resolve project slug: ${(error as Error).message}`);
    return '';
  }
}

async function fetchTools(daemonUrl: string): Promise<unknown[]> {
  try {
    // Request only external-scoped tools (session-only tools are filtered out)
    const response = await fetch(`${daemonUrl}/mcp/tools?scope=external`);
    const data = await response.json();
    return data.tools || [];
  } catch (error) {
    console.error('[External MCP] Failed to fetch tools:', (error as Error).message);
    return [];
  }
}

async function callTool(
  daemonUrl: string,
  projectId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; error?: string }> {
  const response = await fetch(`${daemonUrl}/mcp/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool,
      args,
      context: {
        projectId,
        // No ticketId/brainstormId/workflowId — external mode.
        // Tools that need a ticketId will read it from args.ticketId.
      },
    }),
  });

  return response.json();
}

// Create MCP server
const server = new Server(
  { name: 'potato-cannon-external', version: '4.0.0' },
  { capabilities: { tools: {} } },
);

let daemonUrl: string;
let projectId: string;
let cachedTools: unknown[] = [];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (cachedTools.length === 0) {
    cachedTools = await fetchTools(daemonUrl);
  }
  return { tools: cachedTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;

  try {
    const result = await callTool(daemonUrl, projectId, name, args || {});

    if (result.error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: result.content.map((c) => ({ type: 'text' as const, text: c.text })),
      isError: result.isError,
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
      isError: true,
    };
  }
});

async function main() {
  daemonUrl = await getDaemonUrl();
  projectId = await resolveProjectId(daemonUrl);

  if (!projectId) {
    console.error(
      'Error: POTATO_PROJECT_ID or POTATO_PROJECT_SLUG environment variable is required',
    );
    process.exit(1);
  }

  // Pre-fetch tools to validate daemon connection
  cachedTools = await fetchTools(daemonUrl);
  if (cachedTools.length === 0) {
    console.error('[External MCP] Warning: No tools fetched from daemon - is it running?');
    // Don't exit — daemon may come up later and tools will be fetched on first ListTools call
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('External MCP proxy error:', error);
  process.exit(1);
});
