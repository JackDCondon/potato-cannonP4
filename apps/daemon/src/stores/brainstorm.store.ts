import type Database from "better-sqlite3";
import type { Brainstorm, BrainstormStatus } from "@potato-cannon/shared";
import { getDatabase } from "./db.js";
import {
  createConversationStore,
  ConversationStore,
} from "./conversation.store.js";

// =============================================================================
// Types
// =============================================================================

// Re-export Brainstorm from shared
export type { Brainstorm };

export interface CreateBrainstormInput {
  name?: string;
  workflowId?: string;
}

export interface UpdateBrainstormInput {
  name?: string;
  status?: BrainstormStatus;
  createdTicketId?: string;
  planSummary?: string;
  pmEnabled?: boolean;
}

// =============================================================================
// Row Types
// =============================================================================

interface BrainstormRow {
  id: string;
  project_id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  conversation_id: string | null;
  created_ticket_id: string | null;
  workflow_id: string | null;
  plan_summary: string | null;
  pm_enabled: number;
}

// =============================================================================
// Row Mappers
// =============================================================================

function rowToBrainstorm(row: BrainstormRow): Brainstorm {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    status: row.status as Brainstorm["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conversationId: row.conversation_id,
    createdTicketId: row.created_ticket_id,
    workflowId: row.workflow_id,
    planSummary: row.plan_summary ?? undefined,
    pmEnabled: row.pm_enabled === 1,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function generateBrainstormId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `brain_${timestamp}_${random}`;
}

function generateBrainstormName(): string {
  const now = new Date();
  return `Brainstorm ${now.toLocaleDateString()} ${now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

// =============================================================================
// BrainstormStore Class
// =============================================================================

export class BrainstormStore {
  private conversationStore: ConversationStore;

  constructor(private db: Database.Database) {
    this.conversationStore = createConversationStore(db);
  }

  // ---------------------------------------------------------------------------
  // Brainstorm CRUD
  // ---------------------------------------------------------------------------

  createBrainstorm(
    projectId: string,
    input: CreateBrainstormInput = {}
  ): Brainstorm {
    const id = generateBrainstormId();
    const now = new Date().toISOString();
    const name = input.name || generateBrainstormName();

    // Create associated conversation
    const conversation = this.conversationStore.createConversation(projectId);

    this.db
      .prepare(
        `INSERT INTO brainstorms (id, project_id, name, status, created_at, updated_at, conversation_id, workflow_id)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(id, projectId, name, now, now, conversation.id, input.workflowId ?? null);

    return this.getBrainstorm(id)!;
  }

  getBrainstorm(brainstormId: string): Brainstorm | null {
    const row = this.db
      .prepare("SELECT * FROM brainstorms WHERE id = ?")
      .get(brainstormId) as BrainstormRow | undefined;

    return row ? rowToBrainstorm(row) : null;
  }

  getBrainstormByProject(
    projectId: string,
    brainstormId: string
  ): Brainstorm | null {
    const row = this.db
      .prepare("SELECT * FROM brainstorms WHERE id = ? AND project_id = ?")
      .get(brainstormId, projectId) as BrainstormRow | undefined;

    return row ? rowToBrainstorm(row) : null;
  }

  listBrainstorms(projectId: string): Brainstorm[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM brainstorms WHERE project_id = ? ORDER BY updated_at DESC"
      )
      .all(projectId) as BrainstormRow[];

    return rows.map(rowToBrainstorm);
  }

  updateBrainstorm(
    brainstormId: string,
    updates: UpdateBrainstormInput
  ): Brainstorm | null {
    const existing = this.getBrainstorm(brainstormId);
    if (!existing) return null;

    const now = new Date().toISOString();
    const fields: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }

    if (updates.createdTicketId !== undefined) {
      fields.push("created_ticket_id = ?");
      values.push(updates.createdTicketId);
    }

    if (updates.planSummary !== undefined) {
      fields.push("plan_summary = ?");
      values.push(updates.planSummary);
    }

    if (updates.pmEnabled !== undefined) {
      fields.push("pm_enabled = ?");
      values.push(updates.pmEnabled ? 1 : 0);
    }

    values.push(brainstormId);
    this.db
      .prepare(`UPDATE brainstorms SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getBrainstorm(brainstormId);
  }

  deleteBrainstorm(brainstormId: string): boolean {
    // Manually null out brainstorm_id on linked tickets — PRAGMA foreign_keys is OFF
    // so ON DELETE SET NULL won't fire automatically.
    this.db
      .prepare("UPDATE tickets SET brainstorm_id = NULL WHERE brainstorm_id = ?")
      .run(brainstormId);
    const result = this.db
      .prepare("DELETE FROM brainstorms WHERE id = ?")
      .run(brainstormId);
    return result.changes > 0;
  }

  getTicketCountsForBrainstorm(brainstormId: string): { ticketCount: number; activeTicketCount: number } {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN phase != 'Done' AND archived = 0 THEN 1 ELSE 0 END) as active
        FROM tickets WHERE brainstorm_id = ?`
      )
      .get(brainstormId) as { total: number; active: number };
    return { ticketCount: row.total, activeTicketCount: row.active ?? 0 };
  }

  getTicketCountsBatch(brainstormIds: string[]): Map<string, { ticketCount: number; activeTicketCount: number }> {
    const result = new Map<string, { ticketCount: number; activeTicketCount: number }>();
    if (brainstormIds.length === 0) return result;

    const placeholders = brainstormIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT
          brainstorm_id,
          COUNT(*) as total,
          SUM(CASE WHEN phase != 'Done' AND archived = 0 THEN 1 ELSE 0 END) as active
        FROM tickets
        WHERE brainstorm_id IN (${placeholders})
        GROUP BY brainstorm_id`
      )
      .all(...brainstormIds) as { brainstorm_id: string; total: number; active: number }[];

    for (const row of rows) {
      result.set(row.brainstorm_id, { ticketCount: row.total, activeTicketCount: row.active ?? 0 });
    }
    return result;
  }
}

// =============================================================================
// Factory & Convenience Functions
// =============================================================================

export function createBrainstormStore(db: Database.Database): BrainstormStore {
  return new BrainstormStore(db);
}

// Singleton convenience functions (async for API compatibility)
export async function listBrainstorms(projectId: string): Promise<Brainstorm[]> {
  return new BrainstormStore(getDatabase()).listBrainstorms(projectId);
}

export async function getBrainstorm(
  projectId: string,
  brainstormId: string
): Promise<Brainstorm> {
  const store = new BrainstormStore(getDatabase());
  const brainstorm = store.getBrainstormByProject(projectId, brainstormId);
  if (!brainstorm) {
    throw new Error(`Brainstorm ${brainstormId} not found`);
  }
  return brainstorm;
}

export async function createBrainstorm(
  projectId: string,
  options: CreateBrainstormInput = {}
): Promise<Brainstorm> {
  return new BrainstormStore(getDatabase()).createBrainstorm(projectId, options);
}

export async function updateBrainstorm(
  projectId: string,
  brainstormId: string,
  updates: UpdateBrainstormInput
): Promise<Brainstorm> {
  const store = new BrainstormStore(getDatabase());

  // Verify it belongs to the project
  const existing = store.getBrainstormByProject(projectId, brainstormId);
  if (!existing) {
    throw new Error(`Brainstorm ${brainstormId} not found`);
  }

  const updated = store.updateBrainstorm(brainstormId, updates);
  if (!updated) {
    throw new Error(`Failed to update brainstorm ${brainstormId}`);
  }
  return updated;
}

export async function deleteBrainstorm(
  projectId: string,
  brainstormId: string
): Promise<void> {
  const store = new BrainstormStore(getDatabase());

  // Verify it belongs to the project
  const existing = store.getBrainstormByProject(projectId, brainstormId);
  if (!existing) {
    throw new Error(`Brainstorm ${brainstormId} not found`);
  }

  store.deleteBrainstorm(brainstormId);
}

export function brainstormGetDirect(brainstormId: string): Brainstorm | null {
  return new BrainstormStore(getDatabase()).getBrainstorm(brainstormId);
}

export function brainstormGetTicketCounts(brainstormId: string): { ticketCount: number; activeTicketCount: number } {
  return new BrainstormStore(getDatabase()).getTicketCountsForBrainstorm(brainstormId);
}

export function brainstormGetTicketCountsBatch(brainstormIds: string[]): Map<string, { ticketCount: number; activeTicketCount: number }> {
  return new BrainstormStore(getDatabase()).getTicketCountsBatch(brainstormIds);
}
