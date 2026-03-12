import { eventBus } from "../utils/event-bus.js";
import { deleteTicket } from "../stores/ticket.store.js";
import { chatService } from "./chat.service.js";
import type { SessionService } from "./session/index.js";

export interface TicketDeletionLifecycleReport {
  sessionStopped: boolean;
  queueCancelled: number;
  routesRemoved: number;
  threadDeletesAttempted: number;
  threadDeleteErrors: string[];
}

interface DeleteTicketWithLifecycleOptions {
  sessionService: Pick<SessionService, "terminateTicketSession">;
  emitEvent?: boolean;
}

export async function deleteTicketWithLifecycle(
  projectId: string,
  ticketId: string,
  options: DeleteTicketWithLifecycleOptions,
): Promise<TicketDeletionLifecycleReport> {
  let sessionStopped = false;
  const threadDeleteErrors: string[] = [];

  try {
    sessionStopped = await options.sessionService.terminateTicketSession(ticketId);
  } catch (error) {
    threadDeleteErrors.push(
      `session:${error instanceof Error ? error.message : String(error)}`
    );
  }

  const cleanup = await chatService.cleanupTicketLifecycle(projectId, ticketId);
  threadDeleteErrors.push(...cleanup.threadDeleteErrors);

  await deleteTicket(projectId, ticketId);

  const report: TicketDeletionLifecycleReport = {
    sessionStopped,
    queueCancelled: cleanup.queueCancelled,
    routesRemoved: cleanup.routesRemoved,
    threadDeletesAttempted: cleanup.threadDeletesAttempted,
    threadDeleteErrors,
  };

  if (options.emitEvent !== false) {
    eventBus.emit("ticket:deleted", { projectId, ticketId, cleanup: report });
  }

  return report;
}
