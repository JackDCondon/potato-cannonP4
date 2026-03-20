import { describe, it, mock } from "node:test";
import assert from "node:assert";

// Track which agent files are requested
const agentFiles: Record<string, string> = {
  "agents/shared-core.md": "# Shared Core\nCore content.",
  "agents/shared-scope.md": "# Shared Scope\nScope content with get_sibling_tickets.",
  "agents/builder.md": "# Builder\nImplements tasks.",
  "agents/verify-spec.md": "# Verify Spec\nVerifies specification.",
};

await mock.module("../../../stores/project.store.js", {
  namedExports: {
    getProjectById: (_id: string) => ({
      id: "proj-1",
      template: { name: "product-development" },
    }),
  },
});

await mock.module("../../../stores/template.store.js", {
  namedExports: {
    getAgentPromptForProject: async (_projectId: string, agentPath: string) => {
      const content = agentFiles[agentPath];
      if (content === undefined) {
        throw new Error(`Agent not found: ${agentPath}`);
      }
      return content;
    },
  },
});

const { loadSharedPreamble, loadAgentDefinition } = await import("../agent-loader.js");

describe("loadAgentDefinition SCOPE_USING_AGENTS routing", () => {
  it("builder.md (scope-using agent) gets scope content in prompt", async () => {
    const result = await loadAgentDefinition("proj-1", "agents/builder.md");
    assert.ok(result.prompt.includes("get_sibling_tickets"), "scope-using agent prompt should include scope content");
    assert.ok(result.prompt.includes("Core content."), "scope-using agent prompt should include core content");
  });

  it("verify-spec.md (non-scope agent) does NOT get scope content in prompt", async () => {
    const result = await loadAgentDefinition("proj-1", "agents/verify-spec.md");
    assert.ok(!result.prompt.includes("get_sibling_tickets"), "non-scope agent prompt should NOT include scope content");
    assert.ok(result.prompt.includes("Core content."), "non-scope agent prompt should still include core content");
  });
});

describe("loadSharedPreamble", () => {
  it("without includeScope does not include scope content", async () => {
    const result = await loadSharedPreamble("proj-1", false);
    assert.ok(result, "should return some content");
    assert.ok(!result.includes("get_sibling_tickets"), "should not include scope content");
    assert.ok(result.includes("Core content."), "should include core content");
  });

  it("with includeScope=true includes scope content", async () => {
    const result = await loadSharedPreamble("proj-1", true);
    assert.ok(result, "should return some content");
    assert.ok(result.includes("get_sibling_tickets"), "should include scope content");
    assert.ok(result.includes("Core content."), "should include core content");
  });
});
