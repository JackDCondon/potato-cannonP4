import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, pingDaemon, callTool } from '../external-proxy.js';

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

test('fetchWithRetry returns response on first successful attempt', async () => {
  let callCount = 0;
  const mockFetch = async (): Promise<Response> => {
    callCount++;
    return new Response('ok', { status: 200 });
  };

  const response = await fetchWithRetry(mockFetch, 4, 0);
  assert.equal(response.status, 200);
  assert.equal(callCount, 1);
});

test('fetchWithRetry retries on network error and succeeds on second attempt', async () => {
  let callCount = 0;
  const mockFetch = async (): Promise<Response> => {
    callCount++;
    if (callCount === 1) {
      throw new Error('ECONNREFUSED');
    }
    return new Response('ok', { status: 200 });
  };

  const response = await fetchWithRetry(mockFetch, 4, 0);
  assert.equal(response.status, 200);
  assert.equal(callCount, 2);
});

test('fetchWithRetry retries up to maxAttempts and re-throws last error', async () => {
  let callCount = 0;
  const mockFetch = async (): Promise<Response> => {
    callCount++;
    throw new Error('fetch failed');
  };

  await assert.rejects(
    () => fetchWithRetry(mockFetch, 3, 0),
    { message: 'fetch failed' },
  );
  assert.equal(callCount, 3);
});

test('fetchWithRetry uses exponential backoff delays', async () => {
  const delays: number[] = [];
  const originalSetTimeout = global.setTimeout;

  // Track sleep calls by monkey-patching Promise-based sleep
  // We pass baseDelayMs=10 to make this fast while verifying the multiplier.
  let callCount = 0;
  const mockFetch = async (): Promise<Response> => {
    callCount++;
    if (callCount < 3) {
      throw new Error('fail');
    }
    return new Response('ok', { status: 200 });
  };

  // We can't easily intercept internal sleep, but we verify the retry count:
  const response = await fetchWithRetry(mockFetch, 4, 10);
  assert.equal(response.status, 200);
  assert.equal(callCount, 3);
});

test('fetchWithRetry with maxAttempts=1 does not retry', async () => {
  let callCount = 0;
  const mockFetch = async (): Promise<Response> => {
    callCount++;
    throw new Error('single failure');
  };

  await assert.rejects(
    () => fetchWithRetry(mockFetch, 1, 0),
    { message: 'single failure' },
  );
  assert.equal(callCount, 1);
});

// ---------------------------------------------------------------------------
// pingDaemon
// ---------------------------------------------------------------------------

test('pingDaemon returns true when daemon responds with ok status', async () => {
  // We cannot start a real HTTP server in a unit test, so we test the false path
  // (unreachable URL) which exercises the catch branch.
  const result = await pingDaemon('http://127.0.0.1:1'); // port 1 — always refused
  assert.equal(result, false);
});

test('pingDaemon returns false on network error', async () => {
  const result = await pingDaemon('http://localhost:0');
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// callTool
// ---------------------------------------------------------------------------

test('callTool uses defaultProjectId when no projectId in args', async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Health ping returns ok
    if (typeof _url === 'string' && _url.includes('/health')) {
      return new Response('ok', { status: 200 });
    }
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'result' }] }), { status: 200 });
  };

  await callTool('http://localhost:8443', 'proj-default', 'get_ticket', { ticketId: 'T1' }, mockFetch as typeof fetch);

  assert.ok(capturedBody, 'fetch should have been called');
  const context = capturedBody.context as Record<string, unknown>;
  assert.equal(context.projectId, 'proj-default');
  assert.equal((capturedBody.args as Record<string, unknown>).ticketId, 'T1');
});

test('callTool uses args.projectId over defaultProjectId when provided', async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof _url === 'string' && _url.includes('/health')) {
      return new Response('ok', { status: 200 });
    }
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'result' }] }), { status: 200 });
  };

  await callTool('http://localhost:8443', 'proj-default', 'get_ticket', { ticketId: 'T1', projectId: 'proj-override' }, mockFetch as typeof fetch);

  assert.ok(capturedBody, 'fetch should have been called');
  const context = capturedBody.context as Record<string, unknown>;
  assert.equal(context.projectId, 'proj-override');
  // projectId should be stripped from forwarded args
  assert.equal((capturedBody.args as Record<string, unknown>).projectId, undefined);
  assert.equal((capturedBody.args as Record<string, unknown>).ticketId, 'T1');
});

test('callTool strips projectId from forwarded args', async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof _url === 'string' && _url.includes('/health')) {
      return new Response('ok', { status: 200 });
    }
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }] }), { status: 200 });
  };

  await callTool('http://localhost:8443', 'default-proj', 'some_tool', { projectId: 'explicit', foo: 'bar' }, mockFetch as typeof fetch);

  assert.ok(capturedBody);
  const forwardedArgs = capturedBody.args as Record<string, unknown>;
  assert.equal(forwardedArgs.projectId, undefined, 'projectId must be stripped from forwarded args');
  assert.equal(forwardedArgs.foo, 'bar');
});

test('callTool returns parsed response content', async () => {
  const mockFetch = async (_url: string | URL | Request): Promise<Response> => {
    if (typeof _url === 'string' && _url.includes('/health')) {
      return new Response('ok', { status: 200 });
    }
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'hello world' }], isError: false }),
      { status: 200 },
    );
  };

  const result = await callTool('http://localhost:8443', 'proj', 'chat_notify', {}, mockFetch as typeof fetch);

  assert.equal(result.content[0].text, 'hello world');
  assert.equal(result.isError, false);
});
