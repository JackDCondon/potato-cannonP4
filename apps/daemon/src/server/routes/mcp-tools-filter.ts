/**
 * MCP tool list filtering utilities.
 *
 * Provides helpers to filter the tool list returned by GET /mcp/tools
 * based on an agent's `disallowTools` configuration in the workflow template.
 */

import { projectWorkflowGetDefault } from "../../stores/project-workflow.store.js";
import { getWorkflowTemplate } from "../../stores/project-template.store.js";
import { getWorkflow } from "../../stores/template.store.js";
import type { AgentWorker, Worker } from "../../types/template.types.js";

/**
 * Validate that agentSource matches the expected path pattern.
 * Prevents path traversal (Risk R3).
 */
export const AGENT_SOURCE_PATTERN = /^agents\/[\w\-]+\.md$/;

/**
 * Filter a tool list by removing tools named in the disallow list.
 */
export function filterToolsByDisallowList<T extends { name: string }>(
  tools: T[],
  disallowList: string[],
): T[] {
  if (!disallowList.length) return tools;
  return tools.filter((tool) => !disallowList.includes(tool.name));
}

/**
 * Recursively collect all AgentWorker nodes from a worker tree.
 */
function collectAgentWorkers(workers: Worker[]): AgentWorker[] {
  const result: AgentWorker[] = [];
  for (const worker of workers) {
    if (worker.type === "agent") {
      result.push(worker);
    } else if (worker.type === "ralphLoop" || worker.type === "taskLoop") {
      result.push(...collectAgentWorkers(worker.workers));
    }
  }
  return result;
}

/**
 * Look up an agent worker in the project's workflow config by its source path.
 *
 * Uses the project's default workflow to load the template, then searches
 * the full worker tree for an agent with a matching `source` field.
 *
 * Returns null if the workflow, template, or agent cannot be found.
 */
export async function findAgentWorkerInWorkflow(
  projectId: string,
  agentSource: string,
): Promise<AgentWorker | null> {
  // Get the default workflow for this project
  const workflow = projectWorkflowGetDefault(projectId);
  if (!workflow) return null;

  // Prefer the workflow-local template (project copy), fall back to global catalog
  let template = await getWorkflowTemplate(projectId, workflow.id);
  if (!template) {
    template = await getWorkflow(workflow.templateName);
  }
  if (!template) return null;

  // Search all phases for an agent with matching source
  for (const phase of template.phases) {
    const agents = collectAgentWorkers(phase.workers);
    const match = agents.find((a) => a.source === agentSource);
    if (match) return match;
  }

  return null;
}
