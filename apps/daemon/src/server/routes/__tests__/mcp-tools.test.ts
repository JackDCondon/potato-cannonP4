import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { AgentWorker } from "../../../types/template.types.js";

// ============================================================================
// Module mocks for findAgentWorkerInWorkflow tests
// ============================================================================

// Mutable state shared with mock implementations
const mockState = {
  defaultWorkflow: null as { id: string; templateName: string } | null,
  workflowTemplate: null as unknown,
  projectTemplate: null as unknown,
  globalTemplate: null as unknown,
};

mock.module("../../../stores/project-workflow.store.js", {
  namedExports: {
    projectWorkflowGetDefault: (_projectId: string) => mockState.defaultWorkflow,
  },
});

mock.module("../../../stores/project-template.store.js", {
  namedExports: {
    getWorkflowTemplate: async (_projectId: string, _workflowId: string) =>
      mockState.workflowTemplate,
    getProjectTemplate: async (_projectId: string) => mockState.projectTemplate,
  },
});

mock.module("../../../stores/template.store.js", {
  namedExports: {
    getWorkflow: async (_name: string) => mockState.globalTemplate,
  },
});

const { filterToolsByDisallowList, AGENT_SOURCE_PATTERN, findAgentWorkerInWorkflow } =
  await import("../mcp-tools-filter.js");

describe("filterToolsByDisallowList", () => {
  test("removes tools matching disallowTools list", () => {
    const tools = [
      { name: "create_task" },
      { name: "ralph_loop_dock" },
      { name: "chat_notify" },
      { name: "attach_artifact" },
    ];
    const disallowList = ["create_task", "attach_artifact"];
    const result = filterToolsByDisallowList(tools, disallowList);
    assert.deepEqual(
      result.map((t) => t.name),
      ["ralph_loop_dock", "chat_notify"],
    );
  });

  test("returns all tools when disallowList is empty", () => {
    const tools = [{ name: "create_task" }, { name: "ralph_loop_dock" }];
    const result = filterToolsByDisallowList(tools, []);
    assert.equal(result.length, 2);
  });

  test("returns empty array when all tools are disallowed", () => {
    const tools = [{ name: "create_task" }, { name: "ralph_loop_dock" }];
    const result = filterToolsByDisallowList(tools, ["create_task", "ralph_loop_dock"]);
    assert.equal(result.length, 0);
  });

  test("handles tools not in disallowList", () => {
    const tools = [{ name: "chat_ask" }, { name: "get_ticket" }];
    const result = filterToolsByDisallowList(tools, ["ralph_loop_dock"]);
    assert.equal(result.length, 2);
  });

  test("is case-sensitive when matching tool names", () => {
    const tools = [{ name: "create_task" }];
    // Disallow list uses different case - should NOT match
    const result = filterToolsByDisallowList(tools, ["Create_Task"]);
    assert.equal(result.length, 1);
  });
});

describe("AGENT_SOURCE_PATTERN", () => {
  test("accepts valid agent paths", () => {
    assert.ok(AGENT_SOURCE_PATTERN.test("agents/builder.md"));
    assert.ok(AGENT_SOURCE_PATTERN.test("agents/refinement.md"));
    assert.ok(AGENT_SOURCE_PATTERN.test("agents/verify-spec-agent.md"));
    assert.ok(AGENT_SOURCE_PATTERN.test("agents/my-agent_v2.md"));
  });

  test("rejects paths with directory traversal", () => {
    assert.ok(!AGENT_SOURCE_PATTERN.test("agents/../secrets.md"));
    assert.ok(!AGENT_SOURCE_PATTERN.test("../agents/builder.md"));
    assert.ok(!AGENT_SOURCE_PATTERN.test("agents/../../etc/passwd"));
  });

  test("rejects paths without agents/ prefix", () => {
    assert.ok(!AGENT_SOURCE_PATTERN.test("builder.md"));
    assert.ok(!AGENT_SOURCE_PATTERN.test("other/builder.md"));
  });

  test("rejects paths with special characters", () => {
    assert.ok(!AGENT_SOURCE_PATTERN.test("agents/builder$.md"));
    assert.ok(!AGENT_SOURCE_PATTERN.test("agents/build er.md"));
  });
});

// ============================================================================
// findAgentWorkerInWorkflow
// ============================================================================

const MOCK_AGENT_SOURCE = "agents/builder.md";
const MOCK_PROJECT_ID = "proj_test";

/** Build a minimal WorkflowTemplate containing one agent at the given source. */
function makeTemplate(agentSource: string, disallowTools: string[] = []) {
  return {
    name: "test",
    version: "1.0.0",
    phases: [
      {
        id: "Build",
        name: "Build",
        description: "",
        workers: [
          {
            id: "worker_test",
            type: "agent" as const,
            source: agentSource,
            disallowTools,
          } satisfies AgentWorker,
        ],
        transitions: { next: null },
      },
    ],
  };
}

describe("findAgentWorkerInWorkflow", () => {
  test("returns null when no default workflow found", async () => {
    mockState.defaultWorkflow = null;
    mockState.workflowTemplate = null;
    mockState.projectTemplate = null;
    mockState.globalTemplate = null;

    const result = await findAgentWorkerInWorkflow(MOCK_PROJECT_ID, MOCK_AGENT_SOURCE);
    assert.equal(result, null);
  });

  test("returns agent from workflow-local template (tier 1 hit)", async () => {
    mockState.defaultWorkflow = { id: "wf_1", templateName: "product-development" };
    mockState.workflowTemplate = makeTemplate(MOCK_AGENT_SOURCE, ["create_task"]);
    mockState.projectTemplate = null;
    mockState.globalTemplate = null;

    const result = await findAgentWorkerInWorkflow(MOCK_PROJECT_ID, MOCK_AGENT_SOURCE);
    assert.ok(result !== null);
    assert.equal(result.source, MOCK_AGENT_SOURCE);
    assert.deepEqual(result.disallowTools, ["create_task"]);
  });

  test("falls back to project-local template when workflow-local is absent (tier 2 hit)", async () => {
    mockState.defaultWorkflow = { id: "wf_1", templateName: "product-development" };
    mockState.workflowTemplate = null; // no workflow-local copy
    mockState.projectTemplate = makeTemplate(MOCK_AGENT_SOURCE, ["ralph_loop_dock"]);
    mockState.globalTemplate = null;

    const result = await findAgentWorkerInWorkflow(MOCK_PROJECT_ID, MOCK_AGENT_SOURCE);
    assert.ok(result !== null);
    assert.equal(result.source, MOCK_AGENT_SOURCE);
    assert.deepEqual(result.disallowTools, ["ralph_loop_dock"]);
  });

  test("falls back to global catalog when both local tiers are absent (tier 3 hit)", async () => {
    mockState.defaultWorkflow = { id: "wf_1", templateName: "product-development" };
    mockState.workflowTemplate = null;
    mockState.projectTemplate = null;
    mockState.globalTemplate = makeTemplate(MOCK_AGENT_SOURCE, ["attach_artifact"]);

    const result = await findAgentWorkerInWorkflow(MOCK_PROJECT_ID, MOCK_AGENT_SOURCE);
    assert.ok(result !== null);
    assert.equal(result.source, MOCK_AGENT_SOURCE);
    assert.deepEqual(result.disallowTools, ["attach_artifact"]);
  });

  test("returns null when agent not found in any tier", async () => {
    mockState.defaultWorkflow = { id: "wf_1", templateName: "product-development" };
    mockState.workflowTemplate = null;
    mockState.projectTemplate = null;
    mockState.globalTemplate = makeTemplate("agents/other.md");

    const result = await findAgentWorkerInWorkflow(MOCK_PROJECT_ID, MOCK_AGENT_SOURCE);
    assert.equal(result, null);
  });

  test("continues to tier 3 when tier 2 template exists but does not contain the agent", async () => {
    // Tier 2 (project-local) returns a non-null template that was created before
    // the agent was added — it only contains a different agent.
    // Tier 3 (global catalog) has the up-to-date template with the target agent.
    mockState.defaultWorkflow = { id: "wf_1", templateName: "product-development" };
    mockState.workflowTemplate = null; // tier 1 absent
    mockState.projectTemplate = makeTemplate("agents/other.md"); // tier 2: non-null but wrong agent
    mockState.globalTemplate = makeTemplate(MOCK_AGENT_SOURCE, ["attach_artifact"]); // tier 3: has it

    const result = await findAgentWorkerInWorkflow(MOCK_PROJECT_ID, MOCK_AGENT_SOURCE);
    assert.ok(result !== null, "expected agent to be found in tier 3");
    assert.equal(result.source, MOCK_AGENT_SOURCE);
    assert.deepEqual(result.disallowTools, ["attach_artifact"]);
  });
});
