import Database from 'better-sqlite3';
import { runMigrations, runBackfillV13 } from '../migrations.js';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkflowTemplateDir } from '../../config/paths.js';

function rebuildTicketsAsLegacyV17(db: Database.Database): void {
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) as number;
  if (foreignKeysEnabled === 1) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE tickets_legacy_v17 (
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
        workflow_id          TEXT REFERENCES project_workflows(id) ON DELETE SET NULL,
        execution_generation INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec(`
      INSERT INTO tickets_legacy_v17 (
        id, project_id, title, phase, created_at, updated_at, archived, archived_at,
        conversation_id, description, worker_state, complexity, workflow_id, execution_generation
      )
      SELECT
        id, project_id, title, phase, created_at, updated_at, archived, archived_at,
        conversation_id, description, worker_state, complexity, workflow_id, execution_generation
      FROM tickets;
    `);
    db.exec(`
      DROP TABLE tickets;
      ALTER TABLE tickets_legacy_v17 RENAME TO tickets;
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
}

function rebuildWorkflowsAsLegacyV18(db: Database.Database): void {
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) as number;
  if (foreignKeysEnabled === 1) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE project_workflows_legacy_v18 (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        template_name TEXT NOT NULL,
        is_default    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE(project_id, name)
      );
    `);
    db.exec(`
      INSERT INTO project_workflows_legacy_v18 (
        id, project_id, name, template_name, is_default, created_at, updated_at
      )
      SELECT
        id, project_id, name, template_name, is_default, created_at, updated_at
      FROM project_workflows;
    `);
    db.exec(`
      DROP TABLE project_workflows;
      ALTER TABLE project_workflows_legacy_v18 RENAME TO project_workflows;
      CREATE INDEX IF NOT EXISTS idx_project_workflows_project ON project_workflows(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_workflows_default ON project_workflows(project_id, is_default) WHERE is_default = 1;
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
}

describe('V13 migration — project_workflows table + workflow_id on tickets', () => {
  let db: Database.Database;

  before(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('creates project_workflows table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_workflows'")
      .all() as { name: string }[];
    assert.equal(tables.length, 1, 'project_workflows table should exist');
  });

  it('project_workflows table has expected columns', () => {
    const cols = db.pragma('table_info(project_workflows)') as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    assert.ok(colNames.has('id'), 'should have id column');
    assert.ok(colNames.has('project_id'), 'should have project_id column');
    assert.ok(colNames.has('name'), 'should have name column');
    assert.ok(colNames.has('template_name'), 'should have template_name column');
    assert.ok(colNames.has('is_default'), 'should have is_default column');
    assert.ok(colNames.has('created_at'), 'should have created_at column');
    assert.ok(colNames.has('updated_at'), 'should have updated_at column');
  });

  it('tickets table has workflow_id column', () => {
    const cols = db.pragma('table_info(tickets)') as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    assert.ok(colNames.has('workflow_id'), 'tickets table should have workflow_id column');
  });

  it('can insert a project_workflow row and link a ticket to it', () => {
    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-v13','pv13','V13 Project','/v13','2026-03-10')"
    );

    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf1','proj-v13','Default','product-development',1,'2026-03-10','2026-03-10')"
    );

    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v13', 1)"
    );

    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('tv13','proj-v13','Test Ticket','Backlog','2026-03-10','2026-03-10','wf1')"
    );

    const workflow = db
      .prepare("SELECT * FROM project_workflows WHERE id = 'wf1'")
      .get() as { id: string; project_id: string; is_default: number };
    assert.equal(workflow.id, 'wf1');
    assert.equal(workflow.project_id, 'proj-v13');
    assert.equal(workflow.is_default, 1);

    const ticket = db
      .prepare("SELECT workflow_id FROM tickets WHERE id = 'tv13'")
      .get() as { workflow_id: string };
    assert.equal(ticket.workflow_id, 'wf1');
  });

  it('workflow_id on tickets is required and linked to a project workflow', () => {
    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-legacy','pl','Legacy','/legacy','2026-01-01')"
    );
    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf-legacy','proj-legacy','Default','product-development',1,'2026-01-01','2026-01-01')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-legacy', 1)"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-legacy','proj-legacy','Old Ticket','Backlog','2026-01-01','2026-01-01','wf-legacy')"
    );
    const ticket = db
      .prepare("SELECT workflow_id FROM tickets WHERE id = 't-legacy'")
      .get() as { workflow_id: string };
    assert.equal(ticket.workflow_id, 'wf-legacy');
  });

  it('projects table has provider_override column', () => {
    const cols = db.pragma('table_info(projects)') as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    assert.ok(colNames.has('provider_override'), 'projects table should have provider_override column');
  });

  it('schema version is 22', () => {
    const version = db.pragma('user_version', { simple: true }) as number;
    assert.equal(version, 22);
  });
});

describe('V19 migration - workflow template version metadata', () => {
  it('adds template_version to project_workflows and advances schema version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    rebuildWorkflowsAsLegacyV18(db);
    db.pragma('user_version = 18');

    runMigrations(db);

    const columns = db.pragma('table_info(project_workflows)') as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    assert.ok(names.has('template_version'));
    const version = db.pragma('user_version', { simple: true }) as number;
    assert.equal(version, 22);
  });

  it('backfills template_version from workflow-local copy, then project version, then template catalog', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    rebuildWorkflowsAsLegacyV18(db);

    db.exec(`
      INSERT INTO templates (id, name, version, description, is_default, created_at, updated_at) VALUES
      ('tpl-a', 'product-development', '3.2.1', 'A', 1, '2026-03-12', '2026-03-12'),
      ('tpl-b', 'other-template', '5.4.3', 'B', 0, '2026-03-12', '2026-03-12');
    `);
    db.exec(`
      INSERT INTO projects (id, slug, display_name, path, registered_at, template_name, template_version) VALUES
      ('proj-v19', 'proj-v19', 'Project V19', '/tmp/proj-v19', '2026-03-12', 'product-development', '2.1.0');
    `);
    db.exec(`
      INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES
      ('wf-local', 'proj-v19', 'Local', 'product-development', 1, '2026-03-12', '2026-03-12'),
      ('wf-project', 'proj-v19', 'ProjectFallback', 'product-development', 0, '2026-03-12', '2026-03-12'),
      ('wf-catalog', 'proj-v19', 'CatalogFallback', 'other-template', 0, '2026-03-12', '2026-03-12');
    `);

    const workflowTemplateDir = getWorkflowTemplateDir('proj-v19', 'wf-local');
    fs.mkdirSync(workflowTemplateDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowTemplateDir, 'workflow.json'),
      JSON.stringify({ name: 'product-development', version: '9.9.9' }),
      'utf-8'
    );

    db.pragma('user_version = 18');
    runMigrations(db);

    const local = db
      .prepare("SELECT template_version FROM project_workflows WHERE id = 'wf-local'")
      .get() as { template_version: string };
    const projectFallback = db
      .prepare("SELECT template_version FROM project_workflows WHERE id = 'wf-project'")
      .get() as { template_version: string };
    const catalogFallback = db
      .prepare("SELECT template_version FROM project_workflows WHERE id = 'wf-catalog'")
      .get() as { template_version: string };

    assert.equal(local.template_version, '9.9.9');
    assert.equal(projectFallback.template_version, '2.1.0');
    assert.equal(catalogFallback.template_version, '5.4.3');

    fs.rmSync(workflowTemplateDir, { recursive: true, force: true });
  });
});

describe('V18 migration - strict workflow identity', () => {
  it('hard-deletes tickets with NULL workflow_id when migrating from v17', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    rebuildTicketsAsLegacyV17(db);

    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-v18-del','pv18del','V18 Delete','/v18del','2026-03-11')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v18-del', 1)"
    );
    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf-v18-del','proj-v18-del','Default','product-development',1,'2026-03-11','2026-03-11')"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-v18-keep','proj-v18-del','Keep','Backlog','2026-03-11','2026-03-11','wf-v18-del')"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-v18-drop','proj-v18-del','Drop','Backlog','2026-03-11','2026-03-11',NULL)"
    );

    db.pragma('user_version = 17');
    runMigrations(db);

    const ticketIds = db
      .prepare("SELECT id FROM tickets WHERE project_id = 'proj-v18-del' ORDER BY id")
      .all() as Array<{ id: string }>;
    assert.deepEqual(ticketIds.map((row) => row.id), ['t-v18-keep']);
  });

  it('enforces tickets.workflow_id as NOT NULL after v18 migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.pragma('user_version = 17');
    runMigrations(db);

    const cols = db.pragma('table_info(tickets)') as Array<{ name: string; notnull: number }>;
    const workflowCol = cols.find((col) => col.name === 'workflow_id');
    assert.ok(workflowCol, 'tickets.workflow_id should exist');
    assert.equal(workflowCol.notnull, 1, 'tickets.workflow_id should be NOT NULL');
  });

  it('uses ON DELETE RESTRICT for tickets.workflow_id foreign key after v18 migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-v18-fk','pv18fk','V18 FK','/v18fk','2026-03-11')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v18-fk', 1)"
    );
    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf-v18-fk','proj-v18-fk','Default','product-development',1,'2026-03-11','2026-03-11')"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-v18-fk','proj-v18-fk','FK Ticket','Backlog','2026-03-11','2026-03-11','wf-v18-fk')"
    );

    db.pragma('user_version = 17');
    runMigrations(db);

    assert.throws(
      () => {
        db.exec("DELETE FROM project_workflows WHERE id = 'wf-v18-fk'");
      },
      /FOREIGN KEY constraint failed/
    );
  });

  it('is idempotent when run repeatedly after v18 migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-v18-idem','pv18idem','V18 Idem','/v18idem','2026-03-11')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v18-idem', 1)"
    );
    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf-v18-idem','proj-v18-idem','Default','product-development',1,'2026-03-11','2026-03-11')"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-v18-idem','proj-v18-idem','Idempotent','Backlog','2026-03-11','2026-03-11','wf-v18-idem')"
    );

    db.pragma('user_version = 17');
    runMigrations(db);
    runMigrations(db);

    const count = db
      .prepare("SELECT COUNT(*) as count FROM tickets WHERE project_id = 'proj-v18-idem'")
      .get() as { count: number };
    assert.equal(count.count, 1, 'ticket rows should remain stable across repeated migrations');
  });
});

describe('V17 migration - chat queue and telemetry schema support', () => {
  it('creates chat queue and telemetry tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const queueCols = db.pragma('table_info(chat_queue_items)') as Array<{ name: string }>;
    const queueColNames = new Set(queueCols.map((col) => col.name));
    assert.ok(queueColNames.has('id'));
    assert.ok(queueColNames.has('question_id'));
    assert.ok(queueColNames.has('payload_json'));
    assert.ok(queueColNames.has('status'));

    const eventsCols = db.pragma('table_info(chat_delivery_events)') as Array<{ name: string }>;
    const eventColNames = new Set(eventsCols.map((col) => col.name));
    assert.ok(eventColNames.has('queue_item_id'));
    assert.ok(eventColNames.has('provider_id'));
    assert.ok(eventColNames.has('event_type'));
  });
});

describe('V16 migration - execution generation schema support', () => {
  it('adds execution_generation to tickets and sessions', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const ticketCols = db.pragma('table_info(tickets)') as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const ticketGeneration = ticketCols.find((col) => col.name === 'execution_generation');
    assert.ok(ticketGeneration, 'tickets.execution_generation should exist');
    assert.equal(ticketGeneration.notnull, 1, 'tickets.execution_generation should be NOT NULL');
    assert.equal(ticketGeneration.dflt_value, '0', 'tickets.execution_generation should default to 0');

    const sessionCols = db.pragma('table_info(sessions)') as Array<{ name: string; notnull: number }>;
    const sessionGeneration = sessionCols.find((col) => col.name === 'execution_generation');
    assert.ok(sessionGeneration, 'sessions.execution_generation should exist');
    assert.equal(sessionGeneration.notnull, 0, 'sessions.execution_generation should be nullable for legacy rows');
  });

  it('enforces one active ticket session per execution_generation', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-v16','pv16','V16 Project','/v16','2026-03-11')"
    );
    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf-v16','proj-v16','Default','product-development',1,'2026-03-11','2026-03-11')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v16', 1)"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-v16','proj-v16','Ticket V16','Ideas','2026-03-11','2026-03-11','wf-v16')"
    );

    db.exec(
      "INSERT INTO sessions (id, project_id, ticket_id, started_at, execution_generation) VALUES ('sess-v16-a','proj-v16','t-v16','2026-03-11T00:00:00.000Z',0)"
    );

    assert.throws(
      () => {
        db.exec(
          "INSERT INTO sessions (id, project_id, ticket_id, started_at, execution_generation) VALUES ('sess-v16-b','proj-v16','t-v16','2026-03-11T00:00:01.000Z',0)"
        );
      },
      /UNIQUE constraint failed/
    );

    db.exec(
      "UPDATE sessions SET ended_at = '2026-03-11T00:00:02.000Z' WHERE id = 'sess-v16-a'"
    );
    db.exec(
      "INSERT INTO sessions (id, project_id, ticket_id, started_at, execution_generation) VALUES ('sess-v16-c','proj-v16','t-v16','2026-03-11T00:00:03.000Z',0)"
    );
    db.exec(
      "INSERT INTO sessions (id, project_id, ticket_id, started_at, execution_generation) VALUES ('sess-v16-d','proj-v16','t-v16','2026-03-11T00:00:04.000Z',1)"
    );
  });

  it('allows multiple legacy active sessions with NULL execution_generation', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-v16-legacy','pv16l','V16 Legacy','/v16l','2026-03-11')"
    );
    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf-v16-legacy','proj-v16-legacy','Default','product-development',1,'2026-03-11','2026-03-11')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v16-legacy', 1)"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-v16-legacy','proj-v16-legacy','Legacy Ticket','Ideas','2026-03-11','2026-03-11','wf-v16-legacy')"
    );

    db.exec(
      "INSERT INTO sessions (id, project_id, ticket_id, started_at, execution_generation) VALUES ('sess-v16-legacy-a','proj-v16-legacy','t-v16-legacy','2026-03-11T00:00:00.000Z',NULL)"
    );
    db.exec(
      "INSERT INTO sessions (id, project_id, ticket_id, started_at, execution_generation) VALUES ('sess-v16-legacy-b','proj-v16-legacy','t-v16-legacy','2026-03-11T00:00:01.000Z',NULL)"
    );

    const count = db
      .prepare(
        "SELECT COUNT(*) as count FROM sessions WHERE ticket_id = 't-v16-legacy' AND ended_at IS NULL"
      )
      .get() as { count: number };
    assert.equal(count.count, 2);
  });
});

describe('V13 backfill — runBackfillV13', () => {
  it('backfills default workflow for a project with template_name and backfills ticket workflow_id', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    rebuildTicketsAsLegacyV17(db);

    // Insert a project with a template_name
    db.prepare(
      `INSERT INTO projects (id, slug, display_name, path, registered_at, template_name)
       VALUES ('proj-bf1', 'pbf1', 'Backfill Project', '/bf1', '2026-01-01', 'product-development')`
    ).run();

    // Insert tickets for that project (no workflow_id yet)
    db.prepare(
      `INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-bf1', 1)`
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at)
       VALUES ('t-bf1', 'proj-bf1', 'Ticket 1', 'Backlog', '2026-01-01', '2026-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at)
       VALUES ('t-bf2', 'proj-bf1', 'Ticket 2', 'Backlog', '2026-01-01', '2026-01-01')`
    ).run();

    runBackfillV13(db);

    // Assert: project_workflow row created with is_default=1
    const workflow = db
      .prepare("SELECT * FROM project_workflows WHERE project_id = 'proj-bf1' AND is_default = 1")
      .get() as { id: string; template_name: string; is_default: number; name: string } | undefined;
    assert.ok(workflow, 'default workflow should be created for the project');
    assert.equal(workflow.is_default, 1, 'workflow should be marked as default');
    assert.equal(workflow.template_name, 'product-development', 'workflow should use project template_name');

    // Assert: both tickets have workflow_id backfilled
    const t1 = db
      .prepare("SELECT workflow_id FROM tickets WHERE id = 't-bf1'")
      .get() as { workflow_id: string | null };
    assert.equal(t1.workflow_id, workflow.id, 'ticket 1 should have workflow_id set');

    const t2 = db
      .prepare("SELECT workflow_id FROM tickets WHERE id = 't-bf2'")
      .get() as { workflow_id: string | null };
    assert.equal(t2.workflow_id, workflow.id, 'ticket 2 should have workflow_id set');
  });

  it('uses product-development as fallback when project has no template_name', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    // Insert a project WITHOUT template_name
    db.prepare(
      `INSERT INTO projects (id, slug, display_name, path, registered_at)
       VALUES ('proj-bf2', 'pbf2', 'No Template Project', '/bf2', '2026-01-01')`
    ).run();

    runBackfillV13(db);

    const workflow = db
      .prepare("SELECT * FROM project_workflows WHERE project_id = 'proj-bf2'")
      .get() as { template_name: string; is_default: number } | undefined;
    assert.ok(workflow, 'default workflow should be created even without template_name');
    assert.equal(workflow.template_name, 'product-development', 'should fall back to product-development');
    assert.equal(workflow.is_default, 1, 'should be default');
  });

  it('is idempotent — running twice does not create duplicate workflows', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.prepare(
      `INSERT INTO projects (id, slug, display_name, path, registered_at, template_name)
       VALUES ('proj-bf3', 'pbf3', 'Idempotent Project', '/bf3', '2026-01-01', 'product-development')`
    ).run();

    runBackfillV13(db);
    runBackfillV13(db);

    const workflows = db
      .prepare("SELECT * FROM project_workflows WHERE project_id = 'proj-bf3'")
      .all() as unknown[];
    assert.equal(workflows.length, 1, 'should not create duplicate workflow rows');
  });

  it('does not overwrite existing workflow_id on tickets that already have one', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.prepare(
      `INSERT INTO projects (id, slug, display_name, path, registered_at, template_name)
       VALUES ('proj-bf4', 'pbf4', 'Existing WF Project', '/bf4', '2026-01-01', 'product-development')`
    ).run();

    // Create an existing workflow and assign it to a ticket before backfill
    db.prepare(
      `INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at)
       VALUES ('wf-existing', 'proj-bf4', 'Existing Workflow', 'product-development', 1, '2026-01-01', '2026-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-bf4', 1)`
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id)
       VALUES ('t-bf4', 'proj-bf4', 'Already linked', 'Backlog', '2026-01-01', '2026-01-01', 'wf-existing')`
    ).run();

    runBackfillV13(db);

    // Ticket should still have the original workflow_id
    const ticket = db
      .prepare("SELECT workflow_id FROM tickets WHERE id = 't-bf4'")
      .get() as { workflow_id: string };
    assert.equal(ticket.workflow_id, 'wf-existing', 'should not overwrite existing workflow_id');

    // Exactly one project_workflows row must exist — no duplicate is_default=1 rows
    const workflows = db
      .prepare("SELECT * FROM project_workflows WHERE project_id = 'proj-bf4'")
      .all() as unknown[];
    assert.equal(workflows.length, 1, 'should not create a duplicate workflow row');
  });

  it('uses pre-existing is_default=1 workflow (non-Default name) for backfill, does not create extra row', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    rebuildTicketsAsLegacyV17(db);

    db.prepare(
      `INSERT INTO projects (id, slug, display_name, path, registered_at, template_name)
       VALUES ('proj-bf5', 'pbf5', 'Named Default Project', '/bf5', '2026-01-01', 'product-development')`
    ).run();

    // Pre-existing workflow with is_default=1 but a non-'Default' name
    db.prepare(
      `INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at)
       VALUES ('wf-named', 'proj-bf5', 'My Workflow', 'product-development', 1, '2026-01-01', '2026-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-bf5', 1)`
    ).run();
    // Ticket with no workflow_id yet
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at)
       VALUES ('t-bf5', 'proj-bf5', 'Unlinked Ticket', 'Backlog', '2026-01-01', '2026-01-01')`
    ).run();

    runBackfillV13(db);

    // Ticket should be assigned to the pre-existing default workflow (not a new 'Default' row)
    const ticket = db
      .prepare("SELECT workflow_id FROM tickets WHERE id = 't-bf5'")
      .get() as { workflow_id: string };
    assert.equal(ticket.workflow_id, 'wf-named', 'ticket should be linked to the pre-existing is_default=1 workflow');

    // Exactly one project_workflows row must exist — no new 'Default' row should have been inserted
    const workflows = db
      .prepare("SELECT * FROM project_workflows WHERE project_id = 'proj-bf5'")
      .all() as unknown[];
    assert.equal(workflows.length, 1, 'should not create a new Default row when is_default=1 already exists');
  });

  it('handles multiple projects independently', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.prepare(
      `INSERT INTO projects (id, slug, display_name, path, registered_at, template_name)
       VALUES ('proj-m1', 'pm1', 'Multi Project 1', '/m1', '2026-01-01', 'product-development')`
    ).run();
    db.prepare(
      `INSERT INTO projects (id, slug, display_name, path, registered_at, template_name)
       VALUES ('proj-m2', 'pm2', 'Multi Project 2', '/m2', '2026-01-01', 'custom-template')`
    ).run();

    runBackfillV13(db);

    const wf1 = db
      .prepare("SELECT * FROM project_workflows WHERE project_id = 'proj-m1'")
      .get() as { template_name: string; is_default: number } | undefined;
    const wf2 = db
      .prepare("SELECT * FROM project_workflows WHERE project_id = 'proj-m2'")
      .get() as { template_name: string; is_default: number } | undefined;

    assert.ok(wf1, 'project 1 should have a workflow');
    assert.ok(wf2, 'project 2 should have a workflow');
    assert.equal(wf1.template_name, 'product-development');
    assert.equal(wf2.template_name, 'custom-template');
    assert.equal(wf1.is_default, 1);
    assert.equal(wf2.is_default, 1);
  });
});

describe('V21 migration - brainstorm-ticket linkage', () => {
  it('adds brainstorm_id column to tickets', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const cols = db.pragma('table_info(tickets)') as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    assert.ok(colNames.has('brainstorm_id'), 'tickets table should have brainstorm_id column');
  });

  it('adds plan_summary column to brainstorms', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const cols = db.pragma('table_info(brainstorms)') as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    assert.ok(colNames.has('plan_summary'), 'brainstorms table should have plan_summary column');
  });

  it('backfills brainstorm_id from brainstorm.created_ticket_id', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-v21','pv21','V21 Project','/v21','2026-03-18')"
    );
    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf-v21','proj-v21','Default','product-development',1,'2026-03-18','2026-03-18')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v21', 1)"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-v21','proj-v21','Ticket V21','Ideas','2026-03-18','2026-03-18','wf-v21')"
    );
    db.exec(
      "INSERT INTO conversations (id, project_id, created_at, updated_at) VALUES ('conv-v21','proj-v21','2026-03-18','2026-03-18')"
    );
    db.exec(
      "INSERT INTO brainstorms (id, project_id, name, status, created_at, updated_at, conversation_id, created_ticket_id) VALUES ('bs-v21','proj-v21','Brainstorm V21','active','2026-03-18','2026-03-18','conv-v21','t-v21')"
    );

    // Simulate running migration from v20 to pick up V21 backfill
    db.pragma('user_version = 20');
    runMigrations(db);

    const ticket = db
      .prepare("SELECT brainstorm_id FROM tickets WHERE id = 't-v21'")
      .get() as { brainstorm_id: string | null };
    assert.equal(ticket.brainstorm_id, 'bs-v21', 'ticket should have brainstorm_id backfilled from created_ticket_id');
  });

  it('handles multiple brainstorms pointing to the same ticket without error (LIMIT 1 safety)', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-v21-multi','pv21m','V21 Multi','/v21m','2026-03-18')"
    );
    db.exec(
      "INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf-v21-multi','proj-v21-multi','Default','product-development',1,'2026-03-18','2026-03-18')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v21-multi', 1)"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t-v21-multi','proj-v21-multi','Multi Ticket','Ideas','2026-03-18','2026-03-18','wf-v21-multi')"
    );
    db.exec(
      "INSERT INTO conversations (id, project_id, created_at, updated_at) VALUES ('conv-v21-ma','proj-v21-multi','2026-03-18','2026-03-18'), ('conv-v21-mb','proj-v21-multi','2026-03-18','2026-03-18')"
    );
    // Two brainstorms both pointing to the same ticket — the unsafe case LIMIT 1 guards against
    db.exec(
      "INSERT INTO brainstorms (id, project_id, name, status, created_at, updated_at, conversation_id, created_ticket_id) VALUES ('bs-v21-a','proj-v21-multi','Brainstorm A','active','2026-03-18','2026-03-18','conv-v21-ma','t-v21-multi')"
    );
    db.exec(
      "INSERT INTO brainstorms (id, project_id, name, status, created_at, updated_at, conversation_id, created_ticket_id) VALUES ('bs-v21-b','proj-v21-multi','Brainstorm B','active','2026-03-18','2026-03-18','conv-v21-mb','t-v21-multi')"
    );

    db.pragma('user_version = 20');
    // Must not throw "sub-select returns more than 1 row"
    assert.doesNotThrow(() => runMigrations(db), 'V21 backfill should not throw when multiple brainstorms share the same created_ticket_id');

    const ticket = db
      .prepare("SELECT brainstorm_id FROM tickets WHERE id = 't-v21-multi'")
      .get() as { brainstorm_id: string | null };
    assert.ok(
      ticket.brainstorm_id === 'bs-v21-a' || ticket.brainstorm_id === 'bs-v21-b',
      'ticket should have a brainstorm_id set to one of the two brainstorms'
    );
  });

  it('is idempotent — running V21 migration twice does not error', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    assert.doesNotThrow(() => runMigrations(db), 'running migrations again on V22 database should be safe');

    const version = db.pragma('user_version', { simple: true }) as number;
    assert.equal(version, 22);
  });

  it('schema version is 22', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const version = db.pragma('user_version', { simple: true }) as number;
    assert.equal(version, 22);
  });
});

describe('V22 migration - PM fields and board settings', () => {
  it('adds pm_enabled column to brainstorms', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = db.pragma('table_info(brainstorms)') as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    assert.ok(names.has('pm_enabled'), 'brainstorms table should have pm_enabled column');
  });

  it('creates board_settings table with workflow_id FK and pm_config column', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = db.pragma('table_info(board_settings)') as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    assert.ok(names.has('id'), 'board_settings should have id column');
    assert.ok(names.has('workflow_id'), 'board_settings should have workflow_id column');
    assert.ok(names.has('pm_config'), 'board_settings should have pm_config column');
    assert.ok(names.has('created_at'), 'board_settings should have created_at column');
    assert.ok(names.has('updated_at'), 'board_settings should have updated_at column');
  });

  it('creates index on board_settings.workflow_id', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const indexes = db.pragma('index_list(board_settings)') as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((idx) => idx.name));
    assert.ok(indexNames.has('idx_board_settings_workflow'), 'should have idx_board_settings_workflow index');
  });

  it('pm_enabled defaults to 0 for brainstorms', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    // Insert a project
    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-pm','pm-test','PM Test','/pm-test','2026-03-19')"
    );

    // Insert a brainstorm without pm_enabled
    const brainstormId = 'brain_pm_test';
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO brainstorms (id, project_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(brainstormId, 'proj-pm', 'Test Brainstorm', now, now);

    const row = db
      .prepare('SELECT pm_enabled FROM brainstorms WHERE id = ?')
      .get(brainstormId) as { pm_enabled: number };
    assert.equal(row.pm_enabled, 0);
  });

  it('is idempotent — running V22 migration twice does not error', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    assert.doesNotThrow(() => runMigrations(db), 'running migrations again on V22 database should be safe');

    const version = db.pragma('user_version', { simple: true }) as number;
    assert.equal(version, 22);
  });
});
