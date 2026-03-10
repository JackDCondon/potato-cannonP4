import type {
  Ticket,
  TicketImage,
  TicketPhase,
} from "../../types/ticket.types.js";
import type { AgentWorker } from "../../types/template.types.js";
import {
  getArtifactContent,
  listArtifacts,
} from "../../stores/ticket.store.js";
import {
  getRalphFeedbackForLoop,
  getRalphIterations,
  type RalphFeedback,
} from "../../stores/ralph-feedback.store.js";
import { ticketDependencyGetForTicket } from "../../stores/ticket-dependency.store.js";

/**
 * Load context artifacts based on agent's artifact configuration.
 * Supports glob patterns like "architecture-critique-*.md".
 */
async function loadContextArtifacts(
  projectId: string,
  ticketId: string,
  artifactPatterns: string[],
): Promise<{ name: string; content: string }[]> {
  const results: { name: string; content: string }[] = [];

  for (const pattern of artifactPatterns) {
    try {
      if (pattern.includes("*")) {
        // Handle glob pattern - list all artifacts and filter
        const allArtifacts = await listArtifacts(projectId, ticketId);
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        const matchingArtifacts = allArtifacts.filter((a) =>
          regex.test(a.filename),
        );

        for (const artifact of matchingArtifacts) {
          try {
            const content = await getArtifactContent(
              projectId,
              ticketId,
              artifact.filename,
            );
            results.push({ name: artifact.filename, content });
          } catch {
            // Skip artifacts that can't be read
          }
        }
      } else {
        // Direct artifact name
        const content = await getArtifactContent(projectId, ticketId, pattern);
        results.push({ name: pattern, content });
      }
    } catch {
      // Artifact doesn't exist yet, skip it
    }
  }

  return results;
}

/**
 * Format images section for prompt.
 */
function formatImages(images: TicketImage[]): string {
  if (images.length === 0) return "";
  return (
    "\n## Attached Images\n\n" +
    images.map((img) => `- ${img.name}: ${img.path}`).join("\n") +
    "\n"
  );
}

/**
 * Format artifacts section for prompt.
 */
function formatArtifacts(
  artifacts: { name: string; content: string }[],
): string {
  if (artifacts.length === 0) return "";
  return artifacts
    .map(({ name, content }) => `\n## ${name}\n\n${content}`)
    .join("\n");
}

function formatDependencyHint(
  deps: ReturnType<typeof ticketDependencyGetForTicket>,
): string {
  if (deps.length === 0) return "";
  const exampleTitles = deps
    .map((dep) => dep.title)
    .filter(Boolean)
    .slice(0, 2);
  const examples = exampleTitles.length
    ? ` (e.g., '${exampleTitles.join("', '")}')`
    : "";

  return `\nThis ticket has ${deps.length} dependencies${examples}. If you encounter a gap — an interface, contract, or system design you need to understand before proceeding — use get_dependencies() to see what's available. Do not call it preemptively.\n`;
}

/**
 * Format previous rejection attempts for builder prompt injection.
 */
function formatPreviousAttempts(
  feedback: RalphFeedback,
  iterations: import("../../stores/ralph-feedback.store.js").RalphIteration[]
): string {
  if (iterations.length === 0) {
    return "";
  }

  const rejections = iterations.filter((i) => !i.approved);
  if (rejections.length === 0) {
    return "";
  }

  const currentIteration = iterations.length + 1;
  let section = `## Previous Attempts\n\n`;
  section += `This is iteration ${currentIteration} of ${feedback.maxAttempts}. Previous attempts were rejected:\n\n`;

  for (const iter of rejections) {
    section += `### Iteration ${iter.iteration}\n`;
    section += `- Reviewer: ${iter.reviewer}\n`;
    section += `- Feedback: ${iter.feedback}\n\n`;
  }

  return section;
}

/**
 * Build a full prompt for an agent, combining agent instructions with ticket context.
 * Agent instructions are passed directly via --print, not via --agents flag.
 */
export async function buildAgentPrompt(
  projectId: string,
  ticketId: string,
  ticket: Ticket,
  phase: TicketPhase,
  agent: AgentWorker,
  images: TicketImage[],
  agentPrompt?: string,
  ralphContext?: {
    phaseId: string;
    ralphLoopId: string;
    taskId: string | null;
  }
): Promise<string> {
  // AgentWorker doesn't have context.artifacts - this is now handled by agent-loader
  const contextArtifacts: string[] = [];
  const artifacts = await loadContextArtifacts(
    projectId,
    ticketId,
    contextArtifacts,
  );
  const dependencies = ticketDependencyGetForTicket(ticketId);
  const dependencyHint = formatDependencyHint(dependencies);

  // Load ralph feedback if in a ralph loop
  let previousAttemptsSection = "";
  if (ralphContext) {
    const feedback = getRalphFeedbackForLoop(
      ticketId,
      ralphContext.phaseId,
      ralphContext.ralphLoopId,
      ralphContext.taskId || undefined
    );
    if (feedback) {
      const iterations = getRalphIterations(feedback.id);
      previousAttemptsSection = formatPreviousAttempts(feedback, iterations);
    }
  }

  const context = `## Context

**Project:** ${projectId}
**Ticket:** ${ticketId}
**Title:** ${ticket.title}
**Phase:** ${phase}

## Ticket Description

${ticket.description || "No description provided."}
${dependencyHint}${formatImages(images)}${formatArtifacts(artifacts)}${previousAttemptsSection}Begin.`;

  // If agent instructions provided, prepend them to the context
  if (agentPrompt) {
    return `${agentPrompt}\n\n---\n\n${context}`;
  }

  return context;
}

/**
 * Build a prompt for a brainstorm session.
 */
export function buildBrainstormPrompt(
  projectId: string,
  brainstormId: string,
  brainstorm: { name: string },
  options?: {
    pendingContext?: { question: string; response: string };
    initialMessage?: string;
  },
): string {
  const { pendingContext, initialMessage } = options ?? {};

  let instructions = `Help the user explore and refine their idea.
`;

  if (pendingContext) {
    instructions += `## Resuming Conversation

The previous session ended before processing the user's response. Here is the context:

**Your last question:** ${pendingContext.question}

**User's response:** ${pendingContext.response}

Continue the conversation from here. Do NOT ask a new opening question - the user has already responded. Process their answer and continue the brainstorm.`;
  } else if (initialMessage) {
    instructions += `## User's Starting Idea

The user has already shared what they want to brainstorm:

"${initialMessage}"

Acknowledge their idea and ask your first clarifying question. Do NOT ask "what would you like to brainstorm?" - they already told you.`;
  } else {
    instructions += `Begin by asking what they'd like to brainstorm.`;
  }

  return `
## Context

**Project:** ${projectId}
**Brainstorm ID:** ${brainstormId}
**Session Name:** ${brainstorm.name}
**SpudMode:** You are a SuperSpud.

## Instructions

${instructions}`;
}
