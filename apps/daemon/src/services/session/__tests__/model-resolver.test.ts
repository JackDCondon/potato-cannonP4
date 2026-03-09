import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveModel } from "../model-resolver.js";

describe("resolveModel", () => {
  describe("when model is undefined", () => {
    it("should return null", () => {
      const result = resolveModel(undefined);
      assert.strictEqual(result, null);
    });
  });

  describe("when model is a shortcut string", () => {
    it("should return 'haiku' for haiku shortcut", () => {
      const result = resolveModel("haiku");
      assert.strictEqual(result, "haiku");
    });

    it("should return 'sonnet' for sonnet shortcut", () => {
      const result = resolveModel("sonnet");
      assert.strictEqual(result, "sonnet");
    });

    it("should return 'opus' for opus shortcut", () => {
      const result = resolveModel("opus");
      assert.strictEqual(result, "opus");
    });
  });

  describe("when model is an explicit model ID", () => {
    it("should return the model ID unchanged for claude- prefixed strings", () => {
      const result = resolveModel("claude-sonnet-4-20250514");
      assert.strictEqual(result, "claude-sonnet-4-20250514");
    });

    it("should return the model ID for claude-3-5-haiku format", () => {
      const result = resolveModel("claude-3-5-haiku-20241022");
      assert.strictEqual(result, "claude-3-5-haiku-20241022");
    });
  });

  describe("when model is an unrecognized string", () => {
    it("should return null for unrecognized model names", () => {
      const result = resolveModel("gpt-4");
      assert.strictEqual(result, null);
    });

    it("should return null for empty string", () => {
      const result = resolveModel("");
      assert.strictEqual(result, null);
    });
  });

  describe("when model is an object with id", () => {
    it("should return the id for object with id only", () => {
      const result = resolveModel({ id: "claude-sonnet-4-20250514" });
      assert.strictEqual(result, "claude-sonnet-4-20250514");
    });

    it("should return the id for object with anthropic provider", () => {
      const result = resolveModel({ id: "claude-opus-4-20250514", provider: "anthropic" });
      assert.strictEqual(result, "claude-opus-4-20250514");
    });

    it("should return null for unsupported provider", () => {
      const result = resolveModel({ id: "gpt-4", provider: "openai" });
      assert.strictEqual(result, null);
    });
  });

  describe("edge cases", () => {
    it("should return null for object with empty id", () => {
      const result = resolveModel({ id: "" });
      assert.strictEqual(result, null);
    });
  });

  describe("complexity map", () => {
    it("resolves simple complexity from map", () => {
      const result = resolveModel({ simple: "haiku", standard: "sonnet", complex: "opus" }, "simple");
      assert.strictEqual(result, "haiku");
    });
    it("resolves standard complexity from map", () => {
      const result = resolveModel({ simple: "haiku", standard: "sonnet", complex: "opus" }, "standard");
      assert.strictEqual(result, "sonnet");
    });
    it("resolves complex complexity from map", () => {
      const result = resolveModel({ simple: "haiku", standard: "sonnet", complex: "opus" }, "complex");
      assert.strictEqual(result, "opus");
    });
    it("falls back to standard when complexity null", () => {
      const result = resolveModel({ simple: "haiku", standard: "sonnet", complex: "opus" }, null);
      assert.strictEqual(result, "sonnet");
    });
    it("string model spec ignores complexity param", () => {
      const result = resolveModel("haiku", "complex");
      assert.strictEqual(result, "haiku");
    });
  });
});
