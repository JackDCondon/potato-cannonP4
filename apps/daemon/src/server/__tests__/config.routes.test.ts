import { describe, it } from "node:test";
import assert from "node:assert";
import type { Express, Request, Response } from "express";
import { registerConfigRoutes } from "../routes/config.routes.js";
import type { GlobalConfig } from "../../types/config.types.js";

type Handler = (req: Request, res: Response) => void | Promise<void>;

function createRouteHarness(config: GlobalConfig) {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => routes.set(`GET ${path}`, handler),
    put: (path: string, handler: Handler) => routes.set(`PUT ${path}`, handler),
  } as unknown as Express;

  let savedConfig: GlobalConfig | null = null;
  registerConfigRoutes(
    app,
    () => config,
    async (next) => {
      savedConfig = next;
    },
  );

  const invoke = async (method: "GET" | "PUT", path: string, body: unknown = {}) => {
    const handler = routes.get(`${method} ${path}`);
    assert.ok(handler, `missing route handler for ${method} ${path}`);

    let statusCode = 200;
    let payload: unknown = null;
    const req = { body } as Request;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: unknown) {
        payload = data;
        return this;
      },
    } as unknown as Response;

    await handler!(req, res);

    return { statusCode, payload };
  };

  return {
    invoke,
    getSavedConfig: () => savedConfig,
  };
}

const baseConfig: GlobalConfig = {
  daemon: { port: 8443, perforce: { mcpServerPath: "" } },
  ai: {
    defaultProvider: "anthropic",
    providers: [
      { id: "anthropic", models: { low: "haiku", mid: "sonnet", high: "opus" } },
    ],
  },
};

describe("config.routes", () => {
  it("GET /api/config/global returns ai and perforce config", async () => {
    const harness = createRouteHarness(structuredClone(baseConfig));

    const result = await harness.invoke("GET", "/api/config/global");
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(result.payload, {
      perforce: { mcpServerPath: "" },
      ai: {
        defaultProvider: "anthropic",
        providers: [
          { id: "anthropic", models: { low: "haiku", mid: "sonnet", high: "opus" } },
        ],
      },
    });
  });

  it("PUT /api/config/global/ai validates payload and saves config", async () => {
    const harness = createRouteHarness(structuredClone(baseConfig));

    const payload = {
      defaultProvider: "openai",
      providers: [
        { id: "anthropic", models: { low: "haiku", mid: "sonnet", high: "opus" } },
        { id: "openai", models: { low: "gpt-4o-mini", mid: "gpt-4.1", high: "o3" } },
      ],
    };

    const result = await harness.invoke("PUT", "/api/config/global/ai", payload);
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual((result.payload as any).ai, payload);
    assert.deepStrictEqual(harness.getSavedConfig()?.ai, payload);
  });

  it("PUT /api/config/global/ai rejects duplicate provider ids", async () => {
    const harness = createRouteHarness(structuredClone(baseConfig));

    const result = await harness.invoke("PUT", "/api/config/global/ai", {
      defaultProvider: "anthropic",
      providers: [
        { id: "anthropic", models: { low: "haiku", mid: "sonnet", high: "opus" } },
        { id: "anthropic", models: { low: "x", mid: "y", high: "z" } },
      ],
    });

    assert.strictEqual(result.statusCode, 400);
    assert.match((result.payload as { error: string }).error, /unique/);
  });
});
