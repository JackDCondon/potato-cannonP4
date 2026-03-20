import { describe, it, mock } from "node:test";
import assert from "node:assert";

// Track which agent files are requested
const agentFiles: Record<string, string> = {
  "agents/shared-core.md": "# Shared Core\nCore content.",
  "agents/shared-scope.md": "# Shared Scope\nScope content with get_sibling_tickets.",
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

const { loadSharedPreamble } = await import("../agent-loader.js");

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
