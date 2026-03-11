import type Database from "better-sqlite3";
import type { Express, Request, Response } from "express";
import { getDatabase } from "../../stores/db.js";

export interface ChatTelemetrySnapshot {
  queueDepth: number;
  activeQuestion: {
    id: string;
    questionId?: string;
    projectId: string;
    ticketId?: string;
    ageSeconds: number;
  } | null;
  providerEventCounts: Array<{
    providerId: string;
    eventType: string;
    count: number;
  }>;
  perTicketQueueDepth: Array<{
    projectId: string;
    ticketId: string;
    count: number;
  }>;
  deadLetterCount: number;
}

export function getChatTelemetrySnapshot(
  db: Database.Database = getDatabase(),
  now = new Date(),
): ChatTelemetrySnapshot {
  const queueDepthRow = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM chat_queue_items
       WHERE status IN ('queued', 'dispatching', 'awaiting_reply')`
    )
    .get() as { count: number };

  const activeQuestionRow = db
    .prepare(
      `SELECT id, question_id, project_id, ticket_id, created_at
       FROM chat_queue_items
       WHERE kind = 'question' AND status = 'awaiting_reply'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get() as
    | {
        id: string;
        question_id: string | null;
        project_id: string;
        ticket_id: string | null;
        created_at: string;
      }
    | undefined;

  const providerEventCounts = db
    .prepare(
      `SELECT provider_id, event_type, COUNT(*) as count
       FROM chat_delivery_events
       GROUP BY provider_id, event_type
       ORDER BY provider_id, event_type`
    )
    .all() as Array<{
    provider_id: string;
    event_type: string;
    count: number;
  }>;

  const perTicketQueueDepth = db
    .prepare(
      `SELECT project_id, ticket_id, COUNT(*) as count
       FROM chat_queue_items
       WHERE ticket_id IS NOT NULL AND status IN ('queued', 'dispatching', 'awaiting_reply')
       GROUP BY project_id, ticket_id
       ORDER BY project_id, ticket_id`
    )
    .all() as Array<{
    project_id: string;
    ticket_id: string;
    count: number;
  }>;

  const deadLetterCountRow = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM chat_queue_items
       WHERE status = 'dead_letter'`
    )
    .get() as { count: number };

  const activeQuestion = activeQuestionRow
    ? {
        id: activeQuestionRow.id,
        questionId: activeQuestionRow.question_id ?? undefined,
        projectId: activeQuestionRow.project_id,
        ticketId: activeQuestionRow.ticket_id ?? undefined,
        ageSeconds: Math.max(
          0,
          Math.floor(
            (now.getTime() - new Date(activeQuestionRow.created_at).getTime()) /
              1000,
          ),
        ),
      }
    : null;

  return {
    queueDepth: queueDepthRow.count,
    activeQuestion,
    providerEventCounts: providerEventCounts.map((row) => ({
      providerId: row.provider_id,
      eventType: row.event_type,
      count: row.count,
    })),
    perTicketQueueDepth: perTicketQueueDepth.map((row) => ({
      projectId: row.project_id,
      ticketId: row.ticket_id,
      count: row.count,
    })),
    deadLetterCount: deadLetterCountRow.count,
  };
}

export function registerChatTelemetryRoutes(app: Express): void {
  app.get("/api/chat/telemetry", (_req: Request, res: Response) => {
    try {
      res.json(getChatTelemetrySnapshot());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
}
