import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
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

  it('schema version is 13', () => {
    const version = db.pragma('user_version', { simple: true }) as number;
    assert.equal(version, 13);
  });
});
