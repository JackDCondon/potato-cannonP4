# Central Chat Queue and Provider Routing Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Centralize Telegram and Slack chat orchestration so ticket questions are globally serialized, topic/thread routing is deterministic, web replies dequeue active questions immediately, and provider-specific code only handles transport quirks.

**Architecture:** Introduce a daemon-owned chat orchestration layer that sits above provider adapters and below `ChatService`. The orchestrator owns queueing, active-question locking, route resolution, provider fan-out, stale answer rejection, setup validation logging, and delivery telemetry. Telegram and Slack providers become thin adapters that translate platform events into provider-neutral route keys and outbound message payloads.

**Tech Stack:** Node/TypeScript daemon, SQLite migrations/stores, Express routes, existing conversation/chat stores, Telegram Bot API, Slack Web API + Socket Mode, existing daemon/frontend ticket activity flows.

**Key Decisions:**
- **One active question globally:** only one logical interactive question may wait on a user at a time, regardless of provider or ticket, to avoid overwhelming the user.
- **Notifications share infrastructure but not the lock:** non-blocking notifications go through the same queue/orchestrator path for consistency, but they do not acquire or hold the active-question gate.
- **`questionId` is the source of truth:** all answers from Telegram, Slack, and the web app reconcile against a single queue item/question identity; first valid answer wins, later answers become stale no-ops.
- **`provider_channels` becomes authoritative routing state:** use SQLite-backed provider routing records for reverse lookup and lifecycle cleanup; keep file-based thread metadata only as a temporary compatibility shadow if needed.
- **Providers stay thin:** Telegram/Slack adapters manage API formatting, callbacks, topic/thread identifiers, and inbound event parsing only; queueing, resumption, telemetry, and stale handling live centrally.
- **Setup validation is log-first for MVP:** Telegram capability/setup failures are written to daemon logs instead of blocking with new UI/API error surfaces.
- **Strong callback identity from day one:** button payloads must include compact `questionId` identity plus option index so stale taps cannot answer the wrong question.

---

## Scope Summary

In scope:
1. Central queue/orchestrator for interactive questions and notifications
2. Global active-question lock with FIFO queue semantics
3. Telegram forum topic lifecycle per ticket
4. Slack thread alignment to same route model
5. Web reply reconciliation that clears/removes queued chat questions
6. Inbound free-text and button routing to the correct ticket/topic/thread
7. Ticket activity population from all user responses
8. Delivery telemetry and daemon-log setup validation

Out of scope:
1. New frontend setup-validator UI
2. Rich queue-management dashboard in this first slice
3. Non-Telegram/Slack providers
4. Advanced timeout/escalation policies beyond a single configurable default
5. New brainstorm-specific topic lifecycle behavior beyond preserving current compatibility

---

## Functional Rules

The implementation must enforce these runtime rules:

1. A `question` queue item becomes the single active question when dispatched.
2. No later `question` item may be sent until the active question is resolved as `answered`, `cancelled`, `stale`, or `timed_out`.
3. A `notification` queue item is dispatched through the same orchestrator but never blocks the next item after delivery attempt completion.
4. A single logical question may fan out to both Telegram and Slack for the same ticket, but it is still one active queue item and one `questionId`.
5. A web-app reply to the active question must resolve the queue item immediately and prevent later chat-provider answers from being accepted.
6. A web-app reply to an unsent queued question must cancel/remove that queued item before it is ever dispatched.
7. Telegram inbound routing uses `chatId + message_thread_id`; Slack inbound routing uses `channel + thread_ts`.
8. Every accepted inbound answer must be written to conversation history and emitted as `ticket:message` so the ticket Activity tab stays authoritative.

---

## Proposed Architecture

### Core Services

1. `ChatOrchestrator`
- Owns enqueue, dequeue, active-question lock, retry/backoff, stale resolution, and provider fan-out.
- Provides one ingress path for:
  - `askAsync`
  - `notify`
  - Telegram inbound events
  - Slack inbound events
  - web `/api/tickets/:project/:id/input`
- Exposes one reconciliation method:
  - `resolveQuestion(questionId, answer, source)`

2. `ChatRoutingService`
- Maps `(providerId, externalChannelId, externalThreadId)` to ticket/brainstorm context.
- Creates/updates provider routing rows when ticket topics/threads are created.
- Deletes or archives routing rows on ticket completion/deletion.

3. `ProviderAdapter` contract
- `ensureRoute(context, title)`
- `sendQuestion(route, payload)`
- `sendNotification(route, payload)`
- `deleteRoute(route)` or `closeRoute(route)`
- `parseInbound(update)` -> provider-neutral inbound event
- `validateSetup()` -> daemon-log result only for MVP

### Persistence

Use SQLite for durable queue state and telemetry.

Recommended new tables:

1. `chat_queue_items`
- `id`
- `project_id`
- `ticket_id`
- `brainstorm_id`
- `kind` (`question` | `notification`)
- `question_id`
- `provider_scope` (`all_active` for MVP)
- `payload_json`
- `status` (`queued` | `dispatching` | `awaiting_reply` | `answered` | `cancelled` | `stale` | `timed_out` | `failed` | `dead_letter`)
- `retry_count`
- `available_at`
- `created_at`
- `sent_at`
- `resolved_at`
- `resolved_by` (`web` | `telegram` | `slack` | `system`)

2. `chat_delivery_events`
- `id`
- `queue_item_id`
- `project_id`
- `ticket_id`
- `provider_id`
- `event_type` (`sent` | `failed` | `retried` | `dead_letter` | `answered` | `cancelled`)
- `attempt`
- `error_text`
- `created_at`

If we want a smaller MVP schema, `chat_delivery_events` can be the only telemetry store and queue state can hold current counters.

### Routing Model

Prefer `provider_channels` as the authoritative route store, expanded to support external thread identity in metadata:

- Telegram metadata:
  - `chatId`
  - `messageThreadId`
  - `topicName`
  - `topicCreatedAt`
- Slack metadata:
  - `channel`
  - `threadTs`

For migration safety, keep writing `chat-threads.json` until providers are fully cut over, but stop using provider-local in-memory caches as the authoritative reverse-lookup source.

---

## Task 1: Add Durable Queue and Telemetry Schema
**Depends on:** None
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Create: `apps/daemon/src/stores/chat-queue.store.ts`
- Modify: `apps/daemon/src/stores/provider-channel.store.ts`
- Modify: `apps/daemon/src/stores/CLAUDE.md`
- Test: `apps/daemon/src/stores/__tests__/chat-queue.store.test.ts`
- Test: `apps/daemon/src/stores/__tests__/provider-channel.store.test.ts`

**Purpose:** Create the durable data model for serialized questions, queue state, routing metadata, and telemetry.

**Not In Scope:** changing frontend data access in this task.

**Step 1: Write failing store tests**
- Verify queue item CRUD, state transitions, and next-dispatch selection.
- Verify only one `awaiting_reply` question can exist globally.
- Verify provider route metadata can store thread/topic identifiers needed for reverse lookup and cleanup.

**Step 2: Implement migration**
- Add `chat_queue_items` table.
- Add `chat_delivery_events` table.
- Add indexes for:
  - queue ordering (`status`, `available_at`, `created_at`)
  - active question lookup
  - ticket-specific queue inspection
- If needed, widen `provider_channels.metadata` expectations only in code rather than schema.

**Step 3: Implement store helpers**
- `enqueueQuestion`
- `enqueueNotification`
- `getActiveQuestion`
- `listReadyQueueItems`
- `markDispatching`
- `markAwaitingReply`
- `markAnswered`
- `markCancelled`
- `markTimedOut`
- `markDeadLetter`
- `recordDeliveryEvent`
- `cancelQueuedItemsForQuestionId`

**Step 4: Run tests**
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/stores/__tests__/chat-queue.store.test.js dist/stores/__tests__/provider-channel.store.test.js`
Expected:
- PASS

**Step 5: Commit**
- `git commit -m "feat(daemon): add durable chat queue and delivery telemetry stores"`

---

## Task 2: Introduce Central Chat Orchestrator
**Depends on:** Task 1
**Complexity:** complex
**Files:**
- Create: `apps/daemon/src/services/chat/chat-orchestrator.ts`
- Create: `apps/daemon/src/services/chat/chat-routing.service.ts`
- Create: `apps/daemon/src/services/chat/provider-adapter.types.ts`
- Modify: `apps/daemon/src/services/chat.service.ts`
- Modify: `apps/daemon/src/providers/chat-provider.types.ts`
- Modify: `apps/daemon/src/server/server.ts`
- Test: `apps/daemon/src/services/__tests__/chat.orchestrator.test.ts`
- Test: `apps/daemon/src/services/__tests__/chat.service.askAsync.test.ts`

**Purpose:** Move queueing, active-question gating, and provider coordination out of provider-specific callbacks and into one service.

**Gotchas:** Preserve existing conversation-store writes and SSE behavior while changing orchestration boundaries.

**Step 1: Write failing orchestrator tests**
- One question enters queue and becomes active.
- Second question remains queued until the first resolves.
- Notifications are sent via orchestrator but do not hold the active-question lock.
- A logical question can dispatch to both providers without duplicating active-lock state.

**Step 2: Define adapter contract**
- Move provider interface toward:
  - route ensure/create
  - outbound question/notification send
  - inbound event normalization
  - optional setup validation
- Keep provider-specific API details out of orchestrator.

**Step 3: Implement orchestrator**
- `enqueueQuestion(context, payload)`
- `enqueueNotification(context, payload)`
- `tickQueue()`
- `dispatchQueueItem(item)`
- `resolveQuestion(questionId, answer, source)`
- `cancelQuestion(questionId, reason)`
- `reconcileWebAnswer(...)`
- serialize queue work so only one dispatcher loop runs at a time

**Step 4: Rewire `ChatService`**
- `askAsync` should:
  - create/store conversation question
  - write pending-question metadata
  - enqueue one question item instead of sending directly to providers
- `notify` should:
  - persist notification
  - enqueue notification item instead of sending directly
- `handleResponse` should delegate answer reconciliation to orchestrator and remain responsible for conversation/event writes only where still appropriate

**Step 5: Run tests**
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/__tests__/chat.orchestrator.test.js dist/services/__tests__/chat.service.askAsync.test.js`
Expected:
- PASS

**Step 6: Commit**
- `git commit -m "feat(daemon): centralize chat queue orchestration"`

---

## Task 3: Convert Telegram to a Thin Topic-Based Adapter
**Depends on:** Task 2
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/providers/telegram/telegram.api.ts`
- Modify: `apps/daemon/src/providers/telegram/telegram.provider.ts`
- Modify: `apps/daemon/src/providers/telegram/telegram.poller.ts`
- Modify: `apps/daemon/src/server/routes/telegram.routes.ts`
- Modify: `apps/daemon/src/types/config.types.ts`
- Modify: `apps/daemon/src/stores/config.store.ts`
- Test: `apps/daemon/src/providers/telegram/__tests__/telegram.provider.test.ts` (create if missing)
- Test: `apps/daemon/src/providers/telegram/__tests__/telegram.api.test.ts` (create if missing)

**Purpose:** Support Telegram forum topics, log-first setup validation, and strong callback identity while keeping Telegram-specific logic localized.

**Step 1: Write failing Telegram adapter tests**
- Creating a ticket route creates a forum topic and stores `message_thread_id`.
- Sending a question includes strong callback payload with `questionId`.
- Free-text inbound message in a topic resolves to the correct ticket context.
- Topic deletion/closure runs when orchestrator requests cleanup.
- Invalid setup logs daemon warnings instead of throwing new UI-facing errors.

**Step 2: Expand Telegram API wrapper**
- Add methods for:
  - `getChat`
  - `getChatMember`
  - `deleteForumTopic` or close/hide fallback, depending on available API support
  - topic-create/send helpers that accept route metadata
- Add startup/setup validation:
  - forum-enabled group
  - bot membership
  - admin rights/topic management capability
- Write validation results to daemon logs only for MVP.

**Step 3: Change callback identity**
- Inline keyboard callback data must encode:
  - compact `questionId`
  - `optionIndex`
  - short integrity token/checksum if size budget allows
- Provider parses callback into provider-neutral inbound answer event.
- Stale/mismatched callback must be rejected centrally, not answered optimistically in the provider.

**Step 4: Route cleanup semantics**
- On ticket done/archive/delete, orchestrator asks Telegram adapter to delete or close the topic.
- Log failures but keep ticket lifecycle progressing.

**Step 5: Run tests**
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/providers/telegram/__tests__/telegram.provider.test.js dist/providers/telegram/__tests__/telegram.api.test.js`
Expected:
- PASS

**Step 6: Commit**
- `git commit -m "feat(daemon): add Telegram topic adapter with strong callback identity"`

---

## Task 4: Align Slack to the Same Route and Queue Model
**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/providers/slack/slack.provider.ts`
- Modify: `apps/daemon/src/providers/slack/slack.api.ts`
- Modify: `apps/daemon/src/providers/slack/slack.socket.ts`
- Test: `apps/daemon/src/providers/slack/__tests__/slack.provider.test.ts`
- Test: `apps/daemon/src/providers/slack/__tests__/slack.socket.test.ts`

**Purpose:** Make Slack behave like Telegram from the orchestrator's perspective, using thread identity for routing and centralized answer reconciliation.

**Step 1: Write failing Slack tests**
- Thread creation registers route metadata.
- Inbound threaded reply resolves through the central route model.
- Top-level non-thread messages remain ignored.
- Provider no longer owns queue/resume logic.

**Step 2: Implement adapter cleanup**
- Move any remaining route lookup logic from provider-local cache to centralized route reads.
- Normalize inbound thread events to provider-neutral route events.
- Keep formatting/thread creation in Slack adapter only.

**Step 3: Run tests**
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/providers/slack/__tests__/slack.provider.test.js dist/providers/slack/__tests__/slack.socket.test.js`
Expected:
- PASS

**Step 4: Commit**
- `git commit -m "refactor(daemon): align Slack adapter with central chat routing"`

---

## Task 5: Reconcile Web Answers and Remove Queued/Active Chat Questions
**Depends on:** Task 2, Task 3, Task 4
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`
- Modify: `apps/daemon/src/services/chat.service.ts`
- Modify: `apps/daemon/src/services/chat/chat-orchestrator.ts`
- Modify: `apps/daemon/src/stores/chat.store.ts`
- Modify: `apps/daemon/src/server/server.ts`
- Test: `apps/daemon/src/server/__tests__/ticket-input.routes.test.ts`
- Test: `apps/daemon/src/services/__tests__/chat.orchestrator.test.ts`

**Purpose:** Ensure web-app answers immediately resolve or cancel queued provider questions and keep the global queue moving.

**Gotchas:** web and provider replies may race; only the first valid answer may win.

**Step 1: Write failing reconciliation tests**
- Web answer to active question:
  - resolves current queue item
  - releases global lock
  - triggers next queued question dispatch
- Web answer to not-yet-sent queued question:
  - marks queued item cancelled/answered without provider delivery
- Late Telegram/Slack answer after web resolution:
  - rejected as stale
  - no duplicate conversation message written
- Duplicate web submit for same `questionId`:
  - idempotent no-op after first success

**Step 2: Centralize answer entry points**
- Add one reconciliation helper used by:
  - `/api/tickets/:project/:id/input`
  - Telegram inbound callback/text
  - Slack inbound reply
  - startup recovery if queued question state is loaded
- Use `questionId` as the single authoritative identity.

**Step 3: Queue resolution policy**
- If question is `awaiting_reply`, resolve it and dispatch next question.
- If question is still `queued`, mark it resolved/cancelled before send.
- If question is already resolved, return stale/idempotent success path depending on caller.

**Step 4: Run tests**
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/server/__tests__/ticket-input.routes.test.js dist/services/__tests__/chat.orchestrator.test.js`
Expected:
- PASS

**Step 5: Commit**
- `git commit -m "fix(daemon): reconcile web answers with queued chat questions"`

---

## Task 6: Populate Ticket Activity and Delivery Telemetry Consistently
**Depends on:** Task 5
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/chat.service.ts`
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`
- Create: `apps/daemon/src/server/routes/chat-telemetry.routes.ts`
- Modify: `apps/daemon/src/server/routes/index.ts`
- Modify: `apps/daemon/src/server/server.ts`
- Test: `apps/daemon/src/services/__tests__/chat.service.idempotency.test.ts`
- Test: `apps/daemon/src/server/__tests__/chat-telemetry.routes.test.ts`

**Purpose:** Keep the ticket Activity tab authoritative and expose enough backend telemetry to observe queue and provider health.

**Not In Scope:** building a new frontend telemetry UI in this plan.

**Step 1: Write failing tests**
- Accepted provider replies appear once in ticket conversation history.
- Web/provider duplicates do not create duplicate user messages.
- Telemetry route returns queue depth, active question age, per-provider event counts, and dead-letter counts.

**Step 2: Standardize activity writes**
- Ensure every accepted inbound answer writes:
  - conversation `user` message
  - `ticket:message` SSE event
- Ensure stale answers write telemetry/logs but not duplicate ticket activity.

**Step 3: Expose telemetry**
- Add a daemon API route for:
  - current queue depth
  - active question metadata
  - delivery counts grouped by provider and ticket
  - dead-letter items

**Step 4: Run tests**
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/__tests__/chat.service.idempotency.test.js dist/server/__tests__/chat-telemetry.routes.test.js`
Expected:
- PASS

**Step 5: Commit**
- `git commit -m "feat(daemon): add chat activity reconciliation and delivery telemetry"`

---

## Task 7: Lifecycle Hooks, Recovery, and Rollout Verification
**Depends on:** Tasks 1-6
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/server/server.ts`
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts`
- Modify: `apps/daemon/src/services/ticket-restart.service.ts`
- Modify: `apps/daemon/src/stores/config.store.ts`
- Modify: `apps/daemon/src/types/config.types.ts`
- Modify: `docs/slack/README.md`
- Create: `docs/telegram/README.md`
- Test: `apps/daemon/src/server/__tests__/recovery.utils.test.ts`
- Test: `apps/daemon/src/server/__tests__/tickets-lifecycle.routes.test.ts`

**Purpose:** Make queue/routing behavior survive daemon restarts and ticket lifecycle changes without leaving orphaned active questions or orphaned Telegram topics.

**Step 1: Write failing integration tests**
- Ticket moved to `Done` deletes/closes Telegram topic and clears active/queued question state.
- Archived/deleted ticket clears queue items and provider routes.
- Restart with one active question preserves the wait state and does not dispatch a second question.
- Restart after answered-via-web correctly advances to the next queued question.

**Step 2: Add lifecycle hooks**
- On `ticket:moved` to terminal/done state:
  - cancel queued questions for that ticket
  - resolve/clear active question if it belongs to that ticket
  - request provider route cleanup
- On archive/delete:
  - same cleanup path

**Step 3: Add recovery behavior**
- On daemon start:
  - restore queue state
  - rebuild active-question lock from durable queue rows
  - run provider setup validation and log results
  - do not redispatch already-awaiting question messages unless recovery policy explicitly says so

**Step 4: Run full quality gates**
Run:
- `pnpm build:shared`
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
- `pnpm --filter @potato-cannon/frontend typecheck`
- `pnpm -r typecheck`
Expected:
- PASS

**Step 5: Commit**
- `git commit -m "feat(daemon): add chat queue lifecycle recovery and provider cleanup hooks"`

---

## Test Strategy

1. Unit tests for queue selection, active-question locking, and answer reconciliation
2. Provider adapter tests for Telegram topics/callbacks and Slack thread routing
3. Route/service tests for web-answer dequeueing
4. Lifecycle tests for ticket done/archive/delete cleanup
5. Recovery tests for restart behavior and stale-answer rejection

## Rollout Notes

1. Start with the queue/orchestrator behind one daemon feature flag if desired, but keep the plan compatible with direct cutover.
2. Keep `chat-threads.json` dual-write for one release window if migration risk is a concern.
3. Log setup-validator warnings to daemon logs only in MVP:
   - Telegram chat is not forum-enabled
   - bot is not admin
   - bot cannot manage topics
4. Monitor:
   - queue depth
   - active question age
   - retry counts
   - dead-letter counts
   - stale answer count by source (`web`, `telegram`, `slack`)

## Risk Register

1. Global serialization may slow multi-ticket throughput.
- Mitigation: make the rule explicit and measure active-question age before relaxing policy.

2. Telegram callback payload size can exceed limits if `questionId` encoding is verbose.
- Mitigation: use compact IDs or server-side short token mapping.

3. Migration from file-based thread cache to DB-backed routing can introduce drift.
- Mitigation: dual-write during rollout and prefer DB for reverse lookup first.

4. Web and provider answers can race.
- Mitigation: atomic resolve-by-`questionId` with first-writer-wins semantics.

5. Topic deletion may fail due to permissions or API behavior.
- Mitigation: log and fall back to close/hide semantics where available.

## Suggested Beads Breakdown

1. Epic: Central chat queue and provider routing
2. Subtask: queue schema and store
3. Subtask: orchestrator extraction
4. Subtask: Telegram topic adapter and setup validation
5. Subtask: Slack alignment
6. Subtask: web-answer reconciliation
7. Subtask: telemetry and lifecycle cleanup

---

## Verification Record

- Draft pass: completed
- Feasibility pass: completed
- Completeness pass: completed
- Risk pass: completed
- Optimality pass: completed
- Refinements made:
  - narrowed MVP scope to avoid new brainstorm-specific lifecycle work
  - replaced ambiguous test commands with daemon-build plus exact test-file execution
  - removed unnecessary shared-type work from telemetry task
  - added explicit routing-service file creation and exact new test targets
- Outcome: ready for beads conversion and implementation slicing
