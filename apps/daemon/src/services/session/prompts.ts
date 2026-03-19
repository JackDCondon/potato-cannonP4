import fs from "fs/promises";
import path from "path";
import type {
  Ticket,
  TicketImage,
  TicketPhase,
} from "../../types/ticket.types.js";
import type { AgentWorker } from "../../types/template.types.js";
import type { PhaseEntryContext } from "./types.js";
import type { ContinuityDecision } from "./continuity.types.js";
import {
  getArtifactContent,
  listArtifacts,
  getTicketsByBrainstormId,
} from "../../stores/ticket.store.js";
import {
  getRalphFeedbackForLoop,
  getRalphIterations,
  type RalphFeedback,
} from "../../stores/ralph-feedback.store.js";
import { ticketDependencyGetForTicket } from "../../stores/ticket-dependency.store.js";
import { brainstormGetDirect } from "../../stores/brainstorm.store.js";
import { getBrainstormFilesDir } from "../../config/paths.js";

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

export interface ScopeContextDeps {
  getBrainstorm: (brainstormId: string) => { planSummary?: string | null } | null;
  getSiblingTickets: (brainstormId: string) => { id: string; title: string; phase: string; complexity: string }[];
}

const defaultScopeContextDeps: ScopeContextDeps = {
  getBrainstorm: (brainstormId) => brainstormGetDirect(brainstormId),
  getSiblingTickets: (brainstormId) => getTicketsByBrainstormId(brainstormId),
};

export function formatScopeContext(
  ticket: { brainstormId?: string; id: string },
  deps: ScopeContextDeps = defaultScopeContextDeps,
): string {
  if (!ticket.brainstormId) return "";

  const brainstorm = deps.getBrainstorm(ticket.brainstormId);
  if (!brainstorm?.planSummary) return "";

  const siblings = deps.getSiblingTickets(ticket.brainstormId).filter(
    (t) => t.id !== ticket.id,
  );

  if (siblings.length === 0) return "";

  let section = `\n## Scope Context\n\n`;
  section += `**Epic goal:** ${brainstorm.planSummary}\n\n`;

  section += `**Sibling tickets:**\n`;
  section += `| ID | Title | Phase | Complexity |\n`;
  section += `|----|-------|-------|------------|\n`;
  for (const sib of siblings) {
    const safeTitle = sib.title.replace(/\|/g, "\\|");
    const safeComplexity = sib.complexity.replace(/\|/g, "\\|");
    section += `| ${sib.id} | ${safeTitle} | ${sib.phase} | ${safeComplexity} |\n`;
  }

  section += `\nStay in scope — other tickets handle other parts. The \`get_sibling_tickets\` and \`get_dependents\` tools are available if you encounter a specific ambiguity about whether a component falls under your ticket or a sibling's. Don't call them preemptively.\n`;

  return section;
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

function formatPhaseEntryContext(phaseEntryContext?: PhaseEntryContext): string {
  if (!phaseEntryContext) {
    return "";
  }

  const {
    mode,
    taskSummary: {
      totalInPhase,
      actionableInPhase,
      pendingCount,
      inProgressCount,
      failedCount,
      completedCount,
      cancelledCount,
      sampleTasks,
    },
  } = phaseEntryContext;

  const sampleLines = sampleTasks.length
    ? sampleTasks
        .map((task) => `- ${task.id} [${task.status}]: ${task.description}`)
        .join("\n")
    : "- (none)";

  const modeGuidance =
    mode === "re_entry"
      ? "This is a phase re-entry with existing actionable work. Reconcile and continue existing tasks instead of generating duplicate planning artifacts."
      : "This is a fresh phase entry with no actionable tasks yet in this phase.";

  return `
## Phase Entry Context

${modeGuidance}

- entryMode: ${mode}
- totalTasksInPhase: ${totalInPhase}
- actionableTasksInPhase: ${actionableInPhase}
- pending: ${pendingCount}
- in_progress: ${inProgressCount}
- failed: ${failedCount}
- completed: ${completedCount}
- cancelled: ${cancelledCount}

Existing tasks (sample):
${sampleLines}
`;
}

export function formatContinuityHandoff(
  continuityDecision?: ContinuityDecision,
): string {
  if (
    !continuityDecision ||
    continuityDecision.mode !== "handoff" ||
    !continuityDecision.packet
  ) {
    return "";
  }

  const { reason, scope, packet } = continuityDecision;
  const conversationTurnsSection =
    packet.conversationTurns.length > 0
      ? packet.conversationTurns
          .map((turn) => `- [${turn.role}] ${turn.text}`)
          .join("\n")
      : "- (none)";
  const highlightsSection =
    packet.sessionHighlights.length > 0
      ? packet.sessionHighlights.map((item) => `- ${item.summary}`).join("\n")
      : "- (none)";
  const unresolvedQuestionsSection =
    packet.unresolvedQuestions.length > 0
      ? packet.unresolvedQuestions.map((item) => `- ${item}`).join("\n")
      : "- (none)";

  return `## Continuity Handoff

- mode: ${continuityDecision.mode}
- reason: ${reason}
- scope: ${scope ?? packet.scope}

### Conversation Turns
${conversationTurnsSection}

### Session Highlights
${highlightsSection}

### Unresolved Questions
${unresolvedQuestionsSection}`;
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
  },
  phaseEntryContext?: PhaseEntryContext,
  continuityDecision?: ContinuityDecision,
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
${dependencyHint}${formatScopeContext(ticket)}${formatImages(images)}${formatArtifacts(artifacts)}${previousAttemptsSection}${formatPhaseEntryContext(phaseEntryContext)}Begin.`;
  const continuitySection = formatContinuityHandoff(continuityDecision);
  const promptBody = continuitySection
    ? `${continuitySection}\n\n${context}`
    : context;

  // If agent instructions provided, prepend them to the context
  if (agentPrompt) {
    return `${agentPrompt}\n\n---\n\n${promptBody}`;
  }

  return promptBody;
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

/**
 * Build a prompt for a PM (project manager) session on an epic brainstorm.
 * Loads the decisions artifact from disk if available.
 */
export async function buildPmPrompt(
  projectId: string,
  brainstormId: string,
  brainstorm: { name: string; planSummary?: string | null },
  options?: {
    pendingContext?: { question: string; response: string };
  },
): Promise<string> {
  const { pendingContext } = options ?? {};

  // Try to load decisions artifact
  let decisionsContent: string | undefined;
  const decisionsPath = path.join(
    getBrainstormFilesDir(projectId, brainstormId),
    "artifacts",
    "decisions.md",
  );
  try {
    decisionsContent = await fs.readFile(decisionsPath, "utf-8");
  } catch {
    // Not present yet — proceed without it
  }

  let instructions = `You are the Project Manager for this epic. Monitor ticket progress, identify blockers, and coordinate the team.
`;

  if (pendingContext) {
    instructions += `
## Resuming Conversation

The previous session ended before processing the user's response. Here is the context:

**Your last question:** ${pendingContext.question}

**User's response:** ${pendingContext.response}

Continue the conversation from here. Do NOT ask a new opening question.`;
  } else {
    instructions += `
Begin by summarising the current epic status and asking how you can help.`;
  }

  const planSection = brainstorm.planSummary
    ? `\n## Plan Summary\n\n${brainstorm.planSummary}\n`
    : "";

  const decisionsSection = decisionsContent
    ? `\n## Decisions\n\n${decisionsContent}\n`
    : "";

  return `
## Context

**Project:** ${projectId}
**Brainstorm ID:** ${brainstormId}
**Epic Name:** ${brainstorm.name}
**Mode:** Epic Project Manager
${planSection}${decisionsSection}
## Available MCP Commands

- \`chat_ask\` — Ask the user a question (waits for reply)
- \`chat_notify\` — Send a status update
- \`get_epic_status\` — Get a structured snapshot of all epic tickets
- \`create_ticket\` — Create a new ticket
- \`get_ticket\` — Get ticket details

## Instructions

${instructions}`;
}
