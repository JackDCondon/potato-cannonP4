// src/stores/project-template.store.ts
import fs from "fs/promises";
import path from "path";
import { getProjectTemplateDir, getWorkflowTemplateDir } from "../config/paths.js";
import { getTemplate, getAgentPrompt as getGlobalAgentPrompt, getTemplateChangelog } from "./template.store.js";
import type { WorkflowTemplate } from "../types/template.types.js";
import { legacyVersionToSemver } from "../utils/semver.js";

function getScopedTemplateDir(projectId: string, workflowId?: string | null): string {
  return workflowId
    ? getWorkflowTemplateDir(projectId, workflowId)
    : getProjectTemplateDir(projectId);
}

/**
 * Check if a project has a local template copy.
 */
export async function hasProjectTemplate(projectId: string): Promise<boolean> {
  const templateDir = getProjectTemplateDir(projectId);
  try {
    await fs.access(path.join(templateDir, "workflow.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a project has an override file for the given agent.
 * @param projectId - Project identifier
 * @param agentPath - Path like "agents/refinement.md"
 * @returns true if override exists (e.g., agents/refinement.override.md)
 */
export async function hasProjectAgentOverride(
  projectId: string,
  agentPath: string,
  workflowId?: string | null,
): Promise<boolean> {
  const templateDir = getScopedTemplateDir(projectId, workflowId);
  const overridePath = agentPath.replace(/\.md$/, ".override.md");
  try {
    await fs.access(path.join(templateDir, overridePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the project's local template.
 * Returns null if no local template exists.
 */
export async function getProjectTemplate(
  projectId: string
): Promise<WorkflowTemplate | null> {
  const templateDir = getProjectTemplateDir(projectId);
  const workflowPath = path.join(templateDir, "workflow.json");

  try {
    const content = await fs.readFile(workflowPath, "utf-8");
    const template = JSON.parse(content) as WorkflowTemplate;

    // Migrate legacy integer version to semver
    if (typeof template.version === "number") {
      template.version = legacyVersionToSemver(template.version as unknown as number);
    }

    return template;
  } catch {
    return null;
  }
}

/**
 * Get agent prompt from project's local template.
 */
export async function getProjectAgentPrompt(
  projectId: string,
  agentPath: string,
  workflowId?: string | null,
): Promise<string> {
  const templateDir = getScopedTemplateDir(projectId, workflowId);
  const fullPath = path.join(templateDir, agentPath);
  return fs.readFile(fullPath, "utf-8");
}

/**
 * Get the override content for an agent.
 * @param projectId - Project identifier
 * @param agentPath - Path like "agents/refinement.md"
 * @returns Content of the override file
 * @throws If override file doesn't exist
 */
export async function getProjectAgentOverride(
  projectId: string,
  agentPath: string,
  workflowId?: string | null,
): Promise<string> {
  const templateDir = getScopedTemplateDir(projectId, workflowId);
  const overridePath = agentPath.replace(/\.md$/, ".override.md");
  return fs.readFile(path.join(templateDir, overridePath), "utf-8");
}

/**
 * Save override content for an agent.
 * Creates directories if needed.
 * @param projectId - Project identifier
 * @param agentPath - Path like "agents/refinement.md"
 * @param content - Override content to write
 */
export async function saveProjectAgentOverride(
  projectId: string,
  agentPath: string,
  content: string,
  workflowId?: string | null,
): Promise<void> {
  const templateDir = getScopedTemplateDir(projectId, workflowId);
  const overridePath = agentPath.replace(/\.md$/, ".override.md");
  const fullPath = path.join(templateDir, overridePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

/**
 * Delete override file for an agent.
 * Idempotent - succeeds even if file doesn't exist.
 * @param projectId - Project identifier
 * @param agentPath - Path like "agents/refinement.md"
 */
export async function deleteProjectAgentOverride(
  projectId: string,
  agentPath: string,
  workflowId?: string | null,
): Promise<void> {
  const templateDir = getScopedTemplateDir(projectId, workflowId);
  const overridePath = agentPath.replace(/\.md$/, ".override.md");
  await fs.rm(path.join(templateDir, overridePath), { force: true });
}

/**
 * Copy a template from the global catalog to a project's local storage.
 */
export async function copyTemplateToProject(
  projectId: string,
  templateName: string
): Promise<WorkflowTemplate> {
  const globalTemplate = await getTemplate(templateName);
  if (!globalTemplate) {
    throw new Error(`Template "${templateName}" not found in catalog`);
  }

  const templateDir = getProjectTemplateDir(projectId);

  // Create directory structure
  await fs.mkdir(templateDir, { recursive: true });
  await fs.mkdir(path.join(templateDir, "agents"), { recursive: true });

  // Migrate legacy version if needed
  const version =
    typeof globalTemplate.version === "number"
      ? legacyVersionToSemver(globalTemplate.version as unknown as number)
      : globalTemplate.version;

  const localTemplate: WorkflowTemplate = {
    ...globalTemplate,
    version,
  };

  // Write workflow.json
  await fs.writeFile(
    path.join(templateDir, "workflow.json"),
    JSON.stringify(localTemplate, null, 2)
  );

  // Copy all agent files
  for (const phase of globalTemplate.phases) {
    for (const worker of phase.workers) {
      await copyWorkersAgents(templateDir, templateName, worker);
    }
  }

  // Copy changelog if it exists
  const changelog = await getTemplateChangelog(templateName);
  if (changelog) {
    await fs.writeFile(path.join(templateDir, "changelog.md"), changelog);
  }

  return localTemplate;
}

/**
 * Recursively copy agent files from workers (handles nested loops).
 */
async function copyWorkersAgents(
  templateDir: string,
  templateName: string,
  worker: unknown
): Promise<void> {
  const w = worker as { type: string; source?: string; workers?: unknown[] };

  if (w.type === "agent" && w.source) {
    try {
      const content = await getGlobalAgentPrompt(templateName, w.source);
      const targetPath = path.join(templateDir, w.source);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
    } catch {
      // Agent file doesn't exist in global template, skip
    }
  }

  // Recurse into nested workers (ralphLoop, taskLoop)
  if (w.workers && Array.isArray(w.workers)) {
    for (const nested of w.workers) {
      await copyWorkersAgents(templateDir, templateName, nested);
    }
  }
}

/**
 * Check if a workflow has a local template copy.
 */
export async function hasWorkflowTemplate(
  projectId: string,
  workflowId: string,
): Promise<boolean> {
  const templateDir = getWorkflowTemplateDir(projectId, workflowId);
  try {
    await fs.access(path.join(templateDir, "workflow.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a workflow-local template.
 */
export async function getWorkflowTemplate(
  projectId: string,
  workflowId: string,
): Promise<WorkflowTemplate | null> {
  const templateDir = getWorkflowTemplateDir(projectId, workflowId);
  const workflowPath = path.join(templateDir, "workflow.json");
  try {
    const content = await fs.readFile(workflowPath, "utf-8");
    const template = JSON.parse(content) as WorkflowTemplate;
    if (typeof template.version === "number") {
      template.version = legacyVersionToSemver(template.version as unknown as number);
    }
    return template;
  } catch {
    return null;
  }
}

/**
 * Copy a template from the global catalog to workflow-local storage.
 */
export async function copyTemplateToWorkflow(
  projectId: string,
  workflowId: string,
  templateName: string,
): Promise<WorkflowTemplate> {
  const globalTemplate = await getTemplate(templateName);
  if (!globalTemplate) {
    throw new Error(`Template "${templateName}" not found in catalog`);
  }

  const templateDir = getWorkflowTemplateDir(projectId, workflowId);
  await fs.mkdir(templateDir, { recursive: true });
  await fs.mkdir(path.join(templateDir, "agents"), { recursive: true });

  const version =
    typeof globalTemplate.version === "number"
      ? legacyVersionToSemver(globalTemplate.version as unknown as number)
      : globalTemplate.version;

  const localTemplate: WorkflowTemplate = {
    ...globalTemplate,
    version,
  };

  await fs.writeFile(
    path.join(templateDir, "workflow.json"),
    JSON.stringify(localTemplate, null, 2)
  );

  for (const phase of globalTemplate.phases) {
    for (const worker of phase.workers) {
      await copyWorkersAgents(templateDir, templateName, worker);
    }
  }

  const changelog = await getTemplateChangelog(templateName);
  if (changelog) {
    await fs.writeFile(path.join(templateDir, "changelog.md"), changelog);
  }

  return localTemplate;
}

export async function getWorkflowChangelog(
  projectId: string,
  workflowId: string,
): Promise<string | null> {
  const templateDir = getWorkflowTemplateDir(projectId, workflowId);
  try {
    return await fs.readFile(path.join(templateDir, "changelog.md"), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get changelog from project's local template.
 */
export async function getProjectChangelog(projectId: string): Promise<string | null> {
  const templateDir = getProjectTemplateDir(projectId);
  try {
    return await fs.readFile(path.join(templateDir, "changelog.md"), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Delete a project's local template (for reset/cleanup).
 */
export async function deleteProjectTemplate(projectId: string): Promise<void> {
  const templateDir = getProjectTemplateDir(projectId);
  await fs.rm(templateDir, { recursive: true, force: true });
}
