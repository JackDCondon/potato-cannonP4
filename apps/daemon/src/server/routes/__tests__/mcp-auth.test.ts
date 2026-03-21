import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";

const mockHandler = mock.fn(async () => ({
  content: [{ type: "text", text: "ok" }],
}));

const mockListProjectsHandler = mock.fn(async () => ({
  content: [{ type: "text", text: "projects list" }],
}));

mock.module("../../../mcp/tools/index.js", {
  namedExports: {
    allTools: [{ name: "get_ticket" }, { name: "list_projects" }],
    allHandlers: {
      get_ticket: mockHandler,
      list_projects: mockListProjectsHandler,
    },
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
    filterToolsByDisallowList: <T>(tools: T[]) => tools,
    findAgentWorkerInWorkflow: mock.fn(async () => null),
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

describe("MCP route auth", () => {
  const originalToken = process.env.POTATO_MCP_AUTH_TOKEN;
  const originalTokenFile = process.env.POTATO_MCP_AUTH_TOKEN_FILE;

  beforeEach(() => {
    mockHandler.mock.resetCalls();
    delete process.env.POTATO_MCP_AUTH_TOKEN;
    process.env.POTATO_MCP_AUTH_TOKEN_FILE = "__missing_mcp_auth_token_file__";
  });

  afterEach(() => {
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

  it("allows requests without auth when no token is configured", async () => {
    const { app, routes } = createAppStub();
    registerMcpRoutes(app);

    const handler = routes.get("GET /mcp/tools");
    assert.ok(handler, "expected GET /mcp/tools to be registered");

    const res = createResponse();
    await handler!({ query: {}, headers: {} }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { tools: [{ name: "get_ticket" }, { name: "list_projects" }] });
  });

  it("rejects unauthenticated tool listing when auth token is configured", async () => {
    process.env.POTATO_MCP_AUTH_TOKEN = "test-secret";

    const { app, routes } = createAppStub();
    registerMcpRoutes(app);

    const handler = routes.get("GET /mcp/tools");
    assert.ok(handler, "expected GET /mcp/tools to be registered");

    const res = createResponse();
    await handler!({ query: {}, headers: {} }, res);

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.payload, { error: "Unauthorized" });
  });

  it("rejects unauthenticated tool calls when auth token is configured", async () => {
    process.env.POTATO_MCP_AUTH_TOKEN = "test-secret";

    const { app, routes } = createAppStub();
    registerMcpRoutes(app);

    const handler = routes.get("POST /mcp/call");
    assert.ok(handler, "expected POST /mcp/call to be registered");

    const res = createResponse();
    await handler!(
      {
        headers: {},
        body: {
          tool: "get_ticket",
          args: {},
          context: { projectId: "proj-1" },
        },
      },
      res,
    );

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.payload, { error: "Unauthorized" });
    assert.equal(mockHandler.mock.calls.length, 0);
  });

  it("allows authenticated tool calls when bearer token matches", async () => {
    process.env.POTATO_MCP_AUTH_TOKEN = "test-secret";

    const { app, routes } = createAppStub();
    registerMcpRoutes(app);

    const handler = routes.get("POST /mcp/call");
    assert.ok(handler, "expected POST /mcp/call to be registered");

    const res = createResponse();
    await handler!(
      {
        headers: { authorization: "Bearer test-secret" },
        socket: { localPort: 3131 },
        body: {
          tool: "get_ticket",
          args: {},
          context: { projectId: "proj-1" },
        },
      },
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
      content: [{ type: "text", text: "ok" }],
    });
    assert.equal(mockHandler.mock.calls.length, 1);
  });

  it("allows list_projects with no projectId", async () => {
    const { app, routes } = createAppStub();
    registerMcpRoutes(app);

    const handler = routes.get("POST /mcp/call");
    assert.ok(handler, "expected POST /mcp/call to be registered");

    const res = createResponse();
    await handler!(
      {
        headers: {},
        socket: { localPort: 3131 },
        body: {
          tool: "list_projects",
          args: {},
          context: { projectId: "" },
        },
      },
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
      content: [{ type: "text", text: "projects list" }],
    });
    assert.equal(mockListProjectsHandler.mock.calls.length, 1);
  });
});
