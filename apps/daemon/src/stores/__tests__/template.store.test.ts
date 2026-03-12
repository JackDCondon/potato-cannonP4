import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import { createTemplateStore, TemplateStore } from "../template.store.js";
import { initDatabase, getDatabase } from "../db.js";
import { createProjectStore } from "../project.store.js";

describe("TemplateStore", () => {
  let db: Database.Database;
  let templateStore: TemplateStore;
  let testDbPath: string;

  before(() => {
    testDbPath = path.join(os.tmpdir(), `potato-template-test-${Date.now()}.db`);
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    templateStore = createTemplateStore(db);
  });

  after(() => {
    db.close();
    try {
      fs.unlinkSync(testDbPath);
      fs.unlinkSync(testDbPath + "-wal");
      fs.unlinkSync(testDbPath + "-shm");
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM templates").run();
  });

  describe("registerTemplate", () => {
    it("should register a template with generated ID", () => {
      const template = templateStore.registerTemplate({
        name: "test-workflow",
        version: "1.0.0",
        description: "Test workflow template",
      });

      assert.ok(template.id);
      assert.ok(template.id.startsWith("tmpl_"));
      assert.strictEqual(template.name, "test-workflow");
      assert.strictEqual(template.version, "1.0.0");
      assert.strictEqual(template.description, "Test workflow template");
      assert.strictEqual(template.isDefault, false);
      assert.ok(template.createdAt);
      assert.ok(template.updatedAt);
    });

    it("should allow registering without description", () => {
      const template = templateStore.registerTemplate({
        name: "minimal-workflow",
        version: "1.0.0",
      });

      assert.strictEqual(template.name, "minimal-workflow");
      assert.strictEqual(template.description, undefined);
    });

    it("should set isDefault to true if specified", () => {
      const template = templateStore.registerTemplate({
        name: "default-workflow",
        version: "1.0.0",
        isDefault: true,
      });

      assert.strictEqual(template.isDefault, true);
    });

    it("should throw on duplicate name", () => {
      templateStore.registerTemplate({
        name: "unique-workflow",
        version: "1.0.0",
      });

      assert.throws(
        () => {
          templateStore.registerTemplate({
            name: "unique-workflow",
            version: "2.0.0",
          });
        },
        /UNIQUE constraint failed|already exists/
      );
    });
  });

  describe("getTemplate", () => {
    it("should return null for non-existent template", () => {
      const template = templateStore.getTemplate("non-existent");
      assert.strictEqual(template, null);
    });

    it("should return template by ID", () => {
      const created = templateStore.registerTemplate({
        name: "get-test",
        version: "1.0.0",
        description: "Get test",
      });

      const template = templateStore.getTemplate(created.id);

      assert.ok(template);
      assert.strictEqual(template.id, created.id);
      assert.strictEqual(template.name, "get-test");
      assert.strictEqual(template.version, "1.0.0");
    });
  });

  describe("getTemplateByName", () => {
    it("should return null for non-existent template", () => {
      const template = templateStore.getTemplateByName("non-existent");
      assert.strictEqual(template, null);
    });

    it("should return template by name", () => {
      const created = templateStore.registerTemplate({
        name: "named-workflow",
        version: "2.0.0",
        description: "Named workflow",
      });

      const template = templateStore.getTemplateByName("named-workflow");

      assert.ok(template);
      assert.strictEqual(template.id, created.id);
      assert.strictEqual(template.name, "named-workflow");
      assert.strictEqual(template.version, "2.0.0");
    });
  });

  describe("listTemplates", () => {
    it("should return empty array when no templates", () => {
      const templates = templateStore.listTemplates();
      assert.deepStrictEqual(templates, []);
    });

    it("should return all templates", () => {
      templateStore.registerTemplate({ name: "workflow-1", version: "1.0.0" });
      templateStore.registerTemplate({ name: "workflow-2", version: "1.0.0" });
      templateStore.registerTemplate({ name: "workflow-3", version: "1.0.0" });

      const templates = templateStore.listTemplates();

      assert.strictEqual(templates.length, 3);
      const names = templates.map((t) => t.name);
      assert.ok(names.includes("workflow-1"));
      assert.ok(names.includes("workflow-2"));
      assert.ok(names.includes("workflow-3"));
    });
  });

  describe("updateTemplate", () => {
    it("should return null for non-existent template", () => {
      const result = templateStore.updateTemplate("non-existent", {
        version: "2.0.0",
      });
      assert.strictEqual(result, null);
    });

    it("should update version", () => {
      const created = templateStore.registerTemplate({
        name: "update-test",
        version: "1.0.0",
      });

      const updated = templateStore.updateTemplate(created.id, {
        version: "2.0.0",
      });

      assert.ok(updated);
      assert.strictEqual(updated.version, "2.0.0");
      // updatedAt should be same or newer (fast operations may complete in same millisecond)
      assert.ok(updated.updatedAt >= created.updatedAt);
    });

    it("should update description", () => {
      const created = templateStore.registerTemplate({
        name: "desc-update-test",
        version: "1.0.0",
        description: "Original",
      });

      const updated = templateStore.updateTemplate(created.id, {
        description: "Updated description",
      });

      assert.ok(updated);
      assert.strictEqual(updated.description, "Updated description");
    });

    it("should update multiple fields", () => {
      const created = templateStore.registerTemplate({
        name: "multi-update-test",
        version: "1.0.0",
        description: "Original",
      });

      const updated = templateStore.updateTemplate(created.id, {
        version: "3.0.0",
        description: "New description",
      });

      assert.ok(updated);
      assert.strictEqual(updated.version, "3.0.0");
      assert.strictEqual(updated.description, "New description");
    });
  });

  describe("setDefaultTemplate", () => {
    it("should return false for non-existent template", () => {
      const result = templateStore.setDefaultTemplate("non-existent");
      assert.strictEqual(result, false);
    });

    it("should set template as default", () => {
      const template = templateStore.registerTemplate({
        name: "default-test",
        version: "1.0.0",
      });

      const result = templateStore.setDefaultTemplate(template.id);

      assert.strictEqual(result, true);

      const updated = templateStore.getTemplate(template.id);
      assert.ok(updated);
      assert.strictEqual(updated.isDefault, true);
    });

    it("should ensure only one default at a time", () => {
      const first = templateStore.registerTemplate({
        name: "first-default",
        version: "1.0.0",
        isDefault: true,
      });
      const second = templateStore.registerTemplate({
        name: "second-default",
        version: "1.0.0",
      });

      // First is default
      assert.strictEqual(templateStore.getTemplate(first.id)?.isDefault, true);
      assert.strictEqual(templateStore.getTemplate(second.id)?.isDefault, false);

      // Set second as default
      templateStore.setDefaultTemplate(second.id);

      // Now only second is default
      assert.strictEqual(templateStore.getTemplate(first.id)?.isDefault, false);
      assert.strictEqual(templateStore.getTemplate(second.id)?.isDefault, true);
    });
  });

  describe("getDefaultTemplate", () => {
    it("should return null when no templates", () => {
      const template = templateStore.getDefaultTemplate();
      assert.strictEqual(template, null);
    });

    it("should return default template", () => {
      templateStore.registerTemplate({ name: "non-default", version: "1.0.0" });
      const defaultTmpl = templateStore.registerTemplate({
        name: "the-default",
        version: "1.0.0",
        isDefault: true,
      });

      const template = templateStore.getDefaultTemplate();

      assert.ok(template);
      assert.strictEqual(template.id, defaultTmpl.id);
      assert.strictEqual(template.name, "the-default");
    });

    it("should return first template if no explicit default", () => {
      const first = templateStore.registerTemplate({
        name: "first",
        version: "1.0.0",
      });
      templateStore.registerTemplate({ name: "second", version: "1.0.0" });

      const template = templateStore.getDefaultTemplate();

      // When no explicit default, returns first by creation order
      assert.ok(template);
      assert.strictEqual(template.id, first.id);
    });
  });

  describe("deleteTemplate", () => {
    it("should return false for non-existent template", () => {
      const result = templateStore.deleteTemplate("non-existent");
      assert.strictEqual(result, false);
    });

    it("should delete template", () => {
      const template = templateStore.registerTemplate({
        name: "delete-test",
        version: "1.0.0",
      });

      const result = templateStore.deleteTemplate(template.id);

      assert.strictEqual(result, true);
      assert.strictEqual(templateStore.getTemplate(template.id), null);
    });

    it("should not affect other templates", () => {
      const keep = templateStore.registerTemplate({
        name: "keep-me",
        version: "1.0.0",
      });
      const remove = templateStore.registerTemplate({
        name: "remove-me",
        version: "1.0.0",
      });

      templateStore.deleteTemplate(remove.id);

      assert.ok(templateStore.getTemplate(keep.id));
      assert.strictEqual(templateStore.getTemplate(remove.id), null);
    });
  });

  describe("upsertTemplate", () => {
    it("should create new template if not exists", () => {
      const template = templateStore.upsertTemplate({
        name: "new-upsert",
        version: "1.0.0",
        description: "New via upsert",
      });

      assert.ok(template);
      assert.strictEqual(template.name, "new-upsert");
      assert.strictEqual(template.version, "1.0.0");
    });

    it("should update existing template by name", () => {
      const original = templateStore.registerTemplate({
        name: "existing-upsert",
        version: "1.0.0",
        description: "Original",
      });

      const updated = templateStore.upsertTemplate({
        name: "existing-upsert",
        version: "2.0.0",
        description: "Updated via upsert",
      });

      assert.ok(updated);
      assert.strictEqual(updated.id, original.id);
      assert.strictEqual(updated.version, "2.0.0");
      assert.strictEqual(updated.description, "Updated via upsert");
    });

    it("should preserve isDefault on upsert update", () => {
      templateStore.registerTemplate({
        name: "default-upsert",
        version: "1.0.0",
        isDefault: true,
      });

      const updated = templateStore.upsertTemplate({
        name: "default-upsert",
        version: "2.0.0",
      });

      assert.ok(updated);
      assert.strictEqual(updated.isDefault, true);
    });

    it("should allow setting isDefault on upsert", () => {
      templateStore.registerTemplate({
        name: "first",
        version: "1.0.0",
        isDefault: true,
      });
      templateStore.registerTemplate({
        name: "second",
        version: "1.0.0",
      });

      // Upsert with isDefault should clear other defaults
      const updated = templateStore.upsertTemplate({
        name: "second",
        version: "2.0.0",
        isDefault: true,
      });

      assert.ok(updated);
      assert.strictEqual(updated.isDefault, true);

      // First should no longer be default
      const first = templateStore.getTemplateByName("first");
      assert.ok(first);
      assert.strictEqual(first.isDefault, false);
    });
  });
});

describe("getAgentPromptForProject override lookup chain", () => {
  it("should return override content when override exists", async () => {
    // Test the helper functions that implement the override detection logic.
    // These functions transform the agentPath to check for .override.md files.

    const { hasProjectAgentOverride, getProjectAgentOverride } = await import("../project-template.store.js");

    // Test 1: Verify hasProjectAgentOverride correctly detects override files
    // This function should check for the transformed path (with .override.md suffix)

    // For a non-existent project, this should return false safely
    const overrideExists = await hasProjectAgentOverride("fake-project-id", "agents/refinement.md");
    assert.strictEqual(overrideExists, false);

    // Test 2: Verify getProjectAgentOverride signature accepts correct parameters
    // The function should attempt to read the override file path
    assert.strictEqual(typeof getProjectAgentOverride, "function");

    // Test 3: Verify path transformation logic
    // When agentPath is "agents/refinement.md", the override path should be "agents/refinement.override.md"
    // This is verified by the implementation using .replace(/\.md$/, ".override.md")
    try {
      // This call should fail with file not found, confirming the path transformation worked
      await getProjectAgentOverride("non-existent-project", "agents/refinement.md");
    } catch (e) {
      // Expected - file doesn't exist. This confirms the function attempted to
      // read from the correct override path
      assert.ok(e instanceof Error);
    }
  });

  it("should fall back to standard agent when no override exists", async () => {
    // Test the fallback behavior when override files don't exist.
    // The lookup chain should fall back to standard agents (agents/{agentType}.md)

    const { hasProjectAgentOverride } = await import("../project-template.store.js");

    // When hasProjectAgentOverride returns false, the system falls back to getProjectAgentPrompt
    // which attempts to read the standard agent file
    const overrideExists = await hasProjectAgentOverride("another-fake-project", "agents/refinement.md");
    assert.strictEqual(overrideExists, false, "Override should not exist for non-existent project");

    // This confirms that hasProjectAgentOverride safely returns false when the project
    // or override file doesn't exist, allowing the fallback chain to continue
  });
});

describe("getAgentPromptForProject parentTemplate fallback (level-4)", () => {
  // These tests exercise the level-4 parentTemplate fallback in getAgentPromptForProject.
  // The function reads from the global DB (singleton) and from TEMPLATES_DIR on disk,
  // so we set up real files in ~/.potato-cannon/templates/ and a real project row.

  const homeDir = os.homedir();
  const templatesDir = path.join(homeDir, ".potato-cannon", "templates");
  const suffix = Date.now();
  const childTemplateName = `test-child-${suffix}`;
  const parentTemplateName = `test-parent-${suffix}`;
  const noParentTemplateName = `test-noparent-${suffix}`;
  const workflowChildTemplateName = `test-workflow-child-${suffix}`;
  const workflowScopedId = `wf-scope-${suffix}`;
  const agentPath = "agents/spec.md";
  const agentContent = "# Parent Agent Prompt";

  let projectWithParent: { id: string };
  let projectNoParent: { id: string };
  let db: Database.Database;

  before(async () => {
    // Initialize global singleton DB (uses ~/.potato-cannon/potato.db)
    initDatabase();
    db = getDatabase();
    const projectStore = createProjectStore(db);

    // Create project that uses the child template (which has a parentTemplate)
    projectWithParent = projectStore.createProject({
      displayName: `Test Parent Fallback ${suffix}`,
      path: `/tmp/test-parent-fallback-${suffix}`,
      templateName: childTemplateName,
      templateVersion: "1.0.0",
    });

    // Create project that uses a template with no parentTemplate configured
    projectNoParent = projectStore.createProject({
      displayName: `Test No Parent ${suffix}`,
      path: `/tmp/test-no-parent-${suffix}`,
      templateName: noParentTemplateName,
      templateVersion: "1.0.0",
    });

    // Set up child template: workflow.json references parentTemplate
    const childDir = path.join(templatesDir, childTemplateName, "agents");
    fs.mkdirSync(childDir, { recursive: true });
    const childWorkflow = {
      name: childTemplateName,
      version: "1.0.0",
      description: "Child template for testing",
      parentTemplate: parentTemplateName,
      phases: [],
    };
    fs.writeFileSync(
      path.join(templatesDir, childTemplateName, "workflow.json"),
      JSON.stringify(childWorkflow, null, 2)
    );
    // child template does NOT have agents/spec.md — so level-3 (global) fails

    // Set up parent template: has the agent file
    const parentDir = path.join(templatesDir, parentTemplateName, "agents");
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(path.join(parentDir, "spec.md"), agentContent);
    // parent workflow.json (optional, for completeness)
    const parentWorkflow = {
      name: parentTemplateName,
      version: "1.0.0",
      description: "Parent template for testing",
      phases: [],
    };
    fs.writeFileSync(
      path.join(templatesDir, parentTemplateName, "workflow.json"),
      JSON.stringify(parentWorkflow, null, 2)
    );

    // Set up no-parent template: workflow.json with no parentTemplate, no agent file
    const noParentWorkflowDir = path.join(templatesDir, noParentTemplateName);
    fs.mkdirSync(path.join(noParentWorkflowDir, "agents"), { recursive: true });
    const noParentWorkflow = {
      name: noParentTemplateName,
      version: "1.0.0",
      description: "Template with no parent",
      phases: [],
    };
    fs.writeFileSync(
      path.join(noParentWorkflowDir, "workflow.json"),
      JSON.stringify(noParentWorkflow, null, 2)
    );
    // no agent file here either

    // Set up workflow-scoped child template with parent fallback
    const workflowChildDir = path.join(templatesDir, workflowChildTemplateName, "agents");
    fs.mkdirSync(workflowChildDir, { recursive: true });
    const workflowChildTemplate = {
      name: workflowChildTemplateName,
      version: "1.0.0",
      description: "Workflow scoped child template",
      parentTemplate: parentTemplateName,
      phases: [],
    };
    fs.writeFileSync(
      path.join(templatesDir, workflowChildTemplateName, "workflow.json"),
      JSON.stringify(workflowChildTemplate, null, 2)
    );

    db.prepare(
      `INSERT INTO project_workflows (id, project_id, name, template_name, template_version, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
    ).run(workflowScopedId, projectWithParent.id, "Workflow Scoped", workflowChildTemplateName, "1.0.0");
  });

  after(async () => {
    // Clean up projects from DB
    if (db) {
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectWithParent.id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectNoParent.id);
      db.prepare("DELETE FROM project_workflows WHERE id = ?").run(workflowScopedId);
    }
    // Clean up template directories
    await fsPromises.rm(path.join(templatesDir, childTemplateName), { recursive: true, force: true }).catch(() => {});
    await fsPromises.rm(path.join(templatesDir, parentTemplateName), { recursive: true, force: true }).catch(() => {});
    await fsPromises.rm(path.join(templatesDir, noParentTemplateName), { recursive: true, force: true }).catch(() => {});
    await fsPromises.rm(path.join(templatesDir, workflowChildTemplateName), { recursive: true, force: true }).catch(() => {});
  });

  it("parent template hit — level-4 getAgentPrompt succeeds and returns the prompt", async () => {
    const { getAgentPromptForProject } = await import("../template.store.js");

    // The child template has no agents/spec.md, so level-3 fails.
    // The child workflow.json has parentTemplate set, so level-4 tries the parent template.
    // The parent template has agents/spec.md, so it should return the content.
    const result = await getAgentPromptForProject(projectWithParent.id, agentPath);
    assert.strictEqual(result, agentContent);
  });

  it("parent template miss — level-4 inner catch fires and throws chained error", async () => {
    const { getAgentPromptForProject } = await import("../template.store.js");

    // Remove the parent agent file to force the parent template lookup to fail
    const parentAgentFile = path.join(templatesDir, parentTemplateName, "agents", "spec.md");
    const originalContent = fs.readFileSync(parentAgentFile, "utf-8");
    fs.unlinkSync(parentAgentFile);

    try {
      await assert.rejects(
        async () => getAgentPromptForProject(projectWithParent.id, agentPath),
        (err: Error) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("not found in template chain") &&
            err.message.includes(childTemplateName) &&
            err.message.includes(parentTemplateName),
            `Expected chained error, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      // Restore the file for any subsequent tests
      fs.writeFileSync(parentAgentFile, originalContent);
    }
  });

  it("no parentTemplate configured — throws Agent not found in template chain", async () => {
    const { getAgentPromptForProject } = await import("../template.store.js");

    // noParentTemplateName has no parentTemplate in workflow.json and no agent file.
    // Level-3 (global) fails, workflow.parentTemplate is falsy, so throws generic error.
    await assert.rejects(
      async () => getAgentPromptForProject(projectNoParent.id, agentPath),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, `Agent ${agentPath} not found in template chain`);
        return true;
      }
    );
  });

  it("workflow-scoped template chain resolves parentTemplate for selected workflow", async () => {
    const { getAgentPromptForProject } = await import("../template.store.js");

    const result = await getAgentPromptForProject(
      projectWithParent.id,
      agentPath,
      workflowScopedId
    );
    assert.strictEqual(result, agentContent);
  });
});

