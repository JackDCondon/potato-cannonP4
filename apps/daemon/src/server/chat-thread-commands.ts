import type { ChatContext } from "../providers/chat-provider.types.js";
import type { WorkerState } from "../types/orchestration.types.js";

type TicketCommand = "status" | "push" | "push_force";

interface ProjectLike {
  path: string;
}

interface TicketLike {
  id: string;
  title: string;
  phase: string;
  archived?: boolean;
  workflowId?: string | null;
  conversationId?: string | null;
  executionGeneration?: number;
}

interface StoredSessionLike {
  startedAt: string;
  endedAt?: string;
  agentSource?: string;
}

interface LifecycleResult {
  ticket: { id: string; phase: string };
  executionGeneration: number;
}

interface PhaseLike {
  id: string;
  name: string;
  workers?: Array<{ id: string; type: string }>;
}

interface TicketThreadCommandHandlerDeps {
  getTicket: (projectId: string, ticketId: string) => Promise<TicketLike> | TicketLike;
  isTerminalPhase: (phase: string) => boolean;
  getTemplateWithFullPhasesForContext: (
    projectId: string,
    workflowId?: string | null,
  ) => Promise<{ phases: PhaseLike[] } | null>;
  getPhaseConfig: (
    projectId: string,
    phaseName: string,
    workflowId?: string | null,
  ) => Promise<{ workers?: Array<{ id: string; type: string }> } | null>;
  readQuestion: (projectId: string, ticketId: string) => Promise<unknown | null>;
  getActiveSessionForTicket: (ticketId: string) => StoredSessionLike | null;
  getSessionsByTicket: (ticketId: string) => StoredSessionLike[];
  getMessages: (conversationId: string) => Array<{ timestamp: string }>;
  getWorkerState: (projectId: string, ticketId: string) => unknown;
  isActiveWorkerStateRoot: (state: unknown) => boolean;
  sendReply: (
    providerId: string,
    context: ChatContext,
    message: string,
  ) => Promise<void>;
  invalidateTicketLifecycle: (
    projectId: string,
    ticketId: string,
    options: { targetPhase: string; expectedPhase?: string; expectedGeneration?: number },
  ) => Promise<LifecycleResult>;
  spawnForTicket: (
    projectId: string,
    ticketId: string,
    phase: string,
    projectPath: string,
  ) => Promise<unknown>;
  getProjects: () => Map<string, ProjectLike>;
  emitEvent: (event: string, payload: unknown) => void;
}

function normalizeCommand(input: string): string {
  return input.trim().toLowerCase();
}

export function parseTicketThreadCommand(input: string): TicketCommand | null {
  const command = normalizeCommand(input);
  if (command === "status") return "status";
  if (command === "push") return "push";
  if (command === "push!") return "push_force";
  return null;
}

function toIsoMax(
  current: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!next) return current;
  if (!current) return next;
  return next > current ? next : current;
}

function getWorkerIdFromState(state: WorkerState | null): string | undefined {
  if (!state) return undefined;
  if (state.type === "agent") {
    return state.id;
  }
  if (state.type === "ralphLoop") {
    return getWorkerIdFromState(state.activeWorker) ?? state.id;
  }
  if (state.type === "taskLoop") {
    return getWorkerIdFromState(state.activeWorker) ?? state.id;
  }
  return undefined;
}

async function buildStatusMessage(
  context: ChatContext,
  ticket: TicketLike,
  deps: TicketThreadCommandHandlerDeps,
): Promise<string> {
  const activeSession = deps.getActiveSessionForTicket(ticket.id);

  let assignedWorker = activeSession?.agentSource ?? "none";
  if (!activeSession) {
    const rawState = deps.getWorkerState(context.projectId, ticket.id);
    if (deps.isActiveWorkerStateRoot(rawState)) {
      const state = rawState as { activeWorker?: WorkerState | null };
      assignedWorker = getWorkerIdFromState(state.activeWorker ?? null) ?? assignedWorker;
    }
  }

  let lastActivity: string | undefined;
  if (ticket.conversationId) {
    const conversationMessages = deps.getMessages(ticket.conversationId);
    for (const message of conversationMessages) {
      lastActivity = toIsoMax(lastActivity, message.timestamp);
    }
  }
  const sessions = deps.getSessionsByTicket(ticket.id);
  for (const session of sessions) {
    lastActivity = toIsoMax(lastActivity, session.endedAt ?? session.startedAt);
  }

  return [
    `Status: ${ticket.id} "${ticket.title}"`,
    `Lane: ${ticket.phase}`,
    `Assigned worker: ${assignedWorker}`,
    `Active session: ${activeSession ? "yes" : "no"}`,
    `Last activity: ${lastActivity ?? "unknown"}`,
  ].join(" | ");
}

export function createTicketThreadCommandHandler(
  deps: TicketThreadCommandHandlerDeps,
): (
  providerId: string,
  context: ChatContext,
  input: string,
) => Promise<boolean> {
  return async (
    providerId: string,
    context: ChatContext,
    input: string,
  ): Promise<boolean> => {
    const command = parseTicketThreadCommand(input);
    if (!command || !context.ticketId) {
      return false;
    }

    let ticket: TicketLike;
    try {
      ticket = await deps.getTicket(context.projectId, context.ticketId);
    } catch {
      await deps.sendReply(
        providerId,
        context,
        `Command unavailable: ticket ${context.ticketId} was not found.`,
      );
      return true;
    }

    if (command === "status") {
      const message = await buildStatusMessage(context, ticket, deps);
      await deps.sendReply(providerId, context, message);
      return true;
    }

    const pendingQuestion = await deps.readQuestion(context.projectId, context.ticketId);
    if (pendingQuestion && command === "push") {
      await deps.sendReply(
        providerId,
        context,
        "Push blocked: this ticket has a pending question. Reply to it first or use push! if intentional.",
      );
      return true;
    }

    if (ticket.archived) {
      await deps.sendReply(providerId, context, "Push blocked: ticket is archived.");
      return true;
    }

    if (deps.isTerminalPhase(ticket.phase)) {
      await deps.sendReply(
        providerId,
        context,
        `Push blocked: ${ticket.phase} is terminal.`,
      );
      return true;
    }

    const template = await deps.getTemplateWithFullPhasesForContext(
      context.projectId,
      ticket.workflowId,
    );
    if (!template || template.phases.length === 0) {
      await deps.sendReply(providerId, context, "Push blocked: could not resolve swimlanes.");
      return true;
    }

    const currentIndex = template.phases.findIndex(
      (phase) => phase.id === ticket.phase || phase.name === ticket.phase,
    );
    if (currentIndex === -1 || currentIndex >= template.phases.length - 1) {
      await deps.sendReply(
        providerId,
        context,
        "Push blocked: there is no swimlane to the right.",
      );
      return true;
    }

    const currentPhaseConfig = await deps.getPhaseConfig(
      context.projectId,
      ticket.phase,
      ticket.workflowId,
    );
    const isHoldingSwimlane = !currentPhaseConfig?.workers || currentPhaseConfig.workers.length === 0;
    if (!isHoldingSwimlane && command === "push") {
      await deps.sendReply(
        providerId,
        context,
        `Push blocked: ${ticket.phase} is not a holding swimlane. Use push! to force.`,
      );
      return true;
    }

    const nextPhase = template.phases[currentIndex + 1];
    const targetPhase = nextPhase.name || nextPhase.id;

    try {
      const lifecycle = await deps.invalidateTicketLifecycle(
        context.projectId,
        ticket.id,
        {
          targetPhase,
          expectedPhase: ticket.phase,
          expectedGeneration: ticket.executionGeneration ?? 0,
        },
      );

      deps.emitEvent("ticket:updated", {
        projectId: context.projectId,
        ticket: lifecycle.ticket,
      });
      deps.emitEvent("ticket:moved", {
        projectId: context.projectId,
        ticketId: ticket.id,
        from: ticket.phase,
        to: targetPhase,
      });

      const nextPhaseConfig = await deps.getPhaseConfig(
        context.projectId,
        targetPhase,
        ticket.workflowId,
      );
      const hasAutomation = !!nextPhaseConfig?.workers?.length;
      if (hasAutomation) {
        const project = deps.getProjects().get(context.projectId);
        if (project) {
          await deps.spawnForTicket(
            context.projectId,
            ticket.id,
            targetPhase,
            project.path,
          );
        }
      }

      await deps.sendReply(
        providerId,
        context,
        `Pushed ${ticket.id}: ${ticket.phase} -> ${targetPhase}`,
      );
    } catch (error) {
      await deps.sendReply(
        providerId,
        context,
        `Push blocked: ${(error as Error).message}`,
      );
    }

    return true;
  };
}
