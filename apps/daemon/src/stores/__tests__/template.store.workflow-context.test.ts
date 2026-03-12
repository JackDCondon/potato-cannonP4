import { before, after, describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { initDatabase, getDatabase } from "../db.js";
import { createProjectStore } from "../project.store.js";
import { projectWorkflowCreate, projectWorkflowDelete } from "../project-workflow.store.js";
import {
  getAgentPromptForProject,
  getTemplateWithFullPhasesForContext,
} from "../template.store.js";

describe("template workflow context resolution", () => {
  const suffix = Date.now();
  const projectTemplateName = `ctx-project-default-${suffix}`;
  const workflowTemplateName = `ctx-workflow-child-${suffix}`;
  const parentTemplateName = `ctx-workflow-parent-${suffix}`;
  const templatesDir = path.join(os.homedir(), ".potato-cannon", "templates");

  let projectId = "";
  let workflowId = "";

  before(async () => {
    initDatabase();
    const db = getDatabase();
    const projectStore = createProjectStore(db);

    const project = projectStore.createProject({
      displayName: `Workflow Context Test ${suffix}`,
      path: path.join(os.tmpdir(), `workflow-context-${suffix}`),
      templateName: projectTemplateName,
      templateVersion: "1.0.0",
    });
    projectId = project.id;

    const workflow = projectWorkflowCreate({
      projectId,
      name: "Solve Issue",
      templateName: workflowTemplateName,
      isDefault: false,
    });
    workflowId = workflow.id;

    await fs.mkdir(path.join(templatesDir, projectTemplateName, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(templatesDir, projectTemplateName, "workflow.json"),
      JSON.stringify({
        name: projectTemplateName,
        version: "1.0.0",
        phases: [
          {
            id: "Refinement",
            name: "Refinement",
            workers: [],
            transitions: { next: "Done" },
          },
        ],
      }, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(templatesDir, projectTemplateName, "agents", "refinement.md"),
      "# Default refinement prompt",
      "utf-8",
    );

    await fs.mkdir(path.join(templatesDir, parentTemplateName, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(templatesDir, parentTemplateName, "workflow.json"),
      JSON.stringify({
        name: parentTemplateName,
        version: "1.0.0",
        phases: [],
      }, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(templatesDir, parentTemplateName, "agents", "builder.md"),
      "# Builder prompt from parent template",
      "utf-8",
    );

    await fs.mkdir(path.join(templatesDir, workflowTemplateName, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(templatesDir, workflowTemplateName, "workflow.json"),
      JSON.stringify({
        name: workflowTemplateName,
        version: "1.0.0",
        parentTemplate: parentTemplateName,
        phases: [
          {
            id: "Solve-Issue",
            name: "Solve Issue",
            workers: [
              {
                id: "builder",
                type: "agent",
                source: "agents/builder.md",
              },
            ],
            transitions: { next: "Done" },
          },
        ],
      }, null, 2),
      "utf-8",
    );
  });

  after(async () => {
    const db = getDatabase();
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    projectWorkflowDelete(workflowId);
    await fs.rm(path.join(templatesDir, projectTemplateName), { recursive: true, force: true });
    await fs.rm(path.join(templatesDir, workflowTemplateName), { recursive: true, force: true });
    await fs.rm(path.join(templatesDir, parentTemplateName), { recursive: true, force: true });
  });

  it("uses workflow template phases when workflowId is provided", async () => {
    const template = await getTemplateWithFullPhasesForContext(projectId, workflowId);
    assert.ok(template, "expected template to resolve");
    const phaseNames = template.phases.map((phase) => phase.name);
    assert.ok(phaseNames.includes("Solve Issue"));
    assert.ok(!phaseNames.includes("Refinement"));
  });

  it("resolves inherited agent prompt from workflow template chain", async () => {
    const prompt = await getAgentPromptForProject(projectId, "agents/builder.md", workflowId);
    assert.strictEqual(prompt, "# Builder prompt from parent template");
  });

  it("throws explicit error when workflowId is missing for context resolution", async () => {
    await assert.rejects(
      () => getTemplateWithFullPhasesForContext(projectId),
      /WORKFLOW_ID_REQUIRED|workflowId is required/,
    );
  });

  it("throws explicit error when workflowId does not exist", async () => {
    await assert.rejects(
      () => getTemplateWithFullPhasesForContext(projectId, "wf-missing"),
      /WORKFLOW_NOT_FOUND|was not found/,
    );
  });

  it("rejects legacy model config when resolving workflow template context", async () => {
    const workflowPath = path.join(templatesDir, workflowTemplateName, "workflow.json");
    const original = await fs.readFile(workflowPath, "utf-8");

    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        name: workflowTemplateName,
        version: "1.0.0",
        parentTemplate: parentTemplateName,
        phases: [
          {
            id: "Solve-Issue",
            name: "Solve Issue",
            workers: [
              {
                id: "builder",
                type: "agent",
                source: "agents/builder.md",
                model: "opus",
              },
            ],
            transitions: { next: "Done" },
          },
        ],
      }, null, 2),
      "utf-8",
    );

    try {
      await assert.rejects(
        () => getTemplateWithFullPhasesForContext(projectId, workflowId),
        /deprecated field "model"|invalid legacy model value "opus"/,
      );
    } finally {
      await fs.writeFile(workflowPath, original, "utf-8");
    }
  });
});
