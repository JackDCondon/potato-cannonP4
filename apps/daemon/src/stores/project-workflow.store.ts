import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";

export interface ProjectWorkflow {
  id: string;
  projectId: string;
  name: string;
  templateName: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowInput {
  projectId: string;
  name: string;
  templateName: string;
  isDefault?: boolean;
}

export interface UpdateWorkflowInput {
  name?: string;
  templateName?: string;
  isDefault?: boolean;
}

function rowToWorkflow(row: Record<string, unknown>): ProjectWorkflow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    templateName: row.template_name as string,
    isDefault: (row.is_default as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Store for project_workflows table.
 * Supports multiple independent workflow boards per project.
 */
export class ProjectWorkflowStore {
  constructor(private db: Database.Database) {}

  /**
   * Create a new workflow for a project.
   */
  createWorkflow(input: CreateWorkflowInput): ProjectWorkflow {
    const id = randomUUID();
    const now = new Date().toISOString();
    const isDefault = input.isDefault ?? false;

    this.db
      .prepare(
        `INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.projectId, input.name, input.templateName, isDefault ? 1 : 0, now, now);

    return this.getWorkflow(id)!;
  }

  /**
   * Get a workflow by its ID. Returns null if not found.
   */
  getWorkflow(id: string): ProjectWorkflow | null {
    const row = this.db
      .prepare("SELECT * FROM project_workflows WHERE id = ?")
      .get(id);
    return row ? rowToWorkflow(row as Record<string, unknown>) : null;
  }

  /**
   * List all workflows for a project, ordered by name.
   */
  listWorkflows(projectId: string): ProjectWorkflow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM project_workflows WHERE project_id = ? ORDER BY name"
      )
      .all(projectId);
    return rows.map((row) => rowToWorkflow(row as Record<string, unknown>));
  }

  /**
   * Update a workflow. Returns null if not found.
   */
  updateWorkflow(
    id: string,
    updates: UpdateWorkflowInput
  ): ProjectWorkflow | null {
    const existing = this.getWorkflow(id);
    if (!existing) {
      return null;
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.templateName !== undefined) {
      fields.push("template_name = ?");
      values.push(updates.templateName);
    }
    if (updates.isDefault !== undefined) {
      fields.push("is_default = ?");
      values.push(updates.isDefault ? 1 : 0);
    }

    if (fields.length === 0) {
      return existing;
    }

    fields.push("updated_at = ?");
    values.push(new Date().toISOString());

    values.push(id);
    this.db
      .prepare(`UPDATE project_workflows SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getWorkflow(id);
  }

  /**
   * Delete a workflow by ID. Returns true if deleted, false if not found.
   */
  deleteWorkflow(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM project_workflows WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /**
   * Get the default workflow for a project. Returns null if none is set.
   */
  getDefaultWorkflow(projectId: string): ProjectWorkflow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM project_workflows WHERE project_id = ? AND is_default = 1 LIMIT 1"
      )
      .get(projectId);
    return row ? rowToWorkflow(row as Record<string, unknown>) : null;
  }
}

/**
 * Create a ProjectWorkflowStore with a custom database instance.
 * Useful for testing.
 */
export function createProjectWorkflowStore(
  db: Database.Database
): ProjectWorkflowStore {
  return new ProjectWorkflowStore(db);
}

/**
 * Get a ProjectWorkflowStore using the singleton database.
 */
export function getProjectWorkflowStore(): ProjectWorkflowStore {
  return new ProjectWorkflowStore(getDatabase());
}

// ============================================================================
// Convenience functions that use the singleton database
// Prefixed with "projectWorkflow" to avoid name collisions with template.store
// ============================================================================

export function projectWorkflowCreate(
  input: CreateWorkflowInput
): ProjectWorkflow {
  return getProjectWorkflowStore().createWorkflow(input);
}

export function projectWorkflowGet(id: string): ProjectWorkflow | null {
  return getProjectWorkflowStore().getWorkflow(id);
}

export function projectWorkflowList(projectId: string): ProjectWorkflow[] {
  return getProjectWorkflowStore().listWorkflows(projectId);
}

export function projectWorkflowUpdate(
  id: string,
  updates: UpdateWorkflowInput
): ProjectWorkflow | null {
  return getProjectWorkflowStore().updateWorkflow(id, updates);
}

export function projectWorkflowDelete(id: string): boolean {
  return getProjectWorkflowStore().deleteWorkflow(id);
}

export function projectWorkflowGetDefault(
  projectId: string
): ProjectWorkflow | null {
  return getProjectWorkflowStore().getDefaultWorkflow(projectId);
}
