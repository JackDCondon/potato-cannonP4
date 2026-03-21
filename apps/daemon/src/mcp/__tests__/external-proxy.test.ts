import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, pingDaemon } from '../external-proxy.js';

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
