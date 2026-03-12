import { describe, it, mock } from "node:test";
import assert from "node:assert";

interface PhaseEntry {
  id: string;
  name: string;
  workers: unknown[];
  transitions: { next: string | null };
  requiresIsolation?: boolean;
}

const defaultPhases: PhaseEntry[] = [
  { id: "Ideas", name: "Ideas", workers: [], transitions: { next: "Refinement" } },
  {
    id: "Refinement",
    name: "Refinement",
    workers: [{ type: "agent", source: "agents/refinement.md" }],
    transitions: { next: "Done" },
  },
  { id: "Done", name: "Done", workers: [], transitions: { next: null } },
];

const nonDefaultPhases: PhaseEntry[] = [
  { id: "Ideas", name: "Ideas", workers: [], transitions: { next: "Build" } },
  {
    id: "Build",
    name: "Build",
    workers: [{ type: "agent", source: "agents/build.md" }],
    transitions: { next: "Done" },
    requiresIsolation: true,
  },
  { id: "Done", name: "Done", workers: [], transitions: { next: null } },
];

const globalTemplateState: Record<string, { phases: PhaseEntry[] } | null> = {
  "product-development": { phases: defaultPhases },
  "custom-workflow": { phases: nonDefaultPhases },
};

const workflowState: Record<string, { id: string; projectId: string; templateName: string } | null> = {
  "wf-default": { id: "wf-default", projectId: "proj-1", templateName: "product-development" },
  "wf-custom": { id: "wf-custom", projectId: "proj-1", templateName: "custom-workflow" },
};

const projectState: {
  id: string;
  template: { name: string } | null;
  disabledPhases: string[];
} = {
  id: "proj-1",
  template: { name: "product-development" },
  disabledPhases: [],
};

await mock.module("../../../stores/project.store.js", {
  namedExports: {
    getProjectById: (_id: string) => ({
      id: projectState.id,
      template: projectState.template,
      disabledPhases: projectState.disabledPhases,
    }),
  },
});

await mock.module("../../../stores/template.store.js", {
  namedExports: {
    getWorkflowWithFullPhases: async (name: string) => {
      const tpl = globalTemplateState[name];
      if (!tpl) return null;
      return { name, version: "1.0.0", phases: tpl.phases };
    },
    WorkflowContextError: class WorkflowContextError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    },
  },
});

await mock.module("../../../stores/project-workflow.store.js", {
  namedExports: {
    projectWorkflowGet: (id: string) => workflowState[id] ?? null,
  },
});

const {
  getPhaseConfig,
  resolveTargetPhase,
  phaseRequiresIsolation,
  getNextEnabledPhase,
} = await import("../phase-config.js");

function resetState() {
  projectState.id = "proj-1";
  projectState.template = { name: "product-development" };
  projectState.disabledPhases = [];
}

describe("phase-config strict workflow context", () => {
  it("requires workflowId for getPhaseConfig", async () => {
    resetState();
    await assert.rejects(
      () => getPhaseConfig("proj-1", "Refinement"),
      /workflowId is required/,
    );
  });

  it("errors when workflowId is unknown", async () => {
    resetState();
    await assert.rejects(
      () => getPhaseConfig("proj-1", "Refinement", "wf-unknown"),
      /was not found/,
    );
  });

  it("resolves phase from the selected workflow template", async () => {
    resetState();
    const phase = await getPhaseConfig("proj-1", "Build", "wf-custom");
    assert.ok(phase);
    assert.strictEqual(phase.name, "Build");
  });

  it("requires workflowId for resolveTargetPhase", async () => {
    resetState();
    await assert.rejects(
      () => resolveTargetPhase("proj-1", "Ideas"),
      /workflowId is required/,
    );
  });

  it("requires workflowId for phaseRequiresIsolation", async () => {
    resetState();
    await assert.rejects(
      () => phaseRequiresIsolation("proj-1", "Refinement"),
      /workflowId is required/,
    );
  });

  it("requires workflowId for getNextEnabledPhase", async () => {
    resetState();
    await assert.rejects(
      () => getNextEnabledPhase("proj-1", "Ideas"),
      /workflowId is required/,
    );
  });
});
