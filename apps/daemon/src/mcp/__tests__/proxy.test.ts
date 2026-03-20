import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set required env vars before importing proxy
process.env.POTATO_PROJECT_ID = 'test-project';

import { buildToolsUrl } from '../proxy.js';

test('buildToolsUrl includes agentSource and projectId as query params', () => {
  const url = buildToolsUrl('http://localhost:8443', 'agents/builder.md', 'proj-123');
  assert.ok(url.includes('agentSource=agents%2Fbuilder.md'));
  assert.ok(url.includes('projectId=proj-123'));
});

test('buildToolsUrl omits params when not provided', () => {
  const url = buildToolsUrl('http://localhost:8443', '', '');
  assert.ok(!url.includes('agentSource'));
  assert.ok(!url.includes('projectId'));
});
