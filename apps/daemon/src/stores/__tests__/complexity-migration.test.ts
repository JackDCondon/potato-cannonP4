import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

describe('migration V12 complexity columns', () => {
  let db: Database.Database;
  before(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('tickets table has complexity column defaulting to standard', () => {
    db.exec("INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('p1','p1','P1','/p1', '2026-01-01')");
    db.exec("INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf1','p1','Default','product-development',1,'2026-01-01','2026-01-01')");
    db.exec("INSERT INTO ticket_counters (project_id, next_number) VALUES ('p1', 1)");
    db.exec("INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t1','p1','Test','Backlog','2026-01-01','2026-01-01','wf1')");
    const row = db.prepare("SELECT complexity FROM tickets WHERE id = 't1'").get() as { complexity: string };
    assert.equal(row.complexity, 'standard');
  });

  it('tasks table has complexity column defaulting to standard', () => {
    db.exec("INSERT OR IGNORE INTO projects (id, slug, display_name, path, registered_at) VALUES ('p1','p1','P1','/p1', '2026-01-01')");
    db.exec("INSERT OR IGNORE INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf1','p1','Default','product-development',1,'2026-01-01','2026-01-01')");
    db.exec("INSERT OR IGNORE INTO ticket_counters (project_id, next_number) VALUES ('p1', 1)");
    db.exec("INSERT OR IGNORE INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t1','p1','Test','Backlog','2026-01-01','2026-01-01','wf1')");
    db.exec("INSERT INTO tasks (id, ticket_id, display_number, phase, status, attempt_count, description, created_at, updated_at) VALUES ('task1','t1',1,'Build','pending',0,'Test task','2026-01-01','2026-01-01')");
    const row = db.prepare("SELECT complexity FROM tasks WHERE id = 'task1'").get() as { complexity: string };
    assert.equal(row.complexity, 'standard');
  });
});
