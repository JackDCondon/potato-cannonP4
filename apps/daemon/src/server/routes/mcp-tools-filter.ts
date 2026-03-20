/**
 * MCP tool list filtering utilities.
 *
 * Provides helpers to filter the tool list returned by GET /mcp/tools
 * based on an agent's `disallowTools` configuration in the workflow template.
 */

import { projectWorkflowGetDefault } from "../../stores/project-workflow.store.js";
import { getWorkflowTemplate, getProjectTemplate } from "../../stores/project-template.store.js";
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
 * Search all phases of a template for an agent with the matching source path.
 */
function findAgentInWorkerTree(
  phases: { workers: Worker[] }[],
  agentSource: string,
): AgentWorker | null {
  for (const phase of phases) {
    const agents = collectAgentWorkers(phase.workers);
    const match = agents.find((a) => a.source === agentSource);
    if (match) return match;
  }
  return null;
}

/**
 * Look up an agent worker in the project's workflow config by its source path.
 *
 * Uses the project's default workflow to load the template, then searches
 * the full worker tree for an agent with a matching `source` field.
 *
 * Uses "first tier that contains the agent wins" logic: if a template is found
 * but does not contain the agent, the search continues to the next tier.
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

  // Three-tier fallback: workflow-local → project-local → global catalog
  // Each tier is tried in order; a non-null template that doesn't contain the
  // agent does NOT stop the search — we continue to the next tier.
  const tier1 = await getWorkflowTemplate(projectId, workflow.id);
  const agent1 = tier1 ? findAgentInWorkerTree(tier1.phases, agentSource) : null;
  if (agent1) return agent1;

  const tier2 = await getProjectTemplate(projectId);
  const agent2 = tier2 ? findAgentInWorkerTree(tier2.phases, agentSource) : null;
  if (agent2) return agent2;

  const tier3 = await getWorkflow(workflow.templateName);
  const agent3 = tier3 ? findAgentInWorkerTree(tier3.phases, agentSource) : null;
  if (agent3) return agent3;

  return null;
}
