import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";
import type {
  Conversation,
  ConversationMessage,
  CreateMessageInput,
} from "../types/conversation.types.js";

// =============================================================================
// Row Types
// =============================================================================

interface ConversationRow {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  type: string;
  text: string;
  options: string | null;
  timestamp: string;
  answered_at: string | null;
  metadata: string | null;
}

export interface ConversationContinuityFilter {
  phase?: string;
  executionGeneration?: number;
  agentSource?: string;
}

// =============================================================================
// Row Mappers
// =============================================================================

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.type as ConversationMessage["type"],
    text: row.text,
    options: row.options ? JSON.parse(row.options) : undefined,
    timestamp: row.timestamp,
    answeredAt: row.answered_at || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

// =============================================================================
// ConversationStore Class
// =============================================================================

export class ConversationStore {
  constructor(private db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // Conversation CRUD
  // ---------------------------------------------------------------------------

  createConversation(projectId: string): Conversation {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO conversations (id, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, projectId, now, now);

    return this.getConversation(id)!;
  }

  getConversation(conversationId: string): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(conversationId) as ConversationRow | undefined;

    return row ? rowToConversation(row) : null;
  }

  deleteConversation(conversationId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM conversations WHERE id = ?")
      .run(conversationId);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Message CRUD
  // ---------------------------------------------------------------------------

  addMessage(
    conversationId: string,
    input: CreateMessageInput
  ): ConversationMessage {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO conversation_messages (id, conversation_id, type, text, options, timestamp, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        conversationId,
        input.type,
        input.text,
        input.options ? JSON.stringify(input.options) : null,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null
      );

    // Update conversation's updated_at
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(now, conversationId);

    return this.getMessage(id)!;
  }

  getMessage(messageId: string): ConversationMessage | null {
    const row = this.db
      .prepare("SELECT * FROM conversation_messages WHERE id = ?")
      .get(messageId) as MessageRow | undefined;

    return row ? rowToMessage(row) : null;
  }

  getMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp"
      )
      .all(conversationId) as MessageRow[];

    return rows.map(rowToMessage);
  }

  getMessagesForContinuity(
    conversationId: string,
    filter: ConversationContinuityFilter,
    limit: number
  ): ConversationMessage[] {
    const whereClauses: string[] = ["conversation_id = ?"];
    const params: Array<string | number> = [conversationId];

    if (filter.phase) {
      whereClauses.push("json_extract(metadata, '$.phase') = ?");
      params.push(filter.phase);
    }
    if (filter.executionGeneration !== undefined) {
      whereClauses.push("json_extract(metadata, '$.executionGeneration') = ?");
      params.push(filter.executionGeneration);
    }
    if (filter.agentSource) {
      whereClauses.push("json_extract(metadata, '$.agentSource') = ?");
      params.push(filter.agentSource);
    }

    const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
    params.push(boundedLimit);

    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(...params) as MessageRow[];

    return rows.reverse().map(rowToMessage);
  }

  getPendingQuestion(conversationId: string): ConversationMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE conversation_id = ? AND type = 'question' AND answered_at IS NULL
         ORDER BY timestamp DESC LIMIT 1`
      )
      .get(conversationId) as MessageRow | undefined;

    return row ? rowToMessage(row) : null;
  }

  answerQuestion(messageId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE conversation_messages SET answered_at = ? WHERE id = ?")
      .run(now, messageId);
    return result.changes > 0;
  }

  updateMessageMetadata(
    messageId: string,
    metadata: Record<string, unknown>
  ): boolean {
    // Merge with existing metadata (if any)
    const existing = this.getMessage(messageId);
    if (!existing) return false;

    const merged = { ...(existing.metadata ?? {}), ...metadata };
    const result = this.db
      .prepare("UPDATE conversation_messages SET metadata = ? WHERE id = ?")
      .run(JSON.stringify(merged), messageId);
    return result.changes > 0;
  }
}

// =============================================================================
// Factory & Convenience Functions
// =============================================================================

export function createConversationStore(
  db: Database.Database
): ConversationStore {
  return new ConversationStore(db);
}

// Singleton convenience functions
export function createConversation(projectId: string): Conversation {
  return new ConversationStore(getDatabase()).createConversation(projectId);
}

export function getConversation(conversationId: string): Conversation | null {
  return new ConversationStore(getDatabase()).getConversation(conversationId);
}

export function addMessage(
  conversationId: string,
  input: CreateMessageInput
): ConversationMessage {
  return new ConversationStore(getDatabase()).addMessage(conversationId, input);
}

export function getMessages(conversationId: string): ConversationMessage[] {
  return new ConversationStore(getDatabase()).getMessages(conversationId);
}

export function getMessagesForContinuity(
  conversationId: string,
  filter: ConversationContinuityFilter,
  limit: number
): ConversationMessage[] {
  return new ConversationStore(getDatabase()).getMessagesForContinuity(
    conversationId,
    filter,
    limit
  );
}

export function getPendingQuestion(
  conversationId: string
): ConversationMessage | null {
  return new ConversationStore(getDatabase()).getPendingQuestion(
    conversationId
  );
}

export function answerQuestion(messageId: string): boolean {
  return new ConversationStore(getDatabase()).answerQuestion(messageId);
}

export function updateMessageMetadata(
  messageId: string,
  metadata: Record<string, unknown>
): boolean {
  return new ConversationStore(getDatabase()).updateMessageMetadata(messageId, metadata);
}
