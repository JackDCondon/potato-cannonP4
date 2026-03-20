import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import type Database from "better-sqlite3";
import { getWorkflowTemplateDir } from "../config/paths.js";

const CURRENT_SCHEMA_VERSION = 27;

/**
 * Run database migrations.
 * Uses SQLite's user_version pragma to track schema version.
 */
export function runMigrations(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;

  if (version < 1) {
    migrateV1(db);
  }

  if (version < 2) {
    migrateV2(db);
  }

  if (version < 3) {
    migrateV3(db);
  }

  if (version < 4) {
    migrateV4(db);
  }

  if (version < 5) {
    migrateV5(db);
  }

  if (version < 6) {
    migrateV6(db);
  }

  if (version < 7) {
    migrateV7(db);
  }

  if (version < 8) {
    migrateV8(db);
  }

  if (version < 9) {
    migrateV9(db);
  }

  if (version < 10) {
    migrateV10(db);
  }

  if (version < 11) {
    migrateV11(db);
  }

  if (version < 12) {
    migrateV12(db);
  }

  if (version < 13) {
    migrateV13(db);
  }

  if (version < 14) {
    migrateV14(db);
  }

  if (version < 15) {
    migrateV15(db);
  }

  if (version < 16) {
    migrateV16(db);
  }

  if (version < 17) {
    migrateV17(db);
  }

  if (version < 18) {
    migrateV18(db);
  }

  if (version < 19) {
    migrateV19(db);
  }

  if (version < 20) {
    migrateV20(db);
  }

  if (version < 21) {
    migrateV21(db);
  }

  if (version < 22) {
    migrateV22(db);
  }

  if (version < 23) {
    migrateV23(db);
  }

  if (version < 24) {
    migrateV24(db);
  }

  if (version < 25) {
    migrateV25(db);
  }

  if (version < 26) {
    migrateV26(db);
  }

  if (version < 27) {
    db.exec(`
      DROP TABLE IF EXISTS chat_delivery_events;
      DROP TABLE IF EXISTS chat_queue_items;
    `);
  }

  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}

/**
 * V1: Initial schema - projects table
 */
function migrateV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id               TEXT PRIMARY KEY,
      slug             TEXT NOT NULL UNIQUE,
      display_name     TEXT NOT NULL,
      path             TEXT NOT NULL UNIQUE,
      registered_at    TEXT NOT NULL,
      icon             TEXT,
      color            TEXT,
      template_name    TEXT,
      template_version TEXT,
      disabled_phases  TEXT,
      disabled_phase_migration INTEGER DEFAULT 0,
      swimlane_colors  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
  `);
}

/**
 * V2: Tickets, history entries, and sessions
 */
function migrateV2(db: Database.Database): void {
  db.exec(`
    -- Ticket counters for generating prefix-based IDs (e.g., POT-1, POT-2)
    CREATE TABLE IF NOT EXISTS ticket_counters (
      project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      next_number   INTEGER NOT NULL DEFAULT 1
    );

    -- Main tickets table
    CREATE TABLE IF NOT EXISTS tickets (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      phase         TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      archived      INTEGER DEFAULT 0,
      archived_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_phase ON tickets(project_id, phase);
    CREATE INDEX IF NOT EXISTS idx_tickets_archived ON tickets(project_id, archived);

    -- Ticket history entries (phase transitions)
    CREATE TABLE IF NOT EXISTS ticket_history (
      id            TEXT PRIMARY KEY,
      ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      phase         TEXT NOT NULL,
      entered_at    TEXT NOT NULL,
      exited_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ticket_history_ticket ON ticket_history(ticket_id);

    -- Ticket sessions (Claude sessions within a phase)
    CREATE TABLE IF NOT EXISTS ticket_sessions (
      id            TEXT PRIMARY KEY,
      ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      history_id    TEXT NOT NULL REFERENCES ticket_history(id) ON DELETE CASCADE,
      session_id    TEXT NOT NULL,
      source        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      exit_code     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_ticket_sessions_ticket ON ticket_sessions(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_sessions_history ON ticket_sessions(history_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_sessions_session_id ON ticket_sessions(session_id);
  `);
}

/**
 * V3: Unified conversations, sessions, and brainstorms
 */
function migrateV3(db: Database.Database): void {
  db.exec(`
    -- Conversations table (reusable chat container)
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);

    -- Messages within a conversation
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      type            TEXT NOT NULL,
      text            TEXT NOT NULL,
      options         TEXT,
      timestamp       TEXT NOT NULL,
      answered_at     TEXT,
      metadata        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_pending ON conversation_messages(conversation_id, answered_at)
      WHERE type = 'question' AND answered_at IS NULL;

    -- Brainstorms table
    CREATE TABLE IF NOT EXISTS brainstorms (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      created_ticket_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_brainstorms_project ON brainstorms(project_id);
    CREATE INDEX IF NOT EXISTS idx_brainstorms_status ON brainstorms(project_id, status);

    -- Unified sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ticket_id         TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      brainstorm_id     TEXT REFERENCES brainstorms(id) ON DELETE CASCADE,
      conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      claude_session_id TEXT,
      agent_source      TEXT,
      started_at        TEXT NOT NULL,
      ended_at          TEXT,
      exit_code         INTEGER,
      phase             TEXT,
      metadata          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON sessions(ticket_id) WHERE ticket_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_brainstorm ON sessions(brainstorm_id) WHERE brainstorm_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_claude ON sessions(claude_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(ended_at) WHERE ended_at IS NULL;

    -- Add conversation_id to tickets
    ALTER TABLE tickets ADD COLUMN conversation_id TEXT REFERENCES conversations(id);

    -- Drop old ticket_sessions table (data migrated to sessions)
    DROP TABLE IF EXISTS ticket_sessions;
  `);
}

/**
 * V4: Backfill conversation_id for existing tickets
 */
function migrateV4(db: Database.Database): void {
  // Find tickets without conversations
  const ticketsWithoutConv = db
    .prepare(
      `SELECT id, project_id FROM tickets WHERE conversation_id IS NULL`
    )
    .all() as Array<{ id: string; project_id: string }>;

  if (ticketsWithoutConv.length === 0) {
    return;
  }

  console.log(
    `[migrateV4] Backfilling ${ticketsWithoutConv.length} tickets with conversations`
  );

  const insertConv = db.prepare(
    `INSERT INTO conversations (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
  );
  const updateTicket = db.prepare(
    `UPDATE tickets SET conversation_id = ? WHERE id = ?`
  );

  const now = new Date().toISOString();

  for (const ticket of ticketsWithoutConv) {
    const convId = crypto.randomUUID();
    insertConv.run(convId, ticket.project_id, now, now);
    updateTicket.run(convId, ticket.id);
  }

  console.log(`[migrateV4] Backfill complete`);
}

/**
 * V5: Tasks, provider channels, ralph feedback, artifacts, templates, config
 *     Plus ticket description and worker_state columns
 */
function migrateV5(db: Database.Database): void {
  // Add columns to tickets table (check if they exist first to be idempotent)
  const ticketColumns = db
    .prepare("PRAGMA table_info(tickets)")
    .all() as { name: string }[];
  const columnNames = new Set(ticketColumns.map((c) => c.name));

  if (!columnNames.has("description")) {
    db.exec(`ALTER TABLE tickets ADD COLUMN description TEXT DEFAULT ''`);
  }
  if (!columnNames.has("worker_state")) {
    db.exec(`ALTER TABLE tickets ADD COLUMN worker_state TEXT`);
  }

  // Create tables with IF NOT EXISTS to be idempotent
  db.exec(`

    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id             TEXT PRIMARY KEY,
      ticket_id      TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      display_number INTEGER NOT NULL,
      phase          TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      attempt_count  INTEGER NOT NULL DEFAULT 0,
      description    TEXT NOT NULL,
      body           TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      UNIQUE(ticket_id, display_number)
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_ticket ON tasks(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_ticket_phase ON tasks(ticket_id, phase);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(ticket_id, status);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

    -- Provider Channels
    CREATE TABLE IF NOT EXISTS provider_channels (
      id            TEXT PRIMARY KEY,
      ticket_id     TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      brainstorm_id TEXT REFERENCES brainstorms(id) ON DELETE CASCADE,
      provider_id   TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      metadata      TEXT,
      created_at    TEXT NOT NULL,
      CHECK ((ticket_id IS NULL) != (brainstorm_id IS NULL)),
      UNIQUE(ticket_id, provider_id),
      UNIQUE(brainstorm_id, provider_id)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_channels_ticket ON provider_channels(ticket_id) WHERE ticket_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_channels_brainstorm ON provider_channels(brainstorm_id) WHERE brainstorm_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_channels_lookup ON provider_channels(provider_id, channel_id);

    -- Ralph Feedback
    CREATE TABLE IF NOT EXISTS ralph_feedback (
      id            TEXT PRIMARY KEY,
      ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      phase_id      TEXT NOT NULL,
      ralph_loop_id TEXT NOT NULL,
      task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      max_attempts  INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'running',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(ticket_id, phase_id, ralph_loop_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS ralph_iterations (
      id                TEXT PRIMARY KEY,
      ralph_feedback_id TEXT NOT NULL REFERENCES ralph_feedback(id) ON DELETE CASCADE,
      iteration         INTEGER NOT NULL,
      approved          INTEGER NOT NULL,
      feedback          TEXT,
      reviewer          TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ralph_feedback_ticket ON ralph_feedback(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ralph_iterations_feedback ON ralph_iterations(ralph_feedback_id);

    -- Artifacts (metadata only)
    CREATE TABLE IF NOT EXISTS artifacts (
      id          TEXT PRIMARY KEY,
      ticket_id   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      type        TEXT NOT NULL,
      description TEXT,
      phase       TEXT,
      file_path   TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(ticket_id, filename)
    );

    CREATE TABLE IF NOT EXISTS artifact_versions (
      id          TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      description TEXT,
      file_path   TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE(artifact_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_ticket ON artifacts(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id);

    -- Templates (registry only)
    CREATE TABLE IF NOT EXISTS templates (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      version     TEXT NOT NULL,
      description TEXT,
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_templates_default ON templates(is_default) WHERE is_default = 1;

    -- Config (key-value)
    CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * V6: Add branch_prefix column to projects table
 */
function migrateV6(db: Database.Database): void {
  db.exec(`ALTER TABLE projects ADD COLUMN branch_prefix TEXT DEFAULT 'potato'`);
}

/**
 * V7: Add folders table and folder_id FK on projects
 */
function migrateV7(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const hasFolderId = columns.some((col) => col.name === 'folder_id');
  if (!hasFolderId) {
    db.exec(`ALTER TABLE projects ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL`);
  }
}

/**
 * V8: Add Perforce project configuration columns to projects table
 */
function migrateV8(db: Database.Database): void {
  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('p4_stream')) {
    db.exec(`ALTER TABLE projects ADD COLUMN p4_stream TEXT`);
  }
  if (!columnNames.has('agent_workspace_root')) {
    db.exec(`ALTER TABLE projects ADD COLUMN agent_workspace_root TEXT`);
  }
  if (!columnNames.has('helix_swarm_url')) {
    db.exec(`ALTER TABLE projects ADD COLUMN helix_swarm_url TEXT`);
  }
}

/**
 * V9: Add suggested_p4_stream column to projects table (AI-detected P4 stream on registration)
 */
function migrateV9(db: Database.Database): void {
  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('suggested_p4_stream')) {
    db.exec(`ALTER TABLE projects ADD COLUMN suggested_p4_stream TEXT`);
  }
}

/**
 * V10: Add vcs_type column to projects table.
 * Backfills existing Perforce projects (those with p4_stream set).
 */
function migrateV10(db: Database.Database): void {
  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('vcs_type')) {
    db.exec(`ALTER TABLE projects ADD COLUMN vcs_type TEXT NOT NULL DEFAULT 'git'`);
    db.exec(`UPDATE projects SET vcs_type = 'perforce' WHERE p4_stream IS NOT NULL`);
  }
}

/**
 * V11: Add p4_mcp_server_path column to projects table.
 */
function migrateV11(db: Database.Database): void {
  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has('p4_mcp_server_path')) {
    db.exec(`ALTER TABLE projects ADD COLUMN p4_mcp_server_path TEXT`);
  }
}

/**
 * V12: Add complexity column to tickets and tasks tables.
 * Default 'standard' ensures existing rows get a valid value without data migration.
 */
function migrateV12(db: Database.Database): void {
  const ticketCols = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(r => r.name)
  );
  if (!ticketCols.has('complexity')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN complexity TEXT NOT NULL DEFAULT 'standard' CHECK(complexity IN ('simple', 'standard', 'complex'))`);
  }

  const taskCols = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(r => r.name)
  );
  if (!taskCols.has('complexity')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN complexity TEXT NOT NULL DEFAULT 'standard' CHECK(complexity IN ('simple', 'standard', 'complex'))`);
  }
}

/**
 * V13: Add project_workflows table and workflow_id FK on tickets.
 * Enables multiple independent workflow boards per project.
 * Existing tickets get workflow_id = NULL (nullable for backward compatibility).
 */
function migrateV13(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_workflows (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      template_name TEXT NOT NULL,
      is_default    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(project_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_project_workflows_project ON project_workflows(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_workflows_default ON project_workflows(project_id, is_default) WHERE is_default = 1;
  `);

  const ticketCols = new Set(
    (db.prepare('PRAGMA table_info(tickets)').all() as { name: string }[]).map((r) => r.name)
  );
  if (!ticketCols.has('workflow_id')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN workflow_id TEXT REFERENCES project_workflows(id) ON DELETE SET NULL`);
  }

  runBackfillV13(db);
}

/**
 * Backfill V13: create a default project_workflow row for every existing project
 * that does not already have one, then set workflow_id on all tickets that still
 * have it as NULL.
 *
 * Idempotent — uses INSERT OR IGNORE and only updates tickets with NULL workflow_id.
 * Falls back to 'product-development' when a project has no template_name set.
 *
 * Exported for testability.
 */
export function runBackfillV13(db: Database.Database): void {
  const projects = db
    .prepare('SELECT id, template_name FROM projects')
    .all() as Array<{ id: string; template_name: string | null }>;

  if (projects.length === 0) {
    return;
  }

  const findDefaultWorkflow = db.prepare(
    `SELECT id FROM project_workflows WHERE project_id = ? AND is_default = 1 LIMIT 1`
  );

  const insertWorkflow = db.prepare(
    `INSERT INTO project_workflows
       (id, project_id, name, template_name, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  );

  const getWorkflowByName = db.prepare(
    `SELECT id FROM project_workflows WHERE project_id = ? AND name = ? LIMIT 1`
  );

  const backfillTickets = db.prepare(
    `UPDATE tickets SET workflow_id = ? WHERE project_id = ? AND workflow_id IS NULL`
  );

  const backfill = db.transaction(() => {
    const now = new Date().toISOString();

    for (const project of projects) {
      const templateName = project.template_name ?? 'product-development';

      // First, check if a default workflow already exists (keyed on is_default=1)
      let row = findDefaultWorkflow.get(project.id) as { id: string } | undefined;

      if (!row) {
        // No default workflow exists — insert a new 'Default' row
        const newId = randomUUID();
        insertWorkflow.run(newId, project.id, 'Default', templateName, now, now);
        // Retrieve via name to confirm insertion (handles edge cases)
        row = getWorkflowByName.get(project.id, 'Default') as { id: string } | undefined;
      }

      if (!row) {
        continue;
      }

      backfillTickets.run(row.id, project.id);
    }
  });

  backfill();
}

/**
 * V14: Add ticket_dependencies table and workflow_id to brainstorms.
 * Enables same-board dependency tracking between tickets and scoping brainstorms to workflows.
 */
function migrateV14(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_dependencies (
      id          TEXT PRIMARY KEY,
      ticket_id   TEXT NOT NULL,
      depends_on  TEXT NOT NULL,
      tier        TEXT NOT NULL CHECK(tier IN ('artifact-ready', 'code-ready')),
      created_at  TEXT NOT NULL,
      FOREIGN KEY (ticket_id)  REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on) REFERENCES tickets(id) ON DELETE CASCADE,
      UNIQUE(ticket_id, depends_on),
      CHECK(ticket_id != depends_on)
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_dependencies_depends_on
      ON ticket_dependencies(depends_on);
  `)

  // Add workflow_id to brainstorms (idempotent)
  const columns = db.pragma('table_info(brainstorms)') as { name: string }[]
  if (!columns.some(c => c.name === 'workflow_id')) {
    db.exec(`ALTER TABLE brainstorms ADD COLUMN workflow_id TEXT REFERENCES project_workflows(id) ON DELETE SET NULL`)
  }
}

/**
 * V15: Add metadata field to ticket_history to persist phase override details.
 */
function migrateV15(db: Database.Database): void {
  const columns = db.pragma('table_info(ticket_history)') as { name: string }[]
  if (!columns.some((column) => column.name === 'metadata')) {
    db.exec('ALTER TABLE ticket_history ADD COLUMN metadata TEXT')
  }
}

/**
 * V16: Add execution generation fields for ticket/session lifecycle fencing.
 */
function migrateV16(db: Database.Database): void {
  const ticketColumns = db.pragma('table_info(tickets)') as { name: string }[];
  if (!ticketColumns.some((column) => column.name === 'execution_generation')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 0`);
  }

  const sessionColumns = db.pragma('table_info(sessions)') as { name: string }[];
  if (!sessionColumns.some((column) => column.name === 'execution_generation')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN execution_generation INTEGER`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_ticket_generation_active
    ON sessions(ticket_id, execution_generation)
    WHERE ended_at IS NULL AND ticket_id IS NOT NULL AND execution_generation IS NOT NULL
  `);
}

/**
 * V17: Add durable chat queue + delivery telemetry tables and provider route indexes.
 */
function migrateV17(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_queue_items (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ticket_id      TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      brainstorm_id  TEXT REFERENCES brainstorms(id) ON DELETE CASCADE,
      kind           TEXT NOT NULL CHECK(kind IN ('question', 'notification')),
      question_id    TEXT,
      provider_scope TEXT NOT NULL DEFAULT 'all_active',
      payload_json   TEXT NOT NULL,
      status         TEXT NOT NULL CHECK(status IN ('queued', 'dispatching', 'awaiting_reply', 'answered', 'cancelled', 'stale', 'timed_out', 'failed', 'dead_letter')),
      retry_count    INTEGER NOT NULL DEFAULT 0,
      available_at   TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      sent_at        TEXT,
      resolved_at    TEXT,
      resolved_by    TEXT CHECK(resolved_by IN ('web', 'telegram', 'slack', 'system'))
    );

    CREATE TABLE IF NOT EXISTS chat_delivery_events (
      id            TEXT PRIMARY KEY,
      queue_item_id TEXT NOT NULL REFERENCES chat_queue_items(id) ON DELETE CASCADE,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ticket_id     TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      provider_id   TEXT NOT NULL,
      event_type    TEXT NOT NULL CHECK(event_type IN ('sent', 'failed', 'retried', 'dead_letter', 'answered', 'cancelled')),
      attempt       INTEGER NOT NULL DEFAULT 1,
      error_text    TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_queue_ready
      ON chat_queue_items(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_queue_ticket
      ON chat_queue_items(ticket_id, created_at) WHERE ticket_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_queue_question_id
      ON chat_queue_items(question_id) WHERE question_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_queue_active_question
      ON chat_queue_items(status, created_at)
      WHERE kind = 'question' AND status = 'awaiting_reply';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_queue_single_active_question
      ON chat_queue_items(kind, status)
      WHERE kind = 'question' AND status = 'awaiting_reply';

    CREATE INDEX IF NOT EXISTS idx_chat_delivery_events_queue_item
      ON chat_delivery_events(queue_item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_delivery_events_provider
      ON chat_delivery_events(provider_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_delivery_events_ticket
      ON chat_delivery_events(ticket_id, created_at) WHERE ticket_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_provider_channels_route_thread_id
      ON provider_channels(provider_id, channel_id, CAST(json_extract(metadata, '$.messageThreadId') AS TEXT))
      WHERE metadata IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_channels_route_slack_thread
      ON provider_channels(provider_id, channel_id, CAST(json_extract(metadata, '$.threadTs') AS TEXT))
      WHERE metadata IS NOT NULL;
  `);
}

/**
 * V18: Enforce strict workflow identity on tickets.
 * - Delete legacy tickets with NULL workflow_id.
 * - Rebuild tickets table so workflow_id is NOT NULL with ON DELETE RESTRICT.
 */
function migrateV18(db: Database.Database): void {
  const nullableTicketCount = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM tickets WHERE workflow_id IS NULL`)
      .get() as { count: number }
  ).count;

  if (nullableTicketCount > 0) {
    const deleteResult = db.prepare(`DELETE FROM tickets WHERE workflow_id IS NULL`).run();
    console.log(
      `[migrateV18] Deleted ${deleteResult.changes} tickets with NULL workflow_id before strict constraint migration`
    );
  }

  const ticketColumns = db.pragma('table_info(tickets)') as Array<{ name: string; notnull: number }>;
  const workflowColumn = ticketColumns.find((column) => column.name === 'workflow_id');
  const workflowForeignKey = (db.pragma('foreign_key_list(tickets)') as Array<{
    from: string;
    on_delete: string;
  }>).find((foreignKey) => foreignKey.from === 'workflow_id');
  const alreadyStrict =
    workflowColumn?.notnull === 1 && workflowForeignKey?.on_delete?.toUpperCase() === 'RESTRICT';

  if (alreadyStrict) {
    console.log('[migrateV18] tickets.workflow_id already strict, skipping table rebuild');
    return;
  }

  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) as number;
  if (foreignKeysEnabled === 1) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    db.exec('BEGIN');

    db.exec(`
      CREATE TABLE tickets_v18 (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title                TEXT NOT NULL,
        phase                TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        archived             INTEGER DEFAULT 0,
        archived_at          TEXT,
        conversation_id      TEXT REFERENCES conversations(id),
        description          TEXT DEFAULT '',
        worker_state         TEXT,
        complexity           TEXT NOT NULL DEFAULT 'standard' CHECK(complexity IN ('simple', 'standard', 'complex')),
        workflow_id          TEXT NOT NULL REFERENCES project_workflows(id) ON DELETE RESTRICT,
        execution_generation INTEGER NOT NULL DEFAULT 0
      );
    `);

    db.exec(`
      INSERT INTO tickets_v18 (
        id,
        project_id,
        title,
        phase,
        created_at,
        updated_at,
        archived,
        archived_at,
        conversation_id,
        description,
        worker_state,
        complexity,
        workflow_id,
        execution_generation
      )
      SELECT
        id,
        project_id,
        title,
        phase,
        created_at,
        updated_at,
        archived,
        archived_at,
        conversation_id,
        description,
        worker_state,
        complexity,
        workflow_id,
        execution_generation
      FROM tickets
      WHERE workflow_id IS NOT NULL
    `);

    db.exec(`
      DROP TABLE tickets;
      ALTER TABLE tickets_v18 RENAME TO tickets;

      CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_phase ON tickets(project_id, phase);
      CREATE INDEX IF NOT EXISTS idx_tickets_archived ON tickets(project_id, archived);
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    if (foreignKeysEnabled === 1) {
      db.pragma('foreign_keys = ON');
    }
  }

  console.log('[migrateV18] Rebuilt tickets with workflow_id NOT NULL and ON DELETE RESTRICT');
}

/**
 * V19: Add workflow-scoped template version metadata on project_workflows.
 */
function migrateV19(db: Database.Database): void {
  const workflowColumns = db.pragma("table_info(project_workflows)") as Array<{
    name: string;
  }>;
  const hasTemplateVersion = workflowColumns.some(
    (column) => column.name === "template_version"
  );
  if (!hasTemplateVersion) {
    db.exec(
      "ALTER TABLE project_workflows ADD COLUMN template_version TEXT NOT NULL DEFAULT '1.0.0'"
    );
  }

  const templates = db
    .prepare("SELECT name, version FROM templates")
    .all() as Array<{ name: string; version: string }>;
  const templateVersionByName = new Map(
    templates.map((template) => [template.name, normalizeTemplateVersion(template.version)])
  );

  const workflows = db
    .prepare(
      `SELECT
         pw.id,
         pw.project_id,
         pw.template_name,
         pw.template_version,
         p.template_name AS project_template_name,
         p.template_version AS project_template_version
       FROM project_workflows pw
       JOIN projects p ON p.id = pw.project_id`
    )
    .all() as Array<{
    id: string;
    project_id: string;
    template_name: string;
    template_version: string | null;
    project_template_name: string | null;
    project_template_version: string | null;
  }>;

  const updateTemplateVersion = db.prepare(
    "UPDATE project_workflows SET template_version = ? WHERE id = ?"
  );

  const backfill = db.transaction(() => {
    for (const workflow of workflows) {
      const workflowLocalVersion = readWorkflowLocalTemplateVersion(
        workflow.project_id,
        workflow.id
      );
      const projectVersion =
        workflow.project_template_name === workflow.template_name
          ? normalizeTemplateVersion(workflow.project_template_version)
          : null;
      const catalogVersion = templateVersionByName.get(workflow.template_name) ?? null;
      const existingVersion = normalizeTemplateVersion(workflow.template_version);
      const resolvedVersion =
        workflowLocalVersion ??
        projectVersion ??
        catalogVersion ??
        existingVersion ??
        "1.0.0";
      updateTemplateVersion.run(resolvedVersion, workflow.id);
    }
  });

  backfill();
}

/**
 * V20: Add provider_override to projects for per-project AI provider selection.
 */
function migrateV20(db: Database.Database): void {
  const columns = db.pragma("table_info(projects)") as Array<{ name: string }>;
  const hasProviderOverride = columns.some((column) => column.name === "provider_override");
  if (!hasProviderOverride) {
    db.exec("ALTER TABLE projects ADD COLUMN provider_override TEXT");
  }
}

/**
 * V21: Brainstorm-to-ticket linkage for scope context
 * - Add brainstorm_id FK on tickets (enables sibling discovery)
 * - Add plan_summary on brainstorms (stores the epic plan)
 * - Backfill brainstorm_id from existing created_ticket_id relationships
 */
function migrateV21(db: Database.Database): void {
  const ticketCols = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!ticketCols.has("brainstorm_id")) {
    db.exec(
      `ALTER TABLE tickets ADD COLUMN brainstorm_id TEXT REFERENCES brainstorms(id) ON DELETE SET NULL`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tickets_brainstorm_id ON tickets(brainstorm_id) WHERE brainstorm_id IS NOT NULL`,
    );
  }

  const brainstormCols = new Set(
    (
      db.prepare("PRAGMA table_info(brainstorms)").all() as { name: string }[]
    ).map((r) => r.name),
  );
  if (!brainstormCols.has("plan_summary")) {
    db.exec(`ALTER TABLE brainstorms ADD COLUMN plan_summary TEXT`);
  }

  // Backfill: for brainstorms with created_ticket_id, set the ticket's brainstorm_id.
  // LIMIT 1 makes the subquery deterministic when multiple brainstorms share the same
  // created_ticket_id (no UNIQUE constraint prevents this).
  db.exec(`
    UPDATE tickets SET brainstorm_id = (
      SELECT id FROM brainstorms WHERE created_ticket_id = tickets.id LIMIT 1
    )
    WHERE brainstorm_id IS NULL
      AND id IN (SELECT created_ticket_id FROM brainstorms WHERE created_ticket_id IS NOT NULL)
  `);
}

/**
 * V22: PM Fields and Board Settings
 * - Add pm_enabled column to brainstorms (default 0, not null)
 * - Create board_settings table with workflow_id FK and pm_config JSON storage
 */
function migrateV22(db: Database.Database): void {
  // Add pm_enabled to brainstorms (idempotent check)
  const brainstormCols = new Set(
    (db.prepare("PRAGMA table_info(brainstorms)").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!brainstormCols.has("pm_enabled")) {
    db.exec(`ALTER TABLE brainstorms ADD COLUMN pm_enabled INTEGER NOT NULL DEFAULT 0`);
  }

  // Create board_settings table (idempotent with IF NOT EXISTS)
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_settings (
      id            TEXT PRIMARY KEY,
      workflow_id   TEXT NOT NULL UNIQUE REFERENCES project_workflows(id) ON DELETE CASCADE,
      pm_config     TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_board_settings_workflow ON board_settings(workflow_id);
  `);
}

/**
 * V23: Add color and icon columns to brainstorms table for epic customization.
 * - color: TEXT nullable, stores the epic's primary color
 * - icon: TEXT nullable, stores the epic's icon choice
 */
function migrateV23(db: Database.Database): void {
  const brainstormCols = new Set(
    (db.prepare("PRAGMA table_info(brainstorms)").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!brainstormCols.has("color")) {
    db.exec(`ALTER TABLE brainstorms ADD COLUMN color TEXT`);
  }
  if (!brainstormCols.has("icon")) {
    db.exec(`ALTER TABLE brainstorms ADD COLUMN icon TEXT`);
  }
}

/**
 * V24: Add input_tokens and output_tokens columns to sessions table
 * for persisting token counts from Claude stream events.
 */
function migrateV24(db: Database.Database): void {
  const sessionsCols = new Set(
    (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!sessionsCols.has("input_tokens")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN input_tokens INTEGER`);
  }
  if (!sessionsCols.has("output_tokens")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN output_tokens INTEGER`);
  }
}

/**
 * V25: Add paused state columns to tickets table for pause/retry behavior.
 * - paused: INTEGER NOT NULL DEFAULT 0, flag indicating if ticket is paused
 * - pause_reason: TEXT, reason why the ticket was paused
 * - pause_retry_at: TEXT, ISO timestamp for when to retry
 * - pause_retry_count: INTEGER NOT NULL DEFAULT 0, number of retry attempts
 */
function migrateV25(db: Database.Database): void {
  const ticketCols = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!ticketCols.has("paused")) {
    db.exec(`ALTER TABLE tickets ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);
  }
  if (!ticketCols.has("pause_reason")) {
    db.exec(`ALTER TABLE tickets ADD COLUMN pause_reason TEXT`);
  }
  if (!ticketCols.has("pause_retry_at")) {
    db.exec(`ALTER TABLE tickets ADD COLUMN pause_retry_at TEXT`);
  }
  if (!ticketCols.has("pause_retry_count")) {
    db.exec(`ALTER TABLE tickets ADD COLUMN pause_retry_count INTEGER NOT NULL DEFAULT 0`);
  }
}

/**
 * V26: Add per-project Perforce connection override columns to projects.
 */
function migrateV26(db: Database.Database): void {
  const projectCols = new Set(
    (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  if (!projectCols.has("p4_use_env_vars")) {
    db.exec(`ALTER TABLE projects ADD COLUMN p4_use_env_vars INTEGER`);
  }
  if (!projectCols.has("p4_port")) {
    db.exec(`ALTER TABLE projects ADD COLUMN p4_port TEXT`);
  }
  if (!projectCols.has("p4_user")) {
    db.exec(`ALTER TABLE projects ADD COLUMN p4_user TEXT`);
  }
}

function normalizeTemplateVersion(version: string | null | undefined): string | null {
  if (!version) {
    return null;
  }
  const trimmed = version.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return `${trimmed}.0.0`;
  }
  return trimmed;
}

function readWorkflowLocalTemplateVersion(
  projectId: string,
  workflowId: string
): string | null {
  try {
    const workflowTemplatePath = `${getWorkflowTemplateDir(
      projectId,
      workflowId
    )}/workflow.json`;
    if (!nodeFs.existsSync(workflowTemplatePath)) {
      return null;
    }
    const raw = nodeFs.readFileSync(workflowTemplatePath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string | number };
    if (typeof parsed.version === "number") {
      return `${parsed.version}.0.0`;
    }
    return normalizeTemplateVersion(parsed.version);
  } catch {
    return null;
  }
}
