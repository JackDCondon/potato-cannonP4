import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";

export type ChatQueueItemKind = "question" | "notification";

export type ChatQueueItemStatus =
  | "queued"
  | "dispatching"
  | "awaiting_reply"
  | "answered"
  | "cancelled"
  | "stale"
  | "timed_out"
  | "failed"
  | "dead_letter";

export type ChatResolvedBy = "web" | "telegram" | "slack" | "system";

export type ChatDeliveryEventType =
  | "sent"
  | "failed"
  | "retried"
  | "dead_letter"
  | "answered"
  | "cancelled";

export interface ChatQueueItem {
  id: string;
  projectId: string;
  ticketId?: string;
  brainstormId?: string;
  kind: ChatQueueItemKind;
  questionId?: string;
  providerScope: string;
  payload: Record<string, unknown>;
  status: ChatQueueItemStatus;
  retryCount: number;
  availableAt: string;
  createdAt: string;
  sentAt?: string;
  resolvedAt?: string;
  resolvedBy?: ChatResolvedBy;
}

export interface ChatDeliveryEvent {
  id: string;
  queueItemId: string;
  projectId: string;
  ticketId?: string;
  providerId: string;
  eventType: ChatDeliveryEventType;
  attempt: number;
  errorText?: string;
  createdAt: string;
}

export interface EnqueueQuestionInput {
  projectId: string;
  ticketId?: string;
  brainstormId?: string;
  questionId: string;
  payload: Record<string, unknown>;
  providerScope?: string;
  availableAt?: string;
}

export interface EnqueueNotificationInput {
  projectId: string;
  ticketId?: string;
  brainstormId?: string;
  payload: Record<string, unknown>;
  providerScope?: string;
  availableAt?: string;
}

export interface RecordDeliveryEventInput {
  queueItemId: string;
  projectId: string;
  ticketId?: string;
  providerId: string;
  eventType: ChatDeliveryEventType;
  attempt?: number;
  errorText?: string;
}

interface QueueItemRow {
  id: string;
  project_id: string;
  ticket_id: string | null;
  brainstorm_id: string | null;
  kind: ChatQueueItemKind;
  question_id: string | null;
  provider_scope: string;
  payload_json: string;
  status: ChatQueueItemStatus;
  retry_count: number;
  available_at: string;
  created_at: string;
  sent_at: string | null;
  resolved_at: string | null;
  resolved_by: ChatResolvedBy | null;
}

interface DeliveryEventRow {
  id: string;
  queue_item_id: string;
  project_id: string;
  ticket_id: string | null;
  provider_id: string;
  event_type: ChatDeliveryEventType;
  attempt: number;
  error_text: string | null;
  created_at: string;
}

function rowToQueueItem(row: QueueItemRow): ChatQueueItem {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id ?? undefined,
    brainstormId: row.brainstorm_id ?? undefined,
    kind: row.kind,
    questionId: row.question_id ?? undefined,
    providerScope: row.provider_scope,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    retryCount: row.retry_count,
    availableAt: row.available_at,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
  };
}

function rowToDeliveryEvent(row: DeliveryEventRow): ChatDeliveryEvent {
  return {
    id: row.id,
    queueItemId: row.queue_item_id,
    projectId: row.project_id,
    ticketId: row.ticket_id ?? undefined,
    providerId: row.provider_id,
    eventType: row.event_type,
    attempt: row.attempt,
    errorText: row.error_text ?? undefined,
    createdAt: row.created_at,
  };
}

export class ChatQueueStore {
  constructor(private db: Database.Database) {}

  enqueueQuestion(input: EnqueueQuestionInput): ChatQueueItem {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO chat_queue_items
         (id, project_id, ticket_id, brainstorm_id, kind, question_id, provider_scope, payload_json, status, available_at, created_at)
         VALUES (?, ?, ?, ?, 'question', ?, ?, ?, 'queued', ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.ticketId ?? null,
        input.brainstormId ?? null,
        input.questionId,
        input.providerScope ?? "all_active",
        JSON.stringify(input.payload),
        input.availableAt ?? now,
        now
      );

    return this.getQueueItem(id)!;
  }

  enqueueNotification(input: EnqueueNotificationInput): ChatQueueItem {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO chat_queue_items
         (id, project_id, ticket_id, brainstorm_id, kind, provider_scope, payload_json, status, available_at, created_at)
         VALUES (?, ?, ?, ?, 'notification', ?, ?, 'queued', ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.ticketId ?? null,
        input.brainstormId ?? null,
        input.providerScope ?? "all_active",
        JSON.stringify(input.payload),
        input.availableAt ?? now,
        now
      );

    return this.getQueueItem(id)!;
  }

  getQueueItem(id: string): ChatQueueItem | null {
    const row = this.db
      .prepare("SELECT * FROM chat_queue_items WHERE id = ?")
      .get(id) as QueueItemRow | undefined;
    return row ? rowToQueueItem(row) : null;
  }

  getQueueItemByQuestionId(questionId: string): ChatQueueItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM chat_queue_items
         WHERE question_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(questionId) as QueueItemRow | undefined;
    return row ? rowToQueueItem(row) : null;
  }

  getActiveQuestion(): ChatQueueItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM chat_queue_items
         WHERE kind = 'question' AND status = 'awaiting_reply'
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get() as QueueItemRow | undefined;

    return row ? rowToQueueItem(row) : null;
  }

  listReadyQueueItems(limit = 10, atTime?: string): ChatQueueItem[] {
    const now = atTime ?? new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_queue_items
         WHERE status = 'queued' AND available_at <= ?
         ORDER BY available_at ASC, created_at ASC
         LIMIT ?`
      )
      .all(now, limit) as QueueItemRow[];

    return rows.map(rowToQueueItem);
  }

  listOpenQueueItems(filters?: {
    projectId?: string;
    ticketId?: string;
    limit?: number;
  }): ChatQueueItem[] {
    const where: string[] = ["status IN ('queued', 'dispatching', 'awaiting_reply')"];
    const params: unknown[] = [];

    if (filters?.projectId) {
      where.push("project_id = ?");
      params.push(filters.projectId);
    }

    if (filters?.ticketId) {
      where.push("ticket_id = ?");
      params.push(filters.ticketId);
    }

    const limit = filters?.limit ?? 500;
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_queue_items
         WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(...params, limit) as QueueItemRow[];

    return rows.map(rowToQueueItem);
  }

  markDispatching(id: string): ChatQueueItem | null {
    return this.updateStatus(id, "dispatching");
  }

  markAwaitingReply(id: string): ChatQueueItem | null {
    return this.updateStatus(id, "awaiting_reply", {
      setSentAtNow: true,
    });
  }

  markAnswered(id: string, resolvedBy: ChatResolvedBy): ChatQueueItem | null {
    return this.updateStatus(id, "answered", {
      resolvedBy,
      setResolvedAtNow: true,
    });
  }

  markCancelled(id: string, resolvedBy: ChatResolvedBy = "system"): ChatQueueItem | null {
    return this.updateStatus(id, "cancelled", {
      resolvedBy,
      setResolvedAtNow: true,
    });
  }

  markTimedOut(id: string, resolvedBy: ChatResolvedBy = "system"): ChatQueueItem | null {
    return this.updateStatus(id, "timed_out", {
      resolvedBy,
      setResolvedAtNow: true,
    });
  }

  markDeadLetter(id: string, resolvedBy: ChatResolvedBy = "system"): ChatQueueItem | null {
    return this.updateStatus(id, "dead_letter", {
      resolvedBy,
      setResolvedAtNow: true,
    });
  }

  cancelQueuedItemsForQuestionId(
    questionId: string,
    resolvedBy: ChatResolvedBy = "system"
  ): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE chat_queue_items
         SET status = 'cancelled', resolved_at = ?, resolved_by = ?
         WHERE question_id = ? AND status IN ('queued', 'dispatching')`
      )
      .run(now, resolvedBy, questionId);

    return result.changes;
  }

  cancelOpenItemsForTicket(
    projectId: string,
    ticketId: string,
    resolvedBy: ChatResolvedBy = "system"
  ): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE chat_queue_items
         SET status = 'cancelled', resolved_at = ?, resolved_by = ?
         WHERE project_id = ? AND ticket_id = ?
           AND status IN ('queued', 'dispatching', 'awaiting_reply')`
      )
      .run(now, resolvedBy, projectId, ticketId);
    return result.changes;
  }

  recordDeliveryEvent(input: RecordDeliveryEventInput): ChatDeliveryEvent {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO chat_delivery_events
         (id, queue_item_id, project_id, ticket_id, provider_id, event_type, attempt, error_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.queueItemId,
        input.projectId,
        input.ticketId ?? null,
        input.providerId,
        input.eventType,
        input.attempt ?? 1,
        input.errorText ?? null,
        now
      );

    const row = this.db
      .prepare("SELECT * FROM chat_delivery_events WHERE id = ?")
      .get(id) as DeliveryEventRow | undefined;
    if (!row) {
      throw new Error(`Failed to read chat delivery event ${id} after insert`);
    }
    return rowToDeliveryEvent(row);
  }

  private updateStatus(
    id: string,
    status: ChatQueueItemStatus,
    options?: {
      resolvedBy?: ChatResolvedBy;
      setSentAtNow?: boolean;
      setResolvedAtNow?: boolean;
    }
  ): ChatQueueItem | null {
    const now = new Date().toISOString();
    const clauses: string[] = ["status = ?"];
    const params: unknown[] = [status];

    if (options?.setSentAtNow) {
      clauses.push("sent_at = COALESCE(sent_at, ?)");
      params.push(now);
    }

    if (options?.setResolvedAtNow) {
      clauses.push("resolved_at = ?");
      params.push(now);
    }

    if (options?.resolvedBy) {
      clauses.push("resolved_by = ?");
      params.push(options.resolvedBy);
    }

    params.push(id);
    this.db
      .prepare(`UPDATE chat_queue_items SET ${clauses.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getQueueItem(id);
  }
}

export function createChatQueueStore(db: Database.Database): ChatQueueStore {
  return new ChatQueueStore(db);
}

export function enqueueQuestion(input: EnqueueQuestionInput): ChatQueueItem {
  return new ChatQueueStore(getDatabase()).enqueueQuestion(input);
}

export function enqueueNotification(
  input: EnqueueNotificationInput
): ChatQueueItem {
  return new ChatQueueStore(getDatabase()).enqueueNotification(input);
}

export function getActiveQuestion(): ChatQueueItem | null {
  return new ChatQueueStore(getDatabase()).getActiveQuestion();
}

export function listReadyQueueItems(limit = 10, atTime?: string): ChatQueueItem[] {
  return new ChatQueueStore(getDatabase()).listReadyQueueItems(limit, atTime);
}

export function listOpenQueueItems(filters?: {
  projectId?: string;
  ticketId?: string;
  limit?: number;
}): ChatQueueItem[] {
  return new ChatQueueStore(getDatabase()).listOpenQueueItems(filters);
}
