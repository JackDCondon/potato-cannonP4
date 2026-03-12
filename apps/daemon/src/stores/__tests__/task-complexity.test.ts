import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
import { createTaskStore } from '../task.store.js';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

describe('task store complexity', () => {
  let db: Database.Database;
  before(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.exec("INSERT INTO projects (id, slug, display_name, path, registered_at) VALUES ('p1','p1','P1','/p1','2026-01-01')");
    db.exec("INSERT INTO project_workflows (id, project_id, name, template_name, is_default, created_at, updated_at) VALUES ('wf1','p1','Default','product-development',1,'2026-01-01','2026-01-01')");
    db.exec("INSERT INTO ticket_counters (project_id, next_number) VALUES ('p1', 1)");
    db.exec("INSERT INTO tickets (id, project_id, title, phase, created_at, updated_at, workflow_id) VALUES ('t1','p1','Test','Build','2026-01-01','2026-01-01','wf1')");
  });

  it('creates task with default complexity standard', () => {
    const store = createTaskStore(db);
    const task = store.createTask('t1', 'Build', { description: 'Test task' });
    assert.equal(task.complexity, 'standard');
  });

  it('creates task with explicit complexity', () => {
    const store = createTaskStore(db);
    const task = store.createTask('t1', 'Build', { description: 'Complex task', complexity: 'complex' });
    assert.equal(task.complexity, 'complex');
  });
});
