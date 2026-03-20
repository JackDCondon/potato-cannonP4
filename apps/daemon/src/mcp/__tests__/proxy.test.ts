import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set required env vars before importing proxy
process.env.POTATO_PROJECT_ID = 'test-project';
process.env.POTATO_AGENT_SOURCE = 'agents/builder.md';
process.env.POTATO_MCP_SCOPE = 'pm';

const { buildCallToolPayload, buildToolsUrl, getMcpServerName } = await import('../proxy.js');

test('buildToolsUrl includes agentSource, projectId, and mcpServer as query params', () => {
  const url = buildToolsUrl('http://localhost:8443', 'agents/builder.md', 'proj-123', 'pm');
  assert.ok(url.includes('agentSource=agents%2Fbuilder.md'));
  assert.ok(url.includes('projectId=proj-123'));
  assert.ok(url.includes('mcpServer=pm'));
});

test('buildToolsUrl omits params when not provided', () => {
  const url = buildToolsUrl('http://localhost:8443', '', '', 'ticket');
  assert.ok(!url.includes('agentSource'));
  assert.ok(!url.includes('projectId'));
  assert.ok(url.includes('mcpServer=ticket'));
});

test('buildCallToolPayload includes agentSource in MCP call context', () => {
  const payload = buildCallToolPayload('update_task_status', { taskId: 'task-10' });
  assert.equal(payload.context.agentSource, 'agents/builder.md');
  assert.equal(payload.tool, 'update_task_status');
});

test('getMcpServerName uses POTATO_MCP_SCOPE', () => {
  assert.equal(getMcpServerName(), 'potato-pm');
});
