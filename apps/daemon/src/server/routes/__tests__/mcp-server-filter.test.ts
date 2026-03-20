import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";

const mockTools = [
  { name: "session_only", scope: "session" },
  { name: "get_ticket" },
  { name: "blocked_ticket" },
  { name: "get_epic_status", mcpServer: "pm" },
];

const mockFindAgentWorkerInWorkflow = mock.fn(async () => ({
  disallowTools: ["blocked_ticket"],
}));

const mockFilterToolsByDisallowList = mock.fn(
  <T extends { name: string }>(tools: T[], disallowList: string[]) =>
    tools.filter((tool) => !disallowList.includes(tool.name)),
);

mock.module("../../../mcp/tools/index.js", {
  namedExports: {
    allTools: mockTools,
    allHandlers: {},
  },
});

mock.module("../../../stores/ticket-log.store.js", {
  namedExports: {
    appendTicketLog: mock.fn(async () => undefined),
  },
});

mock.module("../mcp-tools-filter.js", {
  namedExports: {
    AGENT_SOURCE_PATTERN: /^agents\/[\w\-]+\.md$/,
    filterToolsByDisallowList: mockFilterToolsByDisallowList,
    findAgentWorkerInWorkflow: mockFindAgentWorkerInWorkflow,
  },
});

const { registerMcpRoutes } = await import("../mcp.routes.js");

function createAppStub() {
  const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>();
  const app = {
    get(path: string, handler: (req: unknown, res: unknown) => Promise<void> | void) {
      routes.set(`GET ${path}`, handler);
    },
    post(path: string, handler: (req: unknown, res: unknown) => Promise<void> | void) {
      routes.set(`POST ${path}`, handler);
    },
  } as unknown as Express & { routes: typeof routes };

  return { app, routes };
}

function createResponse() {
  return {
    payload: undefined as unknown,
    statusCode: 200,
    json(body: unknown) {
      this.payload = body;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

describe("GET /mcp/tools mcpServer filter", () => {
  const originalToken = process.env.POTATO_MCP_AUTH_TOKEN;
  const originalTokenFile = process.env.POTATO_MCP_AUTH_TOKEN_FILE;

  beforeEach(() => {
    mockFindAgentWorkerInWorkflow.mock.resetCalls();
    mockFilterToolsByDisallowList.mock.resetCalls();
    delete process.env.POTATO_MCP_AUTH_TOKEN;
    process.env.POTATO_MCP_AUTH_TOKEN_FILE = "__missing_mcp_auth_token_file__";
  });

  after(() => {
    if (originalToken === undefined) {
      delete process.env.POTATO_MCP_AUTH_TOKEN;
    } else {
      process.env.POTATO_MCP_AUTH_TOKEN = originalToken;
    }

    if (originalTokenFile === undefined) {
      delete process.env.POTATO_MCP_AUTH_TOKEN_FILE;
    } else {
      process.env.POTATO_MCP_AUTH_TOKEN_FILE = originalTokenFile;
    }
  });

  it("filters PM tools after applying scope and disallowTools", async () => {
    const { app, routes } = createAppStub();
    registerMcpRoutes(app);

    const handler = routes.get("GET /mcp/tools");
    assert.ok(handler, "expected GET /mcp/tools to be registered");

    const res = createResponse();
    await handler!(
      {
        query: {
          scope: "external",
          mcpServer: "ticket",
          agentSource: "agents/builder.md",
          projectId: "proj-1",
        },
        headers: {},
      },
      res,
    );

    assert.deepStrictEqual(
      (res.payload as { tools: { name: string }[] }).tools.map((tool) => tool.name),
      ["get_ticket"],
    );
    assert.strictEqual(mockFindAgentWorkerInWorkflow.mock.calls.length, 1);
    assert.strictEqual(mockFilterToolsByDisallowList.mock.calls.length, 1);
  });

  it("returns only PM tools when mcpServer=pm", async () => {
    const { app, routes } = createAppStub();
    registerMcpRoutes(app);

    const handler = routes.get("GET /mcp/tools");
    assert.ok(handler, "expected GET /mcp/tools to be registered");

    const res = createResponse();
    await handler!(
      {
        query: {
          scope: "external",
          mcpServer: "pm",
          agentSource: "agents/builder.md",
          projectId: "proj-1",
        },
        headers: {},
      },
      res,
    );

    assert.deepStrictEqual(
      (res.payload as { tools: { name: string }[] }).tools.map((tool) => tool.name),
      ["get_epic_status"],
    );
    assert.strictEqual(mockFindAgentWorkerInWorkflow.mock.calls.length, 1);
    assert.strictEqual(mockFilterToolsByDisallowList.mock.calls.length, 1);
  });
});
