# Chat System Refactor Design

**Date:** 2026-03-20
**Status:** Draft

## Problem

The chat messaging system has accumulated significant surface area:

- A global SQLite-backed queue (`chat_queue` table + `ChatOrchestrator`) serializes all outbound Telegram questions — one question at a time across ALL tickets. This means Ticket B cannot ask a question until Ticket A's question is answered.
- ~170 lines of dead `ask()` code that has zero callers (everything uses `askAsync`).
- `ChatRoutingService` — entire file, zero importers.
- Legacy file-based thread store (`chat-threads.store.ts`) superseded by `provider_channels` SQLite table but not yet removed.
- `pendingOptions` in-memory Map that leaks on daemon restart and is redundant (options are already persisted to disk).
- SSE event emission duplicated 6 times across the ChatService.
- `getContextKey` duplicated in both `ChatService` and `TelegramProvider`.
- Hidden bugs: shadowed variable in `handleResponse`, stale thread cache after cleanup, `parseContextKey` splits incorrectly on first `:`.
- `chatService` module-level singleton with direct `getDatabase()` calls makes unit testing impossible.

## Goal

Remove the queue entirely. All outbound messages (questions and notifications) send directly to providers. Multiple tickets can have simultaneous outstanding questions. Simplify ChatService to its essential responsibilities.

## What Changes

### Delete entirely
- `apps/daemon/src/services/chat/chat-orchestrator.ts`
- `apps/daemon/src/services/chat/chat-routing.service.ts`
- `apps/daemon/src/stores/chat-queue.store.ts`
- `apps/daemon/src/stores/chat-threads.store.ts` (legacy file-based store)
- DB migration: drop `chat_queue` table (add new migration version)

### Dead code removal from `ChatService`
- `ask()` — 170 lines, zero callers
- `isDuplicateQuestion()`, `hashQuestion()`, `cleanOldEntries()`, `recentQuestions` Map — only used by dead `ask()`
- `pruneTicketQueueAfterSessionEnd()` — queue-only
- `pruneIrrelevantTicketQueue()` — queue-only
- `recoverQueuedChat()` — queue-only
- `pendingOptions` Map — redundant with persisted options in `pending-question.json`

### Simplify `ChatService`

**`askAsync()`** becomes:
1. Persist question to file IPC (`writeQuestion`)
2. Add message to conversation store
3. Emit SSE events
4. Call `sendToProviders()` directly (no enqueue)
5. Return `{ status: 'pending', questionId }`

**`notify()`** becomes:
1. Add message to conversation store
2. Emit SSE events
3. Call `sendToProviders()` directly (no enqueue)

**`handleResponse()`** becomes:
1. Write response to file IPC (`writeResponse`)
2. Update conversation store (mark answered, add user message)
3. Emit SSE events
4. Notify other providers (cross-provider "already answered")
5. Remove the `orchestrator.resolveQuestion()` call

**`reconcileWebAnswer()`** becomes:
1. Write response to file IPC directly
2. Mark conversation question as answered
3. Emit SSE events
4. Return `{ accepted, stale, found }`

**`cleanupTicketLifecycle()`** becomes:
1. Delete provider channels (SQLite)
2. Delete provider threads (Telegram forum topics)
3. Remove the queue cancellation block entirely

### Extract shared helpers

```typescript
// Extract from 6 copy-paste occurrences
private emitChatEvent(context: ChatContext, message: { type: string; text: string; options?: string[]; timestamp: string }): void

// Extract to chat-provider.types.ts (used by both ChatService and TelegramProvider)
export function getContextKey(context: ChatContext): string
export function parseContextKey(key: string): ChatContext | null  // fix: split on first ':' only
```

### Fix `TelegramProvider`

**`loadThreadCache()`**: Replace `scanAllChatThreads()` filesystem scan with a direct query against `provider_channels` SQLite table via `ProviderChannelStore`. Remove the dependency on `chat-threads.store.ts`.

**Thread cache invalidation**: Add cache cleanup to `deleteThread()` so stale entries don't misroute incoming Telegram messages after ticket cleanup.

**`findContextByThread()`**: Add a reverse-lookup Map keyed by `"chatId:messageThreadId"` for O(1) lookup instead of O(n) cache scan. Combine the DB fallback into a single JOIN query.

**`parseContextKey()`**: Fix to split on the first `:` only — use `key.indexOf(":")` instead of `key.split(":")`.

**Type safety**: Define a `TelegramUpdate` interface with proper types for `callback_query` and `message` fields. Remove inline `unknown` casts in `handleUpdate`.

**Remove test backdoors**: Replace `_setConfigForTest` / `_injectApiForTest` with constructor injection.

### Fix `handleResponse` shadowed variable

Rename the inner `const pendingQuestion = getPendingQuestion(conversationId)` (line ~443) to `const pendingConversationMessage` to avoid shadowing the outer `pendingQuestion` from file IPC.

### Fix `readQuestion` / `readResponse` error handling

Catch `ENOENT` only. Log and rethrow JSON parse failures instead of silently returning `null`.

### Fix ChatService testability

- Accept `Database` (or store instances) through constructor rather than calling `getDatabase()` directly in methods
- Export a factory function `createChatService(db)` instead of a module-level singleton
- The existing `export const chatService = createChatService(getDatabase())` singleton can remain for the production path

### Rate limiting

With no queue, concurrent sends could hit Telegram's ~1 msg/sec per chat limit when multiple tickets fire simultaneously. Mitigate by sending to providers sequentially (not `Promise.allSettled`) in `sendToProviders`. No retry or backoff needed — occasional 429s from Telegram will surface as warnings.

```typescript
// Before (parallel):
await Promise.allSettled(providers.map(p => sendToProvider(p, context, message)))

// After (sequential):
for (const provider of providers) {
  try { await sendToProvider(provider, context, message) }
  catch (err) { console.warn(...) }
}
```

## What Does NOT Change

- File-based IPC (`pending-question.json`, `pending-response.json`) — session resume still uses these
- `conversation.store.ts` — message persistence unchanged
- `provider-channel.store.ts` — channel routing unchanged
- `TelegramPoller` — long polling unchanged
- `TelegramApi` — HTTP client unchanged
- MCP tool interface (`chat_ask`, `chat_notify`, `chat_init`) — unchanged
- Web UI answer flow — `reconcileWebAnswer` still exists, implementation changes

## Files Touched

| File | Change |
|------|--------|
| `services/chat.service.ts` | Major simplification — delete ~350 lines |
| `services/chat/chat-orchestrator.ts` | **Delete** |
| `services/chat/chat-routing.service.ts` | **Delete** |
| `stores/chat-queue.store.ts` | **Delete** |
| `stores/chat-threads.store.ts` | **Delete** |
| `stores/chat.store.ts` | Fix error handling in `readQuestion`/`readResponse` |
| `stores/migrations.ts` | Add migration to drop `chat_queue` table |
| `providers/chat-provider.types.ts` | Add `getContextKey`/`parseContextKey` utilities; remove `ChatThreadsFile` type |
| `providers/telegram/telegram.provider.ts` | Fix cache, fix `loadThreadCache`, fix `findContextByThread`, fix types, remove backdoors |
| `mcp/tools/chat.tools.ts` | No interface change; internal wiring update if needed |

## Risks

| Risk | Mitigation |
|------|-----------|
| Telegram rate limiting | Sequential provider sends; warn on 429 |
| Missing queue recovery after crash | Queue only held unsent messages; with direct sends, a crash between `askAsync` call and Telegram HTTP success means the question was already persisted to file IPC — session will re-ask on resume |
| Orphaned `chat_queue` DB rows in production | Migration drops the table cleanly |
| Legacy `chat-threads.json` files on disk | After migrating `loadThreadCache` to SQLite, old JSON files are ignored; document that they can be manually deleted |

## Success Criteria

- All tests pass
- Multiple tickets can simultaneously have an outstanding question in Telegram (manual verify)
- Daemon restart does not lose pending questions (file IPC persists them)
- `ChatService` is under 400 lines (from ~885)
- Zero references to `ChatOrchestrator`, `chat-queue`, or `chat-threads` remain
