import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";
import type { Complexity } from "@potato-cannon/shared";
import type {
  Task,
  TaskStatus,
  TaskComment,
  CreateTaskInput,
} from "../types/task.types.js";

// =============================================================================
// Row Types
// =============================================================================

interface TaskRow {
  id: string;
  ticket_id: string;
  display_number: number;
  phase: string;
  status: string;
  attempt_count: number;
  description: string;
  body: string | null;
  complexity: string;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: string;
  task_id: string;
  text: string;
  created_at: string;
}

// =============================================================================
// Row Mappers
// =============================================================================

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    displayNumber: row.display_number,
    phase: row.phase,
    status: row.status as TaskStatus,
    attemptCount: row.attempt_count,
    description: row.description,
    body: row.body || undefined,
    complexity: row.complexity as Complexity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToComment(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    text: row.text,
    createdAt: row.created_at,
  };
}

// =============================================================================
// TaskStore Class
// =============================================================================

export class TaskStore {
  constructor(private db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // Task CRUD
  // ---------------------------------------------------------------------------

  createTask(ticketId: string, phase: string, input: CreateTaskInput): Task {
    const id = randomUUID();
    const now = new Date().toISOString();
    const complexity: Complexity = input.complexity ?? "standard";

    // Get next display number for this ticket
    const maxRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(display_number), 0) as max_num FROM tasks WHERE ticket_id = ?"
      )
      .get(ticketId) as { max_num: number };
    const displayNumber = maxRow.max_num + 1;

    this.db
      .prepare(
        `INSERT INTO tasks (id, ticket_id, display_number, phase, status, attempt_count, description, body, complexity, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        ticketId,
        displayNumber,
        phase,
        input.description,
        input.body || null,
        complexity,
        now,
        now
      );

    return this.getTask(id)!;
  }

  getTask(taskId: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | undefined;

    return row ? rowToTask(row) : null;
  }

  getTaskByDisplayNumber(ticketId: string, displayNumber: number): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE ticket_id = ? AND display_number = ?"
      )
      .get(ticketId, displayNumber) as TaskRow | undefined;

    return row ? rowToTask(row) : null;
  }

  listTasks(ticketId: string, options?: { phase?: string }): Task[] {
    let sql = "SELECT * FROM tasks WHERE ticket_id = ?";
    const params: (string | number)[] = [ticketId];

    if (options?.phase) {
      sql += " AND phase = ?";
      params.push(options.phase);
    }

    sql += " ORDER BY created_at";

    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    return rows.map(rowToTask);
  }

  listTasksByStatus(ticketId: string, status: TaskStatus): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE ticket_id = ? AND status = ? ORDER BY created_at"
      )
      .all(ticketId, status) as TaskRow[];

    return rows.map(rowToTask);
  }

  updateTask(
    taskId: string,
    updates: { description?: string; body?: string; phase?: string }
  ): Task | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    const now = new Date().toISOString();
    const newDescription = updates.description ?? task.description;
    const newBody =
      updates.body !== undefined ? updates.body : task.body || null;
    const newPhase = updates.phase ?? task.phase;

    this.db
      .prepare(
        "UPDATE tasks SET description = ?, body = ?, phase = ?, updated_at = ? WHERE id = ?"
      )
      .run(newDescription, newBody, newPhase, now, taskId);

    return this.getTask(taskId);
  }

  updateTaskStatus(taskId: string, status: TaskStatus): Task | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    const now = new Date().toISOString();

    // Handle attempt_count logic
    let attemptCount = task.attemptCount;
    if (status === "failed") {
      attemptCount += 1;
    } else if (status === "completed") {
      attemptCount = 0;
    }

    this.db
      .prepare(
        "UPDATE tasks SET status = ?, attempt_count = ?, updated_at = ? WHERE id = ?"
      )
      .run(status, attemptCount, now, taskId);

    return this.getTask(taskId);
  }

  deleteTask(taskId: string): boolean {
    // Comments are deleted automatically via CASCADE
    const result = this.db
      .prepare("DELETE FROM tasks WHERE id = ?")
      .run(taskId);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  addComment(taskId: string, text: string): TaskComment | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        "INSERT INTO task_comments (id, task_id, text, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(id, taskId, text, now);

    return this.getComment(id);
  }

  getComment(commentId: string): TaskComment | null {
    const row = this.db
      .prepare("SELECT * FROM task_comments WHERE id = ?")
      .get(commentId) as CommentRow | undefined;

    return row ? rowToComment(row) : null;
  }

  getComments(taskId: string): TaskComment[] {
    const rows = this.db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as CommentRow[];

    return rows.map(rowToComment);
  }

  /**
   * Delete all tasks for a ticket in the specified phases.
   * Comments are deleted automatically via CASCADE.
   */
  deleteTasksForPhases(ticketId: string, phases: string[]): number {
    if (phases.length === 0) return 0;

    const placeholders = phases.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `DELETE FROM tasks WHERE ticket_id = ? AND phase IN (${placeholders})`
      )
      .run(ticketId, ...phases);
    return result.changes;
  }
}

// =============================================================================
// Factory & Convenience Functions
// =============================================================================

export function createTaskStore(db: Database.Database): TaskStore {
  return new TaskStore(db);
}

// Singleton convenience functions
export function createTask(
  ticketId: string,
  phase: string,
  input: CreateTaskInput
): Task {
  return new TaskStore(getDatabase()).createTask(ticketId, phase, input);
}

export function getTask(taskId: string): Task | null {
  return new TaskStore(getDatabase()).getTask(taskId);
}

export function getTaskByDisplayNumber(
  ticketId: string,
  displayNumber: number
): Task | null {
  return new TaskStore(getDatabase()).getTaskByDisplayNumber(
    ticketId,
    displayNumber
  );
}

export function listTasks(
  ticketId: string,
  options?: { phase?: string }
): Task[] {
  return new TaskStore(getDatabase()).listTasks(ticketId, options);
}

export function updateTaskStatus(
  taskId: string,
  status: TaskStatus
): Task | null {
  return new TaskStore(getDatabase()).updateTaskStatus(taskId, status);
}

export function addTaskComment(taskId: string, text: string): TaskComment | null {
  return new TaskStore(getDatabase()).addComment(taskId, text);
}

export function deleteTask(taskId: string): boolean {
  return new TaskStore(getDatabase()).deleteTask(taskId);
}

export function getTaskComments(taskId: string): TaskComment[] {
  return new TaskStore(getDatabase()).getComments(taskId);
}

export function deleteTasksForPhases(
  ticketId: string,
  phases: string[]
): number {
  return new TaskStore(getDatabase()).deleteTasksForPhases(ticketId, phases);
}
