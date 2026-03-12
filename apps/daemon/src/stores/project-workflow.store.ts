import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";

export interface ProjectWorkflow {
  id: string;
  projectId: string;
  name: string;
  templateName: string;
  templateVersion: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowInput {
  projectId: string;
  name: string;
  templateName: string;
  templateVersion?: string;
  isDefault?: boolean;
}

export interface UpdateWorkflowInput {
  name?: string;
  templateName?: string;
  templateVersion?: string;
  isDefault?: boolean;
}

export interface WorkflowDeletePreview {
  ticketCount: number;
  sampleTicketIds: string[];
}

function rowToWorkflow(row: Record<string, unknown>): ProjectWorkflow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    templateName: row.template_name as string,
    templateVersion: (row.template_version as string) || "1.0.0",
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

  private resolveTemplateVersion(templateName: string): string {
    const row = this.db
      .prepare("SELECT version FROM templates WHERE name = ? LIMIT 1")
      .get(templateName) as { version: string } | undefined;
    if (!row?.version) {
      return "1.0.0";
    }
    return row.version;
  }

  /**
   * Create a new workflow for a project.
   * If isDefault is true, clears any existing default for the project first.
   */
  createWorkflow(input: CreateWorkflowInput): ProjectWorkflow {
    const id = randomUUID();
    const now = new Date().toISOString();
    const isDefault = input.isDefault ?? false;
    const templateVersion =
      input.templateVersion ?? this.resolveTemplateVersion(input.templateName);

    const insert = this.db.prepare(
      `INSERT INTO project_workflows (id, project_id, name, template_name, template_version, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const clearDefaults = this.db.prepare(
      `UPDATE project_workflows SET is_default = 0 WHERE project_id = ?`
    );

    const run = this.db.transaction(() => {
      if (isDefault) {
        clearDefaults.run(input.projectId);
      }
      insert.run(
        id,
        input.projectId,
        input.name,
        input.templateName,
        templateVersion,
        isDefault ? 1 : 0,
        now,
        now
      );
    });
    run();

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

      if (updates.templateVersion === undefined) {
        fields.push("template_version = ?");
        values.push(this.resolveTemplateVersion(updates.templateName));
      }
    }
    if (updates.templateVersion !== undefined) {
      fields.push("template_version = ?");
      values.push(updates.templateVersion);
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

    const updateStmt = this.db.prepare(
      `UPDATE project_workflows SET ${fields.join(", ")} WHERE id = ?`
    );

    if (updates.isDefault === true) {
      const clearDefaults = this.db.prepare(
        `UPDATE project_workflows SET is_default = 0 WHERE project_id = ? AND id != ?`
      );
      const run = this.db.transaction(() => {
        clearDefaults.run(existing.projectId, id);
        updateStmt.run(...values);
      });
      run();
    } else {
      updateStmt.run(...values);
    }

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
   * Delete all workflows for a project. Returns number of rows deleted.
   */
  deleteWorkflowsForProject(projectId: string): number {
    const result = this.db
      .prepare("DELETE FROM project_workflows WHERE project_id = ?")
      .run(projectId);
    return result.changes;
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

  /**
   * Ensure a project has a default workflow and return it.
   * Resolution order:
   * 1) Existing default workflow
   * 2) Promote first existing workflow to default
   * 3) Create "Default" workflow using preferred template or project's template_name
   */
  ensureDefaultWorkflow(projectId: string, preferredTemplateName?: string): ProjectWorkflow {
    const existingDefault = this.getDefaultWorkflow(projectId);
    if (existingDefault) {
      return existingDefault;
    }

    const existing = this.listWorkflows(projectId);
    if (existing.length > 0) {
      const promoted = this.updateWorkflow(existing[0].id, { isDefault: true });
      if (!promoted) {
        throw new Error(
          `Failed to promote an existing workflow as default for project ${projectId}`
        );
      }
      return promoted;
    }

    const project = this.db
      .prepare("SELECT template_name FROM projects WHERE id = ?")
      .get(projectId) as { template_name: string | null } | undefined;

    const resolvedTemplateName = preferredTemplateName ?? project?.template_name ?? null;
    if (!resolvedTemplateName) {
      throw new Error(
        `No default workflow could be resolved for project ${projectId}. Set a template or create a workflow first.`
      );
    }

    return this.createWorkflow({
      projectId,
      name: "Default",
      templateName: resolvedTemplateName,
      isDefault: true,
    });
  }

  getWorkflowDeletePreview(
    projectId: string,
    workflowId: string,
    sampleSize: number = 5
  ): WorkflowDeletePreview {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tickets
         WHERE project_id = ? AND workflow_id = ?`
      )
      .get(projectId, workflowId) as { count: number };

    const samples = this.db
      .prepare(
        `SELECT id
         FROM tickets
         WHERE project_id = ? AND workflow_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(projectId, workflowId, sampleSize) as Array<{ id: string }>;

    return {
      ticketCount: row.count,
      sampleTicketIds: samples.map((sample) => sample.id),
    };
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

export function projectWorkflowDeleteForProject(projectId: string): number {
  return getProjectWorkflowStore().deleteWorkflowsForProject(projectId);
}

export function projectWorkflowGetDefault(
  projectId: string
): ProjectWorkflow | null {
  return getProjectWorkflowStore().getDefaultWorkflow(projectId);
}

export function projectWorkflowEnsureDefault(
  projectId: string,
  preferredTemplateName?: string
): ProjectWorkflow {
  return getProjectWorkflowStore().ensureDefaultWorkflow(
    projectId,
    preferredTemplateName,
  );
}

export function projectWorkflowGetDeletePreview(
  projectId: string,
  workflowId: string,
  sampleSize?: number
): WorkflowDeletePreview {
  return getProjectWorkflowStore().getWorkflowDeletePreview(
    projectId,
    workflowId,
    sampleSize,
  );
}
