import Database from 'better-sqlite3';
import { runMigrations, runBackfillV13 } from '../migrations.js';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

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

  it('workflow_id on tickets is nullable (existing tickets are not broken)', () => {
    db.exec(
      "INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('proj-legacy','pl','Legacy','/legacy','2026-01-01')"
    );
    db.exec(
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-legacy', 1)"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at) VALUES ('t-legacy','proj-legacy','Old Ticket','Backlog','2026-01-01','2026-01-01')"
    );
    const ticket = db
      .prepare("SELECT workflow_id FROM tickets WHERE id = 't-legacy'")
      .get() as { workflow_id: string | null };
    assert.equal(ticket.workflow_id, null, 'workflow_id should be null for pre-V13 tickets');
  });

  it('schema version is 16', () => {
    const version = db.pragma('user_version', { simple: true }) as number;
    assert.equal(version, 16);
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
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v16', 1)"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at) VALUES ('t-v16','proj-v16','Ticket V16','Ideas','2026-03-11','2026-03-11')"
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
      "INSERT INTO ticket_counters (project_id, next_number) VALUES ('proj-v16-legacy', 1)"
    );
    db.exec(
      "INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at) VALUES ('t-v16-legacy','proj-v16-legacy','Legacy Ticket','Ideas','2026-03-11','2026-03-11')"
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
