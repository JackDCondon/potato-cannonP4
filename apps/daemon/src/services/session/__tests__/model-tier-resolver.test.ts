import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveConcreteModelForWorker,
  resolveEffectiveProvider,
  resolveModelTier,
} from "../model-tier-resolver.js";
import type { GlobalConfig } from "../../../types/config.types.js";

const baseConfig: GlobalConfig = {
  daemon: { port: 8443 },
  ai: {
    defaultProvider: "anthropic",
    providers: [
      {
        id: "anthropic",
        models: { low: "haiku", mid: "sonnet", high: "opus" },
      },
      {
        id: "openai",
        models: { low: "gpt-4o-mini", mid: "gpt-4.1", high: "o3" },
      },
    ],
  },
};

describe("resolveModelTier", () => {
  it("selects a direct tier string unchanged", () => {
    assert.strictEqual(resolveModelTier("high", "simple"), "high");
  });

  it("resolves complexity map values", () => {
    const modelTier = { simple: "low", standard: "mid", complex: "high" } as const;
    assert.strictEqual(resolveModelTier(modelTier, "simple"), "low");
    assert.strictEqual(resolveModelTier(modelTier, "standard"), "mid");
    assert.strictEqual(resolveModelTier(modelTier, "complex"), "high");
  });

  it("rejects legacy and invalid values", () => {
    assert.throws(() => resolveModelTier("opus" as any, "standard"), /legacy model value/);
    assert.throws(() => resolveModelTier("ultra" as any, "standard"), /Invalid model tier/);
  });
});

describe("resolveEffectiveProvider", () => {
  it("prefers project provider override over global default", () => {
    const provider = resolveEffectiveProvider(
      { providerOverride: "openai" },
      baseConfig,
    );
    assert.strictEqual(provider.id, "openai");
  });

  it("falls back to global default provider", () => {
    const provider = resolveEffectiveProvider({}, baseConfig);
    assert.strictEqual(provider.id, "anthropic");
  });

  it("throws when provider is missing", () => {
    assert.throws(
      () => resolveEffectiveProvider({ providerOverride: "missing" }, baseConfig),
      /not configured/,
    );
  });
});

describe("resolveConcreteModelForWorker", () => {
  it("resolves provider plus tier to concrete model", () => {
    assert.deepStrictEqual(
      resolveConcreteModelForWorker({
        modelTier: { simple: "low", standard: "mid", complex: "high" },
        complexity: "complex",
        project: { providerOverride: "anthropic" },
        config: baseConfig,
      }),
      {
        providerId: "anthropic",
        tier: "high",
        model: "opus",
      },
    );
  });

  it("throws when provider tier mapping is missing", () => {
    const config: GlobalConfig = {
      daemon: { port: 8443 },
      ai: {
        defaultProvider: "broken",
        providers: [
          {
            id: "broken",
            models: { low: "cheap", mid: "ok", high: "" },
          },
        ],
      },
    };

    assert.throws(
      () =>
        resolveConcreteModelForWorker({
          modelTier: "high",
          complexity: "standard",
          project: {},
          config,
        }),
      /missing model mapping for tier "high"/,
    );
  });
});
