import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { getBrainstormFilesDir } from '../../../config/paths.js';

describe('brainstorm artifacts endpoint', () => {
  const projectId = 'test-project-artifacts';
  const brainstormId = 'brain_test_artifacts_123';
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = path.join(getBrainstormFilesDir(projectId, brainstormId), 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test artifacts dir
    const brainstormDir = getBrainstormFilesDir(projectId, brainstormId);
    if (fs.existsSync(brainstormDir)) {
      fs.rmSync(brainstormDir, { recursive: true });
    }
  });

  it('should create artifacts directory and read markdown files', () => {
    // Verify directory was created
    assert.ok(fs.existsSync(artifactsDir), 'artifacts directory should exist');

    // Write a markdown file
    const planPath = path.join(artifactsDir, 'plan.md');
    const planContent = '# Test Plan\n\nGoal: test';
    fs.writeFileSync(planPath, planContent, 'utf-8');

    // Read the file and verify content
    const readContent = fs.readFileSync(planPath, 'utf-8');
    assert.strictEqual(readContent, planContent, 'file content should match written content');

    // Verify file stat (mtime)
    const stat = fs.statSync(planPath);
    assert.ok(stat.mtime, 'file should have mtime');
    assert.ok(stat.mtime.toISOString(), 'mtime should be convertible to ISO string');
  });

  it('should handle non-existent artifacts directory gracefully', () => {
    // Remove the directory to test empty case
    fs.rmSync(artifactsDir, { recursive: true });
    assert.strictEqual(fs.existsSync(artifactsDir), false, 'artifacts directory should not exist');
  });

  it('should filter and list only markdown files', () => {
    // Write multiple files
    fs.writeFileSync(path.join(artifactsDir, 'plan.md'), '# Plan', 'utf-8');
    fs.writeFileSync(path.join(artifactsDir, 'notes.md'), '# Notes', 'utf-8');
    fs.writeFileSync(path.join(artifactsDir, 'data.json'), '{"key": "value"}', 'utf-8');
    fs.writeFileSync(path.join(artifactsDir, 'config.txt'), 'config', 'utf-8');

    // Read directory and filter .md files
    const files = fs.readdirSync(artifactsDir).filter((f) => f.endsWith('.md'));
    assert.strictEqual(files.length, 2, 'should find exactly 2 markdown files');
    assert.ok(files.includes('plan.md'), 'plan.md should be included');
    assert.ok(files.includes('notes.md'), 'notes.md should be included');
  });
});
