// src/services/session/agent-loader.ts
import { getProjectById } from "../../stores/project.store.js";
import { getAgentPromptForProject } from "../../stores/template.store.js";

export interface AgentDefinition {
  description: string;
  prompt: string;
}

/**
 * Extract agent name from template path.
 * "agents/refinement.md" → "refinement"
 * "agents/adversarial-refinement.md" → "adversarial-refinement"
 */
export function extractAgentName(agentType: string): string {
  return agentType.replace(/^agents\//, "").replace(/\.md$/, "");
}

/**
 * Check if an agent type is a template-based agent (path to .md file).
 */
export function isTemplateAgent(agentType: string): boolean {
  return agentType.endsWith(".md") || agentType.startsWith("agents/");
}

/**
 * Load agent definition from template.
 * Returns the agent prompt content (with frontmatter stripped) and extracts description.
 */
export async function loadAgentDefinition(
  projectId: string,
  agentType: string,
): Promise<AgentDefinition> {
  const project = await getProjectById(projectId);
  if (!project?.template) {
    throw new Error(`Project ${projectId} has no template assigned`);
  }

  const promptContent = await getAgentPromptForProject(projectId, agentType);

  // Extract description from YAML frontmatter if present, and strip frontmatter from prompt
  const frontmatterMatch = promptContent.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  let description = `Agent: ${extractAgentName(agentType)}`;
  let prompt = promptContent;

  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const descMatch = frontmatter.match(/description:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch) {
      description = descMatch[1];
    }
    // Strip frontmatter from prompt
    prompt = promptContent.slice(frontmatterMatch[0].length);
  }

  // Load shared preamble if available and prepend to agent prompt.
  // Only pass scope content to agents that use scope/dependency tools.
  const agentFilename = agentType.replace(/^.*\//, ""); // basename only
  const includeScope = SCOPE_USING_AGENTS.has(agentFilename);
  const sharedContent = await loadSharedPreamble(projectId, includeScope);
  if (sharedContent) {
    prompt = `${sharedContent}\n\n---\n\n${prompt}`;
  }

  return {
    description,
    prompt,
  };
}

/**
 * Agent filenames that use scope/dependency tools and need the scope preamble.
 */
const SCOPE_USING_AGENTS = new Set([
  "refinement.md",
  "architect.md",
  "specification.md",
  "builder.md",
  "taskmaster.md",
  "bug-fix-taskmaster.md",
]);

/**
 * Load the shared preamble content for a project.
 * Always loads shared-core.md. Appends shared-scope.md when includeScope is true.
 * Returns the combined content with frontmatter stripped, or null if nothing found.
 */
export async function loadSharedPreamble(
  projectId: string,
  includeScope = false,
): Promise<string | null> {
  const stripFrontmatter = (raw: string): string => {
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    return fmMatch ? raw.slice(fmMatch[0].length) : raw;
  };

  const parts: string[] = [];

  try {
    const coreRaw = await getAgentPromptForProject(projectId, "agents/shared-core.md");
    const core = stripFrontmatter(coreRaw).trim();
    if (core) parts.push(core);
  } catch {
    // shared-core.md not found — continue
  }

  if (includeScope) {
    try {
      const scopeRaw = await getAgentPromptForProject(projectId, "agents/shared-scope.md");
      const scope = stripFrontmatter(scopeRaw).trim();
      if (scope) parts.push(scope);
    } catch {
      // shared-scope.md not found — continue
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Build the --agents JSON for Claude CLI.
 * Maps agent name to its definition.
 */
export async function buildAgentsJson(
  projectId: string,
  agentType: string,
): Promise<string> {
  const agentDef = await loadAgentDefinition(projectId, agentType);
  const agentName = extractAgentName(agentType);

  return JSON.stringify({
    [agentName]: agentDef,
  });
}

/**
 * Try to load agent definition, returning null if project has no template
 * or the agent file doesn't exist.
 */
export async function tryLoadAgentDefinition(
  projectId: string,
  agentType: string,
): Promise<AgentDefinition | null> {
  try {
    return await loadAgentDefinition(projectId, agentType);
  } catch {
    return null;
  }
}
