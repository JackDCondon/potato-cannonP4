/**
 * Tests for phase-config.ts — workflow-based template resolution.
 *
 * All module mocks are registered before importing the SUT.
 * The shared mutable "state" objects let each test control behavior.
 */

import { describe, it, mock, before } from "node:test";
import assert from "node:assert";

// ── Shared mutable state ──────────────────────────────────────────────────────

interface PhaseEntry {
  id: string;
  name: string;
  workers: unknown[];
  transitions: { next: string | null };
  requiresIsolation?: boolean;
}

const defaultPhases: PhaseEntry[] = [
  { id: "Ideas", name: "Ideas", workers: [], transitions: { next: "Refinement" } },
  { id: "Refinement", name: "Refinement", workers: [{ type: "agent", source: "agents/refinement.md" }], transitions: { next: "Done" } },
  { id: "Done", name: "Done", workers: [], transitions: { next: null } },
];

const nonDefaultPhases: PhaseEntry[] = [
  { id: "Ideas", name: "Ideas", workers: [], transitions: { next: "Build" } },
  { id: "Build", name: "Build", workers: [{ type: "agent", source: "agents/build.md" }], transitions: { next: "Done" } },
  { id: "Done", name: "Done", workers: [], transitions: { next: null } },
];

// Controls which template the global catalog returns (by name)
const globalTemplateState: Record<string, { phases: PhaseEntry[] } | null> = {
  "product-development": { phases: defaultPhases },
  "custom-workflow": { phases: nonDefaultPhases },
};

// Controls which workflow the project-workflow store returns (by id)
const workflowState: Record<string, { id: string; projectId: string; templateName: string; isDefault: boolean } | null> = {
  "wf-default": { id: "wf-default", projectId: "proj-1", templateName: "product-development", isDefault: true },
  "wf-custom": { id: "wf-custom", projectId: "proj-1", templateName: "custom-workflow", isDefault: false },
};

// Controls what getProjectById returns
const projectState: {
  id: string;
  template: { name: string } | null;
  disabledPhases: string[];
} = {
  id: "proj-1",
  template: { name: "product-development" },
  disabledPhases: [],
};

// Controls whether project has a local template copy
const projectHasTemplate = { value: true };

// ── Register mocks BEFORE importing SUT ──────────────────────────────────────

await mock.module("../../../stores/project.store.js", {
  namedExports: {
    getProjectById: (_id: string) => ({
      id: projectState.id,
      template: projectState.template,
      disabledPhases: projectState.disabledPhases,
    }),
    updateProjectTemplate: async () => {},
  },
});

await mock.module("../../../stores/template.store.js", {
  namedExports: {
    getTemplateWithFullPhasesForProject: async (_projectId: string) => {
      const tplName = projectState.template?.name;
      if (!tplName) return null;
      const tpl = globalTemplateState[tplName];
      if (!tpl) return null;
      return { name: tplName, version: "1.0.0", phases: tpl.phases };
    },
    getWorkflowWithFullPhases: async (name: string) => {
      const tpl = globalTemplateState[name];
      if (!tpl) return null;
      return { name, version: "1.0.0", phases: tpl.phases };
    },
  },
});

await mock.module("../../../stores/project-template.store.js", {
  namedExports: {
    hasProjectTemplate: async (_projectId: string) => projectHasTemplate.value,
    copyTemplateToProject: async (_projectId: string, templateName: string) => ({
      name: templateName,
      version: "1.0.0",
      phases: defaultPhases,
    }),
  },
});

await mock.module("../../../stores/project-workflow.store.js", {
  namedExports: {
    projectWorkflowGet: (id: string) => workflowState[id] ?? null,
  },
});

// ── Import SUT after mocks ────────────────────────────────────────────────────

const {
  getPhaseConfig,
  isPhaseDisabled,
  resolveTargetPhase,
} = await import("../phase-config.js");

// ── Helper to reset state to defaults ────────────────────────────────────────

function resetState() {
  projectState.id = "proj-1";
  projectState.template = { name: "product-development" };
  projectState.disabledPhases = [];
  projectHasTemplate.value = true;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getPhaseConfig", () => {
  describe("without workflowId (default project-template path)", () => {
    it("returns phase from project template when no workflowId provided", async () => {
      resetState();
      const phase = await getPhaseConfig("proj-1", "Refinement");
      assert.ok(phase, "expected a phase object");
      assert.strictEqual(phase!.name, "Refinement");
    });

    it("returns null when phase does not exist in project template", async () => {
      resetState();
      const phase = await getPhaseConfig("proj-1", "NonExistentPhase");
      assert.strictEqual(phase, null);
    });

    it("throws when project has no template assigned", async () => {
      resetState();
      projectState.template = null;
      await assert.rejects(
        () => getPhaseConfig("proj-1", "Refinement"),
        /no template assigned/,
      );
    });
  });

  describe("with workflowId — non-default workflow path", () => {
    it("returns phases from non-default workflow template when workflowId provided", async () => {
      resetState();
      // wf-custom points to 'custom-workflow' template which has Build phase
      const phase = await getPhaseConfig("proj-1", "Build", "wf-custom");
      assert.ok(phase, "expected a phase object for non-default workflow");
      assert.strictEqual(phase!.name, "Build");
    });

    it("returns null for a phase that doesn't exist in the non-default template", async () => {
      resetState();
      // 'custom-workflow' has Build not Refinement
      const phase = await getPhaseConfig("proj-1", "Refinement", "wf-custom");
      assert.strictEqual(phase, null);
    });

    it("falls back to project template when workflowId is not found in store", async () => {
      resetState();
      // 'wf-unknown' is not in workflowState — falls back to project template
      const phase = await getPhaseConfig("proj-1", "Refinement", "wf-unknown");
      assert.ok(phase, "expected fallback to project template");
      assert.strictEqual(phase!.name, "Refinement");
    });

    it("uses global catalog template directly for non-default workflow (not per-project copy)", async () => {
      resetState();
      // wf-custom → 'custom-workflow' in global catalog → has Build phase
      // The default project template 'product-development' does NOT have Build
      // So if we get Build, we know we're using the global catalog
      const buildPhase = await getPhaseConfig("proj-1", "Build", "wf-custom");
      const refinementPhase = await getPhaseConfig("proj-1", "Refinement", "wf-custom");
      assert.ok(buildPhase, "Build phase should exist in non-default workflow");
      assert.strictEqual(refinementPhase, null, "Refinement should NOT be in custom-workflow template");
    });
  });
});

describe("isPhaseDisabled", () => {
  it("returns false when phase is not in disabledPhases", async () => {
    resetState();
    const result = await isPhaseDisabled("proj-1", "Refinement");
    assert.strictEqual(result, false);
  });

  it("returns true when phase is in disabledPhases", async () => {
    resetState();
    projectState.disabledPhases = ["Refinement"];
    const result = await isPhaseDisabled("proj-1", "Refinement");
    assert.strictEqual(result, true);
  });
});

describe("resolveTargetPhase", () => {
  it("returns the requested phase when it is enabled", async () => {
    resetState();
    const result = await resolveTargetPhase("proj-1", "Refinement");
    assert.strictEqual(result, "Refinement");
  });

  it("skips disabled phases and returns next enabled phase", async () => {
    resetState();
    projectState.disabledPhases = ["Refinement"];
    // Ideas → Refinement (disabled) → Done
    const result = await resolveTargetPhase("proj-1", "Refinement");
    assert.strictEqual(result, "Done");
  });

  it("uses non-default workflow template when workflowId provided", async () => {
    resetState();
    // wf-custom → custom-workflow → phases: Ideas, Build, Done
    const result = await resolveTargetPhase("proj-1", "Build", "wf-custom");
    assert.strictEqual(result, "Build");
  });
});
