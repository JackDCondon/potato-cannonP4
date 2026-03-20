# Chat System Refactor Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Remove the global chat queue system and simplify ChatService by eliminating ~350 lines of dead/queue code, enabling multiple tickets to have concurrent outstanding questions.

**Architecture:** All outbound messages (questions and notifications) are sent directly to providers instead of through `ChatOrchestrator`. File-based IPC (`pending-question.json` / `pending-response.json`) is unchanged and continues to drive session resume. `TelegramProvider` thread routing migrates from a legacy filesystem scan to the existing `provider_channels` SQLite table.

**Tech Stack:** TypeScript, better-sqlite3, Node.js, Telegram Bot API

**Key Decisions:**
- **No queue at all (not even per-ticket):** Forum topics provide natural isolation — each ticket has its own Telegram thread, so multiple concurrent questions are routed cleanly without a global lock.
- **Sequential provider sends instead of `Promise.allSettled`:** Cheap rate-limit mitigation (Telegram: ~1 msg/sec per chat) without rebuilding a queue.
- **Delete `chat-threads.store.ts` entirely:** The `provider_channels` SQLite table already owns this data. The filesystem JSON files are legacy; load from DB at startup instead.
- **Singleton `chatService` remains for production:** DI constructor is added for testability; the singleton export is kept so callers don't change.
- **`reconcileWebAnswer` writes response file directly:** Previously delegated to orchestrator; now directly calls `writeResponse` like `handleResponse` does.

---

## Task 1: Add shared context-key utilities to `chat-provider.types.ts`

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/providers/chat-provider.types.ts`

**Purpose:** Extract `getContextKey` / `parseContextKey` that are currently duplicated between `ChatService` and `TelegramProvider`. Fix `parseContextKey` to split on the first `:` only. Remove `ChatThreadsFile` (dead after Task 4).

**Step 1: Write the failing test**

Add to `apps/daemon/src/providers/telegram/__tests__/telegram.provider.test.ts`:

```typescript
import { getContextKey, parseContextKey } from '../../chat-provider.types.js';

describe('context key utilities', () => {
  it('round-trips ticketId contexts', () => {
    const ctx = { projectId: 'proj', ticketId: 'TICK-1' };
    expect(parseContextKey(getContextKey(ctx))).toEqual({ projectId: 'proj', ticketId: 'TICK-1' });
  });

  it('round-trips brainstormId contexts', () => {
    const ctx = { projectId: 'proj', brainstormId: 'brain_abc' };
    expect(parseContextKey(getContextKey(ctx))).toEqual({ projectId: 'proj', brainstormId: 'brain_abc' });
  });

  it('handles project IDs that contain colons without breaking parseContextKey', () => {
    // Project ID with colon — split must be on first : only
    const ctx = { projectId: 'org:repo', ticketId: 'TICK-1' };
    expect(parseContextKey(getContextKey(ctx))).toEqual({ projectId: 'org:repo', ticketId: 'TICK-1' });
  });
});
```

**Step 2: Run test to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "context key utilities"
```
Expected: FAIL (functions don't exist yet)

**Step 3: Implement**

In `apps/daemon/src/providers/chat-provider.types.ts`, add after `ChatProvider`:

```typescript
/** Stable string key for a chat context — used for Maps and caches. */
export function getContextKey(context: ChatContext): string {
  return `${context.projectId}:${context.ticketId ?? context.brainstormId ?? ''}`;
}

/**
 * Parse a context key back to ChatContext.
 * Splits on the FIRST colon only, so projectIds containing colons are safe.
 */
export function parseContextKey(key: string): ChatContext | null {
  const idx = key.indexOf(':');
  if (idx === -1) return null;
  const projectId = key.slice(0, idx);
  const id = key.slice(idx + 1);
  if (!projectId || !id) return null;
  if (id.startsWith('brain_')) return { projectId, brainstormId: id };
  return { projectId, ticketId: id };
}
```

Remove the `ChatThreadsFile` interface (dead after Task 4).

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "context key utilities"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/providers/chat-provider.types.ts apps/daemon/src/providers/telegram/__tests__/telegram.provider.test.ts
git commit -m "refactor(chat): add shared getContextKey/parseContextKey utilities, fix colon-in-projectId bug"
```

---

## Task 2: DB migration V27 — drop chat_queue tables

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/server/routes/chat-telemetry.routes.ts`

**Purpose:** Drop `chat_queue_items` and `chat_delivery_events` tables which are no longer used once the queue is removed. Also update `chat-telemetry.routes.ts` which directly queries both tables — if left unchanged it will crash at runtime after the migration runs.

> **RISK NOTE — Version collision:** V26 already exists in the codebase (adds Perforce connection columns `p4_use_env_vars`, `p4_port`, `p4_user` to `projects`). The queue-drop migration MUST be V27. `CURRENT_SCHEMA_VERSION` is currently `26`; increment it to `27`.

> **RISK NOTE — Breaking route:** `apps/daemon/src/server/routes/chat-telemetry.routes.ts` issues five direct SQL queries against `chat_queue_items` and `chat_delivery_events`. After this migration those tables no longer exist, so the `/api/chat/telemetry` endpoint will throw on every request. This file must be updated in this task to return a stub response (zeros) instead of querying dropped tables.

**Step 1: Write the failing test**

In `apps/daemon/src/stores/__tests__/migrations.test.ts`, add:

```typescript
it('chat_queue_items table does not exist after V27 migration', () => {
  const result = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_queue_items'")
    .get();
  expect(result).toBeUndefined();
});

it('chat_delivery_events table does not exist after V27 migration', () => {
  const result = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_delivery_events'")
    .get();
  expect(result).toBeUndefined();
});
```

(Do NOT add to `chat-queue.store.test.ts` — that file is deleted in Task 13.)

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "chat_queue_items table does not exist"
```
Expected: FAIL (tables still exist at V26)

**Step 3: Implement**

In `apps/daemon/src/stores/migrations.ts`:
- Change `CURRENT_SCHEMA_VERSION` from `26` to `27`
- Add block:
```typescript
if (version < 27) {
  db.exec(`
    DROP TABLE IF EXISTS chat_delivery_events;
    DROP TABLE IF EXISTS chat_queue_items;
  `);
}
```

In `apps/daemon/src/server/routes/chat-telemetry.routes.ts`, replace `getChatTelemetrySnapshot()` implementation to return a zeroed stub (the tables no longer exist after migration):
```typescript
export function getChatTelemetrySnapshot(): ChatTelemetrySnapshot {
  return {
    queueDepth: 0,
    activeQuestion: null,
    providerEventCounts: [],
    perTicketQueueDepth: [],
    deadLetterCount: 0,
  };
}
```

Remove the `db` parameter and all SQLite queries from that function. The route handler in `registerChatTelemetryRoutes` does not need to change.

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "chat_queue_items table does not exist"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/stores/migrations.ts apps/daemon/src/server/routes/chat-telemetry.routes.ts
git commit -m "feat(db): V27 migration — drop chat_queue_items and chat_delivery_events tables; stub telemetry route"
```

---

## Task 3: Fix `chat.store.ts` — distinguish ENOENT from JSON parse errors

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/chat.store.ts`
- Test: `apps/daemon/src/stores/__tests__/chat.store.test.ts`

**Purpose:** `readQuestion` and `readResponse` currently swallow all errors including JSON parse failures from corrupted files. Only swallow `ENOENT`; log and rethrow parse errors.

**Step 1: Write the failing test**

Add to `apps/daemon/src/stores/__tests__/chat.store.test.ts`:

```typescript
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { TASKS_DIR } from '../../config/paths.js';

it('readQuestion throws on corrupted JSON, not null', async () => {
  const projectId = 'test-proj';
  const contextId = 'TICK-corrupt';
  // Write a corrupted file
  const dir = path.join(TASKS_DIR, projectId, contextId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'pending-question.json'), 'NOT JSON', 'utf-8');

  await expect(readQuestion(projectId, contextId)).rejects.toThrow();
});

it('readQuestion returns null when file does not exist', async () => {
  expect(await readQuestion('no-project', 'no-ticket')).toBeNull();
});
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "readQuestion throws on corrupted"
```
Expected: FAIL (currently swallows and returns null)

**Step 3: Implement**

In `apps/daemon/src/stores/chat.store.ts`, update `readQuestion` and `readResponse`:

```typescript
export async function readQuestion(
  projectId: string,
  contextId: string,
): Promise<PendingQuestion | null> {
  const questionPath = getQuestionPath(projectId, contextId);
  try {
    return JSON.parse(await fs.readFile(questionPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error(`[chat.store] Corrupted pending-question.json at ${questionPath}:`, err);
    throw err;
  }
}

export async function readResponse(
  projectId: string,
  contextId: string,
): Promise<PendingResponse | null> {
  const responsePath = getResponsePath(projectId, contextId);
  try {
    return JSON.parse(await fs.readFile(responsePath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error(`[chat.store] Corrupted pending-response.json at ${responsePath}:`, err);
    throw err;
  }
}
```

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "readQuestion"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/stores/chat.store.ts apps/daemon/src/stores/__tests__/chat.store.test.ts
git commit -m "fix(chat.store): only swallow ENOENT; log and rethrow JSON parse errors on corrupted files"
```

---

## Task 4: Migrate `TelegramProvider.loadThreadCache()` from filesystem to SQLite

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/providers/telegram/telegram.provider.ts`
- Test: `apps/daemon/src/providers/telegram/__tests__/telegram.provider.test.ts`

**Purpose:** Replace `scanAllChatThreads()` filesystem scan (from legacy `chat-threads.store.ts`) with a direct `ProviderChannelStore` query. This removes the filesystem dependency and makes the startup thread cache use the authoritative SQLite data. After this, `chat-threads.store.ts` has zero callers.

**Step 1: Write the failing test**

In `apps/daemon/src/providers/telegram/__tests__/telegram.provider.test.ts`:

```typescript
it('loadThreadCache reads from provider_channels table, not filesystem', async () => {
  // Seed provider_channels in test DB
  const store = createProviderChannelStore(db);
  store.createChannel({
    ticketId: 'TICK-1',
    providerId: 'telegram',
    channelId: '-1001',
    metadata: { chatId: '-1001', messageThreadId: 5 },
  });

  const provider = new TelegramProvider(db);
  provider._setConfigForTest({ botToken: 'x', forumGroupId: '-1001', userId: '123' });
  await provider.loadThreadCache();

  const thread = await provider.getThread({ projectId: 'proj', ticketId: 'TICK-1' });
  expect(thread).not.toBeNull();
  expect((thread!.metadata as any).messageThreadId).toBe(5);
});
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "loadThreadCache reads from provider_channels"
```
Expected: FAIL

**Step 3: Implement**

In `telegram.provider.ts`, replace `loadThreadCache()`:

```typescript
async loadThreadCache(): Promise<void> {
  const store = this.getProviderChannelStore();
  if (!store) return;

  const channels = store.listChannels({ providerId: this.id });
  let count = 0;
  let skipped = 0;

  for (const channel of channels) {
    const context: ChatContext = channel.ticketId
      ? { projectId: channel.projectId ?? '', ticketId: channel.ticketId }
      : { projectId: channel.projectId ?? '', brainstormId: channel.brainstormId ?? '' };

    const thread: ProviderThreadInfo = {
      providerId: this.id,
      threadId: channel.channelId,
      metadata: channel.metadata,
    };

    if (this.isThreadCompatibleWithConfig(thread)) {
      const cacheKey = getContextKey(context);
      this.threadCache.set(cacheKey, thread);
      // Also populate reverse lookup
      const meta = thread.metadata as TelegramThreadMetadata;
      if (meta?.chatId) {
        const reverseKey = meta.messageThreadId
          ? `${meta.chatId}:${meta.messageThreadId}`
          : meta.chatId;
        this.reverseThreadCache.set(reverseKey, cacheKey);
      }
      count++;
    } else {
      skipped++;
    }
  }

  if (count > 0) console.log(`[TelegramProvider] Loaded ${count} thread(s) from provider_channels`);
  if (skipped > 0) console.log(`[TelegramProvider] Skipped ${skipped} incompatible thread(s)`);
}
```

Also remove the `scanAllChatThreads` import at the top of the file.

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "loadThreadCache"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/providers/telegram/telegram.provider.ts apps/daemon/src/providers/telegram/__tests__/telegram.provider.test.ts
git commit -m "refactor(telegram): load thread cache from provider_channels SQLite table instead of filesystem scan"
```

---

## Task 5: Fix `TelegramProvider` — O(1) reverse cache, cache invalidation, `getContextKey` adoption

**Depends on:** Task 1, Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/providers/telegram/telegram.provider.ts`
- Test: `apps/daemon/src/providers/telegram/__tests__/telegram.provider.test.ts`

**Purpose:** Add O(1) reverse lookup Map, invalidate cache on `deleteThread`, replace private `getContextKey`/`parseContextKey` with the shared utilities from Task 1.

**Step 1: Write the failing tests**

```typescript
it('findContextByThread uses O(1) reverse lookup', async () => {
  // After createThread, immediate reverse lookup should work
  const provider = makeProvider();
  await provider.createThread({ projectId: 'proj', ticketId: 'TICK-2' }, 'My Ticket');
  // Simulate incoming message
  const ctx = await provider._findContextByThreadForTest('-1001', 5);
  expect(ctx?.ticketId).toBe('TICK-2');
});

it('deleteThread removes entry from thread cache', async () => {
  const provider = makeProvider();
  const thread = await provider.createThread({ projectId: 'proj', ticketId: 'TICK-3' }, 'Test');
  await provider.deleteThread(thread);
  const found = await provider.getThread({ projectId: 'proj', ticketId: 'TICK-3' });
  expect(found).toBeNull();
});
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "reverse lookup|deleteThread removes"
```
Expected: FAIL

**Step 3: Implement**

In `telegram.provider.ts`:

1. Add `private reverseThreadCache: Map<string, string> = new Map();` (maps `"chatId:threadId"` → context key)

2. In `createThread()`, after `this.threadCache.set(cacheKey, thread)`, add:
```typescript
const reverseKey = meta.messageThreadId ? `${meta.chatId}:${meta.messageThreadId}` : meta.chatId;
this.reverseThreadCache.set(reverseKey, cacheKey);
```

3. Replace `findContextByThread()`:
```typescript
private findContextByThread(chatId: string, messageThreadId?: number): ChatContext | null {
  // O(1) reverse lookup
  const reverseKey = messageThreadId ? `${chatId}:${messageThreadId}` : chatId;
  const contextKey = this.reverseThreadCache.get(reverseKey);
  if (contextKey) {
    return parseContextKey(contextKey);
  }

  // DB fallback (rare — cache miss after restart before loadThreadCache populated this entry)
  const store = this.getProviderChannelStore();
  if (!store) return null;
  const channel = store.findChannelByProviderRoute(this.id, chatId, messageThreadId);
  if (!channel) return null;

  const ctx = channel.ticketId
    ? { projectId: channel.projectId ?? '', ticketId: channel.ticketId }
    : channel.brainstormId
    ? { projectId: channel.projectId ?? '', brainstormId: channel.brainstormId }
    : null;

  if (ctx) {
    // Warm caches for next time
    this.reverseThreadCache.set(reverseKey, getContextKey(ctx));
  }
  return ctx;
}
```

4. Update `deleteThread()` to also remove from both caches:
```typescript
async deleteThread(thread: ProviderThreadInfo): Promise<void> {
  const meta = thread.metadata as TelegramThreadMetadata;
  // Invalidate caches
  for (const [k, v] of this.threadCache.entries()) {
    if (v === thread) { this.threadCache.delete(k); break; }
  }
  if (meta?.chatId) {
    const reverseKey = meta.messageThreadId ? `${meta.chatId}:${meta.messageThreadId}` : meta.chatId;
    this.reverseThreadCache.delete(reverseKey);
  }
  // ... existing Telegram API delete call ...
}
```

5. Replace private `getContextKey`/`parseContextKey` methods with imports from `chat-provider.types.ts`.

6. Add test helper `_findContextByThreadForTest`.

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "reverse lookup|deleteThread removes"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/providers/telegram/telegram.provider.ts apps/daemon/src/providers/telegram/__tests__/telegram.provider.test.ts
git commit -m "fix(telegram): O(1) reverse thread cache, cache invalidation on delete, use shared context key utilities"
```

---

## Task 6: Strip dead code from `ChatService` — `ask()`, `pendingOptions`, idempotency cache

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/chat.service.ts`
- Delete: `apps/daemon/src/services/__tests__/chat.service.idempotency.test.ts`

**Purpose:** Remove the dead `ask()` method (170 lines), `pendingOptions` Map, `recentQuestions` Map, `isDuplicateQuestion`, `hashQuestion`, `cleanOldEntries`, `mapNumberedResponse` (only used by ask and mapAsyncResponseAnswer). Replace private `getContextKey` with the shared utility.

**Not In Scope:** Do not change `askAsync`, `notify`, `handleResponse`, or any other method yet.

**Step 1: Write the test (verify test file to delete is all ask()-related)**

Read `chat.service.idempotency.test.ts` to confirm it only tests `ask()`. If confirmed, mark for deletion. Add a smoke test that `chatService.ask` is no longer exported:

```typescript
// In apps/daemon/src/services/__tests__/chat.service.askAsync.test.ts, add:
it('chatService does not expose synchronous ask()', () => {
  expect(typeof (chatService as any).ask).toBe('undefined');
});
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "does not expose synchronous ask"
```
Expected: FAIL

**Step 3: Implement**

From `apps/daemon/src/services/chat.service.ts`, remove:
- `ask()` method (lines ~94-260)
- `private pendingOptions: Map<string, string[]>` field
- `private recentQuestions: Map<string, ...>` field
- `private readonly IDEMPOTENCY_WINDOW_MS` constant
- `isDuplicateQuestion()` private method
- `hashQuestion()` private method
- `cleanOldEntries()` private method
- `mapNumberedResponse()` private method
- Import of `createWaitController` / `waitForResponse` (if only used by `ask()`)
- Replace `this.getContextKey(context)` calls with `getContextKey(context)` from shared utility
- Remove private `getContextKey()` method

In `mapAsyncResponseAnswer`, the final fallback `return this.mapNumberedResponse(contextKey, answer)` — replace with inline logic or remove if redundant (it was just numeric parse already covered by the earlier check):
```typescript
// Last fallback: plain numbered response
if (pendingOptions && pendingOptions.length > 0) {
  const numeric = parseInt(answer.trim(), 10);
  if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= pendingOptions.length) {
    return pendingOptions[numeric - 1];
  }
}
return answer;
```

Delete `apps/daemon/src/services/__tests__/chat.service.idempotency.test.ts`.

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "does not expose synchronous ask"
```
Expected: PASS

Also run full daemon tests to confirm nothing broke:
```
cd apps/daemon && pnpm test
```

**Step 5: Commit**
```
git add apps/daemon/src/services/chat.service.ts
git rm apps/daemon/src/services/__tests__/chat.service.idempotency.test.ts
git commit -m "refactor(chat): delete dead ask() method and associated idempotency cache (~200 lines removed)"
```

---

## Task 7: Simplify `askAsync()` and `notify()` — direct provider sends

**Depends on:** Task 6
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/chat.service.ts`
- Modify: `apps/daemon/src/services/__tests__/chat.service.askAsync.test.ts`

**Purpose:** Remove `this.getOrchestrator().enqueueQuestion()` and `this.getOrchestrator().enqueueNotification()` calls. Send directly to providers using the existing `sendToProvider()` private method with sequential iteration.

**Step 1: Write the failing test**

In `apps/daemon/src/services/__tests__/chat.service.askAsync.test.ts`:

```typescript
it('askAsync sends directly to provider without queueing', async () => {
  const sendCalls: string[] = [];
  const mockProvider = {
    id: 'mock',
    name: 'Mock',
    capabilities: { threads: false, buttons: false, formatting: 'plain' },
    initialize: async () => {},
    shutdown: async () => {},
    createThread: async () => ({ providerId: 'mock', threadId: 't1' }),
    getThread: async () => ({ providerId: 'mock', threadId: 't1', metadata: {} }),
    send: async (_: unknown, msg: { text: string }) => { sendCalls.push(msg.text); },
    notifyAnswered: async () => {},
  };
  service.registerProvider(mockProvider as any);

  await service.askAsync({ projectId: 'p', ticketId: 'TICK-1' }, 'Are you ready?');
  expect(sendCalls).toHaveLength(1);
  expect(sendCalls[0]).toContain('Are you ready?');
});

it('notify sends directly to provider without queueing', async () => {
  const sendCalls: string[] = [];
  // ... similar mock setup ...
  await service.notify({ projectId: 'p', ticketId: 'TICK-1' }, 'Build complete');
  expect(sendCalls).toHaveLength(1);
});
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "askAsync sends directly|notify sends directly"
```
Expected: FAIL (enqueues, doesn't send immediately)

**Step 3: Implement**

In `askAsync()`, replace the `await this.getOrchestrator().enqueueQuestion(...)` call (currently the last line before return) with:
```typescript
// Send directly to providers — no queue
await this.sendToProviders(context, {
  text: question,
  options,
  questionId: logicalQuestionId,
  phase,
  kind: 'question',
});
```

In `notify()`, replace `await this.getOrchestrator().enqueueNotification(...)` with:
```typescript
// Send directly to providers — no queue
await this.sendToProviders(context, {
  text: message,
  kind: 'notification',
});
```

Add private `sendToProviders` helper (sequential to avoid Telegram rate limits):
```typescript
private async sendToProviders(context: ChatContext, message: OutboundMessage): Promise<void> {
  const providers = this.getActiveProviders();
  for (const provider of providers) {
    try {
      await this.sendToProvider(provider, context, message);
    } catch (err) {
      console.warn(
        `[ChatService] Provider ${provider.id} send failed for ${this.getContextId(context)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
```

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "askAsync sends directly|notify sends directly"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/services/chat.service.ts apps/daemon/src/services/__tests__/chat.service.askAsync.test.ts
git commit -m "feat(chat): askAsync and notify send directly to providers, removing global queue"
```

---

## Task 8: Fix `handleResponse()` — remove orchestrator call, rename shadowed variable

**Depends on:** Task 7
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/chat.service.ts`

**Purpose:** Remove `orchestrator.resolveQuestion()` call (queue-only). Rename the inner `pendingQuestion` variable to `pendingConversationMessage` to fix the shadowing bug.

**Step 1: Write the test**

```typescript
// In chat.service.askAsync.test.ts:
it('handleResponse does not require orchestrator', async () => {
  // Create a service with NO orchestrator injected
  const svc = new ChatService();
  // Write a pending question file
  await writeQuestion('p', 'TICK-1', {
    conversationId: 'conv1', questionId: 'q1', question: 'Test?',
    options: null, askedAt: new Date().toISOString(),
  });
  // handleResponse should succeed without throwing
  const result = await svc.handleResponse('web', { projectId: 'p', ticketId: 'TICK-1' }, 'Yes');
  expect(result).toBe(true);
});
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "handleResponse does not require orchestrator"
```
Expected: FAIL (currently calls `this.getOrchestrator()`)

**Step 3: Implement**

In `handleResponse()`:
1. Remove the `await this.getOrchestrator().resolveQuestion(...)` block (~lines 431-438)
2. Rename `const pendingQuestion = getPendingQuestion(conversationId)` on line ~443 to `const pendingConversationMessage = getPendingQuestion(conversationId)`
3. Update all references to use `pendingConversationMessage`

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "handleResponse does not require orchestrator"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/services/chat.service.ts
git commit -m "fix(chat): remove orchestrator from handleResponse, rename shadowed pendingQuestion variable"
```

---

## Task 9: Fix `reconcileWebAnswer()` — write response directly

**Depends on:** Task 8
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/chat.service.ts`
- Modify: `apps/daemon/src/server/__tests__/ticket-input.routes.test.ts`

**Purpose:** `reconcileWebAnswer()` currently delegates entirely to `orchestrator.resolveQuestion()`. Replace with direct `writeResponse` call + conversation store update, matching `handleResponse` behavior. The return type `{ accepted, stale, found }` is preserved.

**Not In Scope:** Do not change the route handlers that call `reconcileWebAnswer` — the signature is unchanged.

**Step 1: Write the test**

```typescript
it('reconcileWebAnswer writes response file directly', async () => {
  await writeQuestion('p', 'TICK-2', {
    conversationId: 'conv2', questionId: 'q2', question: 'Pick one?',
    options: ['A', 'B'], askedAt: new Date().toISOString(),
  });

  const result = await service.reconcileWebAnswer(
    { projectId: 'p', ticketId: 'TICK-2' },
    'q2',
    'A'
  );

  expect(result.accepted).toBe(true);
  expect(result.stale).toBe(false);

  const response = await readResponse('p', 'TICK-2');
  expect(response?.answer).toBe('A');
});
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "reconcileWebAnswer writes response"
```
Expected: FAIL

**Step 3: Implement**

Replace `reconcileWebAnswer()`:

```typescript
async reconcileWebAnswer(
  context: ChatContext,
  questionId: string,
  answer: string,
): Promise<{ accepted: boolean; stale: boolean; found: boolean }> {
  const contextId = this.getContextId(context);
  const pendingQuestion = await readQuestion(context.projectId, contextId);

  if (!pendingQuestion) {
    return { accepted: false, stale: true, found: false };
  }

  if (pendingQuestion.questionId && pendingQuestion.questionId !== questionId) {
    return { accepted: false, stale: true, found: true };
  }

  const mappedAnswer = this.mapAsyncResponseAnswer(
    getContextKey(context),
    answer,
    pendingQuestion.options,
  );

  await writeResponse(context.projectId, contextId, {
    answer: mappedAnswer,
    questionId: pendingQuestion.questionId,
    ticketGeneration: pendingQuestion.ticketGeneration,
  });

  // Update conversation store
  const conversationId = this.getConversationId(context);
  if (conversationId) {
    const pendingConversationMessage = getPendingQuestion(conversationId);
    if (pendingConversationMessage) {
      answerQuestion(pendingConversationMessage.id);
      addMessage(conversationId, {
        type: 'user',
        text: mappedAnswer,
        metadata: this.createConversationMetadata(context, 'user'),
      });
    }
  }

  return { accepted: true, stale: false, found: true };
}
```

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "reconcileWebAnswer"
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/services/chat.service.ts
git commit -m "fix(chat): reconcileWebAnswer writes response file directly, no longer needs orchestrator"
```

---

## Task 10: Simplify `cleanupTicketLifecycle()` + delete queue-only methods

**Depends on:** Task 9
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/chat.service.ts`
- Delete: `apps/daemon/src/services/__tests__/chat.service.prune.test.ts`

**Purpose:** Remove queue cancellation from `cleanupTicketLifecycle()`. Delete `pruneTicketQueueAfterSessionEnd()`, `pruneIrrelevantTicketQueue()`, `recoverQueuedChat()`, and `getOrchestrator()`.

**Step 1: Write the test**

```typescript
it('cleanupTicketLifecycle does not reference queue store', async () => {
  // Ensure method exists and runs without DB chat_queue table (dropped in V27)
  const result = await service.cleanupTicketLifecycle('proj', 'TICK-X');
  // Result should not have queueCancelled
  expect(result).not.toHaveProperty('queueCancelled');
  expect(result).toHaveProperty('routesRemoved');
  expect(result).toHaveProperty('threadDeletesAttempted');
});
```

**Step 2: Run to verify failure**
```
cd apps/daemon && pnpm test -- --test-name-pattern "cleanupTicketLifecycle does not reference queue"
```
Expected: FAIL

**Step 3: Implement**

In `cleanupTicketLifecycle()`:
- Remove `createChatQueueStore` import
- Remove `queueStore.cancelOpenItemsForTicket(...)` block
- Remove `if (queueCancelled > 0) { await this.getOrchestrator().tickQueue(); }` block
- Change return type to remove `queueCancelled`

Delete methods: `pruneTicketQueueAfterSessionEnd`, `pruneIrrelevantTicketQueue`, `recoverQueuedChat`, `getOrchestrator`, and `pruneIrrelevantTicketQueue` helper.

Remove imports: `createChatQueueStore`, `ChatOrchestrator`, `getActiveSessionForTicket` (if only used by prune).

Delete `apps/daemon/src/services/__tests__/chat.service.prune.test.ts`.

**Step 4: Run test to verify pass**
```
cd apps/daemon && pnpm test -- --test-name-pattern "cleanupTicketLifecycle does not reference queue"
```
Expected: PASS

Run full suite:
```
cd apps/daemon && pnpm test
```

**Step 5: Commit**
```
git add apps/daemon/src/services/chat.service.ts
git rm apps/daemon/src/services/__tests__/chat.service.prune.test.ts
git commit -m "refactor(chat): remove queue-only methods from ChatService (prune*, recoverQueuedChat, getOrchestrator)"
```

---

## Task 11: Update `server.ts` — remove queue startup recovery calls

**Depends on:** Task 10
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/server/server.ts`

**Purpose:** Remove `pruneIrrelevantTicketQueue` and `recoverQueuedChat` calls from daemon startup. Remove `pruneTicketQueueAfterSessionEnd` from the session-end handler.

**Not In Scope:** Do not change any other startup logic or session handling.

**Step 1: Read and locate the three call sites**

Verify these lines in `server.ts`:
- Line ~770: `chatService.pruneTicketQueueAfterSessionEnd(projectId, ticketId)`
- Line ~1281: `chatService.pruneIrrelevantTicketQueue({ preservePendingInteraction: true })`
- Line ~1291: `chatService.recoverQueuedChat()`

**Step 2: Write the test**

This is tested implicitly — TypeScript compilation fails if the deleted methods are still called:
```
cd apps/daemon && pnpm typecheck
```
Expected: Errors referencing deleted methods

**Step 3: Implement**

Remove:
1. The `pruneTicketQueueAfterSessionEnd` call and its `if (cleanup.cancelled > 0)` logging block in the session-end handler
2. The `pruneIrrelevantTicketQueue` call and its `if (queuePrune.cancelled > 0)` logging block in startup
3. The `recoverQueuedChat()` call and its comment in startup

**Step 4: Verify**
```
cd apps/daemon && pnpm typecheck
```
Expected: No errors related to deleted methods

```
cd apps/daemon && pnpm test
```
Expected: All pass

**Step 5: Commit**
```
git add apps/daemon/src/server/server.ts
git commit -m "refactor(server): remove queue recovery and prune calls from startup and session-end handlers"
```

---

## Task 12: Extract `emitChatEvent` helper in `ChatService`

**Depends on:** Task 11
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/chat.service.ts`

**Purpose:** The `ticket:message` / `brainstorm:message` SSE emission pattern is copy-pasted 6 times. Extract a `private emitChatEvent()` helper.

**Step 1: No new test needed** — this is a pure refactor with no behavior change. Existing tests cover it.

**Step 2: Run existing tests to establish baseline**
```
cd apps/daemon && pnpm test -- --test-name-pattern "ChatService"
```
Expected: All PASS

**Step 3: Implement**

Add to `ChatService`:
```typescript
private emitChatEvent(
  context: ChatContext,
  message: { type: string; text: string; options?: string[]; timestamp: string },
): void {
  if (context.ticketId) {
    eventBus.emit('ticket:message', {
      projectId: context.projectId,
      ticketId: context.ticketId,
      message,
    });
  }
  if (context.brainstormId) {
    eventBus.emit('brainstorm:message', {
      projectId: context.projectId,
      brainstormId: context.brainstormId,
      message,
    });
  }
}
```

Replace all 6 copy-paste occurrences in `askAsync`, `notify`, `handleResponse` with `this.emitChatEvent(context, { ... })`.

**Step 4: Run tests to verify no regression**
```
cd apps/daemon && pnpm test
```
Expected: All PASS

**Step 5: Commit**
```
git add apps/daemon/src/services/chat.service.ts
git commit -m "refactor(chat): extract emitChatEvent helper, remove 6x copy-paste SSE emission"
```

---

## Task 13: Delete dead files — orchestrator, routing service, queue store, chat-threads store

**Depends on:** Task 12
**Complexity:** simple
**Files:**
- Delete: `apps/daemon/src/services/chat/chat-orchestrator.ts`
- Delete: `apps/daemon/src/services/chat/chat-routing.service.ts`
- Delete: `apps/daemon/src/stores/chat-queue.store.ts`
- Delete: `apps/daemon/src/stores/chat-threads.store.ts`
- Delete: `apps/daemon/src/services/__tests__/chat.orchestrator.test.ts`
- Delete: `apps/daemon/src/stores/__tests__/chat-queue.store.test.ts`

**Purpose:** Remove all deleted-but-not-yet-gone files now that all callers have been removed. TypeScript compilation will catch any missed references.

**Step 1: Verify zero callers before deletion**
```
cd apps/daemon && grep -r "chat-orchestrator\|chat-routing\.service\|chat-queue\.store\|chat-threads\.store" src/ --include="*.ts" -l
```
Expected: No output (or only the files themselves)

**Step 2: Delete files**
```
git rm apps/daemon/src/services/chat/chat-orchestrator.ts
git rm apps/daemon/src/services/chat/chat-routing.service.ts
git rm apps/daemon/src/stores/chat-queue.store.ts
git rm apps/daemon/src/stores/chat-threads.store.ts
git rm apps/daemon/src/services/__tests__/chat.orchestrator.test.ts
git rm apps/daemon/src/stores/__tests__/chat-queue.store.test.ts
```

**Step 3: Typecheck**
```
cd apps/daemon && pnpm typecheck
```
Expected: PASS

**Step 4: Run full suite**
```
cd apps/daemon && pnpm test
```
Expected: All PASS

**Step 5: Commit**
```
git commit -m "refactor(chat): delete ChatOrchestrator, ChatRoutingService, chat-queue.store, chat-threads.store and their tests"
```

---

## Task 14: Update documentation — remove ChatOrchestrator and queue references

**Depends on:** Task 13
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/session/CLAUDE.md` (remove ChatOrchestrator references if present)
- Modify: `apps/daemon/src/mcp/CLAUDE.md` (remove queue-related descriptions if present)
- Modify: `CLAUDE.md` (root) — update any architecture/data-flow descriptions referencing the queue or ChatOrchestrator

**Purpose:** After deleting ChatOrchestrator, ChatRoutingService, and the queue stores, any documentation referencing these components becomes stale. Update sub-docs to reflect the simplified direct-send architecture.

**Step 1: Find stale references**
```
grep -r "ChatOrchestrator\|chat-queue\|chat-threads\|ChatRoutingService\|enqueueQuestion\|enqueueNotification" docs/ apps/daemon/src --include="*.md" -l
```

**Step 2: Update each file found**

For each file, remove or rewrite sentences/sections that describe:
- The global queue and delivery pipeline
- `ChatOrchestrator` as an intermediary
- `chat-threads.store.ts` as a separate filesystem store
- `scanAllChatThreads` filesystem scan

Replace with accurate description:
- `askAsync` and `notify` send directly to providers sequentially
- Thread routing uses `provider_channels` SQLite table loaded at startup

**Step 3: Verify no stale references remain**
```
grep -r "ChatOrchestrator\|chat-queue\|chat-threads\|ChatRoutingService" docs/ apps/daemon/src --include="*.md"
```
Expected: No output

**Step 4: Commit**
```
git add docs/ apps/daemon/src --include="*.md"
git commit -m "docs: update architecture docs to reflect queue removal and direct provider sends"
```

---

## Task 15: Final validation — full test suite + typecheck

**Depends on:** Task 14
**Complexity:** simple
**Files:** None (validation only)

**Purpose:** Confirm no regressions, verify ChatService line count reduction.

**Step 1: Full typecheck**
```
pnpm typecheck
```
Expected: PASS

**Step 2: Full test suite**
```
pnpm test
```
Expected: All PASS

**Step 3: Verify ChatService line count**
```
wc -l apps/daemon/src/services/chat.service.ts
```
Expected: Under 500 lines (from ~885)

**Step 4: Verify no dead imports remain**
```
cd apps/daemon && grep -n "ChatOrchestrator\|chat-queue\|chat-threads\|ChatRoutingService\|scanAllChatThreads" src/ -r --include="*.ts"
```
Expected: No output

---

## Dependency Graph

```
Task 1 (context key utilities)
  ├── Task 4 (TelegramProvider loadThreadCache)
  │     └── Task 5 (TelegramProvider cache fixes)
  └── Task 6 (strip dead ChatService code)
        └── Task 7 (askAsync/notify direct sends)
              └── Task 8 (handleResponse fix)
                    └── Task 9 (reconcileWebAnswer fix)
                          └── Task 10 (cleanupTicketLifecycle + delete queue methods)
                                └── Task 11 (server.ts cleanup)
                                      └── Task 12 (emitChatEvent helper)
                                            └── Task 13 (delete dead files)
                                                  └── Task 14 (documentation updates)
                                                        └── Task 15 (final validation)

Task 2 (DB migration V27) — independent, no deps
Task 3 (chat.store error handling) — independent, no deps
```

Tasks 2, 3, 4, 5, 6 can be parallelized. Tasks 7-15 are sequential.

---

## What Is NOT In Scope

- Changing the MCP tool interface (`chat_ask`, `chat_notify`, `chat_init`)
- Modifying file-based IPC (`pending-question.json`, `pending-response.json`)
- Adding Slack provider changes (not present in codebase)
- Changing the session resume mechanism
- Frontend changes (queue status displays, if any)
- Adding Telegram type definitions with a schema validator (noted as improvement but not required for correctness)

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | ✓ | All stated requirements addressed — queue removal, provider-direct sends, TelegramProvider migration, dead code deletion, and validation covered across all tasks. |
| Accurate | ✓ | All referenced files verified to exist. One fix: missing `TASKS_DIR` import in Task 3 test snippet corrected. |
| Commands valid | ✓ | All commands use `cd apps/daemon && pnpm test` with `--test-name-pattern` flags valid for Node test runner. |
| YAGNI | ✓ | Every task directly serves the goal of removing the queue and simplifying ChatService. No speculative features. |
| Minimal | ✓ | Tasks appropriately scoped; none could be removed without losing a stated requirement. |
| Not over-engineered | ✓ | Straightforward approach: replace orchestrator calls with direct sends, delete dead code, migrate one data source. |
| Key Decisions documented | ✓ | 5 decisions with rationale in header (no queue, sequential sends, delete chat-threads store, keep singleton, reconcileWebAnswer direct write). |
| Context sections present | ✓ | Non-obvious tasks have Purpose sections; Tasks 6 and 9 have explicit Not In Scope sections. |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | CLEAN | 0 | All required sections present, every deliverable maps to a numbered task, dependencies explicitly graphed including parallel execution guidance. |
| Feasibility | CLEAN | 0 | All 18 file paths verified, all referenced methods and types confirmed present, schema version at 25 (V26/V27 migration target correct), test command syntax valid for Node v24. |
| Completeness | EDITED | 2 | Added Task 14 to audit and update stale CLAUDE.md docs referencing ChatOrchestrator and the queue pipeline; renumbered final validation to Task 15 and updated dependency graph. |
| Risk | EDITED | 3 | Fixed migration version to V27 (V26 already taken by Perforce columns); added `chat-telemetry.routes.ts` stub to Task 2 (route queries the tables being dropped, would cause runtime crash). |
| Optimality | EDITED | 1 | Removed empty verification commit from Task 15 — validation run (typecheck + tests + grep checks) stands as the terminal step. |
