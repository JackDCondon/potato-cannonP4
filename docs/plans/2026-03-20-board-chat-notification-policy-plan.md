# Board Chat Notification Policy Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Add board-level control over which outbound chat notifications reach external providers, while leaving Potato Cannon UI/history unchanged and making the board settings page scalable with collapsible sections.

**Architecture:** Store a provider-agnostic notification policy on `board_settings`, classify outbound chat messages with stable categories, resolve the current board from ticket/brainstorm context in the shared chat service, and suppress provider delivery before fan-out. On the frontend, make board settings API-backed and add a `Phone Notifications` section with preset + advanced controls.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Express, React 19, Vitest, Node test runner

**Key Decisions:**
- **Dedicated board settings column:** Add a nullable `chat_notification_policy` column to `board_settings` rather than overloading `pm_config`, so PM configuration and notification delivery policy remain independent.
- **Shared filtering layer:** Apply mute logic in `ChatService` before provider fan-out, not in Telegram or any provider implementation, so future providers inherit the behavior automatically.
- **Explicit categories over text matching:** Extend outbound chat metadata with a stable `category` field instead of filtering by message text, because text-based muting would be brittle and hard to test.
- **Board settings API as source of truth:** Replace local-storage-only PM defaults in board settings flows so board-scoped configuration is truly per workflow and can be reused from both `BoardSettingsPage` and `EpicSettingsTab`.
- **Preset + advanced toggles:** Store the resolved category booleans and a selected preset, with presets writing the booleans under the hood. This keeps the model simple while preserving a user-friendly UI.

---

## Task 1: Extend Shared Board Settings Types And Persistence
**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `packages/shared/src/types/board-settings.types.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/board-settings.store.ts`
- Modify: `apps/daemon/src/stores/__tests__/board-settings.store.test.ts`
- Modify: `apps/daemon/src/stores/__tests__/migrations.test.ts`

**Purpose:** Introduce the board-scoped notification policy model, defaults, and DB storage so every later task has a durable source of truth.

**Not In Scope:** Any provider delivery logic or UI work.

**Gotchas:** The current schema version is `28`, and `board_settings` currently stores only `pm_config`. Add a new migration for a new nullable text column rather than rewriting `V22`.

**Step 1: Write failing tests**
- Extend `apps/daemon/src/stores/__tests__/board-settings.store.test.ts` with cases for:
  - default policy when no board row exists
  - merging partial notification policy updates with defaults
  - preserving `pmConfig` when only notification policy is updated
  - preserving notification policy when only `pmConfig` is updated
- Extend `apps/daemon/src/stores/__tests__/migrations.test.ts` with a schema assertion that `board_settings` contains `chat_notification_policy`.

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
```
Expected: FAIL because the new types/column/store behavior do not exist yet.

**Step 3: Implement shared types and defaults**
- In `packages/shared/src/types/board-settings.types.ts`, add:
  - `BoardNotificationPreset`
  - `ChatNotificationCategory`
  - `ChatNotificationPolicy`
  - `DEFAULT_CHAT_NOTIFICATION_POLICY`
- Extend `BoardSettings` to include `chatNotificationPolicy: ChatNotificationPolicy | null`.
- Export the new types/constants from the shared barrel.

Suggested shared shape:
```ts
export type BoardNotificationPreset =
  | 'all'
  | 'important_only'
  | 'questions_only'
  | 'mute_all'

export type ChatNotificationCategory =
  | 'builder_updates'
  | 'pm_alerts'
  | 'lifecycle_events'
  | 'questions'
  | 'critical'

export interface ChatNotificationPolicy {
  preset: BoardNotificationPreset
  categories: Record<ChatNotificationCategory, boolean>
}
```

**Step 4: Implement persistence**
- In `apps/daemon/src/stores/migrations.ts`, add `V29` that appends `chat_notification_policy TEXT` to `board_settings`.
- In `apps/daemon/src/stores/board-settings.store.ts`:
  - extend `BoardSettingsRow`
  - parse/serialize `chat_notification_policy`
  - update `upsertSettings()` to accept both partial `pmConfig` and partial notification policy
  - add a helper such as `getResolvedBoardSettings(workflowId)` or equivalent that returns resolved defaults for both PM and notification policy

**Step 5: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
```
Expected: PASS

**Step 6: Commit**
```bash
git add packages/shared/src/types/board-settings.types.ts packages/shared/src/types/index.ts apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/board-settings.store.ts apps/daemon/src/stores/__tests__/board-settings.store.test.ts apps/daemon/src/stores/__tests__/migrations.test.ts
git commit -m "feat(board-settings): add board chat notification policy model and persistence"
```

---

## Task 2: Expand Board Settings API Contract
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/routes/board-settings.routes.ts`
- Create: `apps/daemon/src/server/routes/__tests__/board-settings.routes.test.ts`
- Modify: `apps/frontend/src/api/client.ts`

**Purpose:** Expose the notification policy through the existing board settings API so the UI can load and save it together with PM settings.

**Not In Scope:** Frontend rendering or collapsible behavior.

**Gotchas:** There is no existing route test file for board settings; create one rather than relying only on store tests.

**Step 1: Write failing route tests**
- Create `apps/daemon/src/server/routes/__tests__/board-settings.routes.test.ts` covering:
  - `GET /api/projects/:projectId/workflows/:workflowId/settings` returns both `pmConfig` and `chatNotificationPolicy`
  - `PUT /.../settings/notifications` or equivalent accepts partial policy updates and returns resolved policy
  - invalid preset/category payloads return `400`

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
```
Expected: FAIL because the route contract does not exist yet.

**Step 3: Implement the route contract**
- In `apps/daemon/src/server/routes/board-settings.routes.ts`:
  - update `GET /settings` to return both `pmConfig` and `chatNotificationPolicy`
  - add a notification-policy update endpoint, preferably `PUT /settings/notifications`
  - optionally keep PM updates on `PUT /settings/pm` to avoid mixing concerns
  - add validation for preset values and category booleans

Recommended response shape:
```ts
res.json({
  pmConfig,
  chatNotificationPolicy,
  settings,
})
```

**Step 4: Update the frontend client**
- In `apps/frontend/src/api/client.ts`, extend:
  - `getBoardSettings()`
  - add `updateBoardNotificationSettings()`
- Keep PM methods intact so this change is additive.

**Step 5: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
```
Expected: PASS

**Step 6: Commit**
```bash
git add apps/daemon/src/server/routes/board-settings.routes.ts apps/daemon/src/server/routes/__tests__/board-settings.routes.test.ts apps/frontend/src/api/client.ts
git commit -m "feat(api): expose board chat notification policy endpoints"
```

---

## Task 3: Add Provider-Agnostic Notification Categories And Policy Resolution
**Depends on:** Task 1
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/providers/chat-provider.types.ts`
- Create: `apps/daemon/src/services/chat/chat-notification-policy.ts`
- Modify: `apps/daemon/src/services/chat.service.ts`
- Modify: `apps/daemon/src/services/__tests__/chat.service.askAsync.test.ts`
- Create: `apps/daemon/src/services/__tests__/chat.service.notification-policy.test.ts`
- Modify: `apps/daemon/src/stores/ticket.store.ts` if helper export is needed
- Modify: `apps/daemon/src/stores/brainstorm.store.ts` if helper export is needed

**Purpose:** Teach the shared chat layer how to classify outbound messages and decide whether they should be delivered externally for the current board.

**Not In Scope:** Classifying all call sites yet. This task provides the plumbing and tests it with synthetic messages.

**Gotchas:** `ChatContext` currently has `projectId`, `ticketId`, and `brainstormId`, but not `workflowId`. The shared chat layer must resolve the workflow from the ticket or brainstorm record before checking board settings.

**Step 1: Write failing tests**
- Add `apps/daemon/src/services/__tests__/chat.service.notification-policy.test.ts` covering:
  - questions are persisted/emitted but not provider-sent when `questions=false`
  - notifications are provider-sent when enabled
  - board policy resolution works for ticket context and brainstorm context
  - unknown or uncategorized messages follow the chosen safe fallback
- Extend `chat.service.askAsync.test.ts` so `askAsync()` asserts the outbound question carries `category: "questions"`.

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
```
Expected: FAIL

**Step 3: Implement provider-agnostic category metadata**
- In `apps/daemon/src/providers/chat-provider.types.ts`, extend `OutboundMessage`:
```ts
category?: ChatNotificationCategory
```
- Do not change provider interfaces beyond receiving the enriched message.

**Step 4: Implement policy resolution helper**
- Create `apps/daemon/src/services/chat/chat-notification-policy.ts` with pure helpers such as:
  - `resolveWorkflowIdForChatContext(context): string | null`
  - `shouldDeliverToExternalChat(policy, message): boolean`
  - `applyPresetToCategories(preset): Record<ChatNotificationCategory, boolean>`
- Prefer pure helpers here so the logic is testable without provider mocks.

**Step 5: Implement filtering in `ChatService`**
- In `apps/daemon/src/services/chat.service.ts`:
  - default `askAsync()` messages to `category: "questions"`
  - update `notify()` to accept an optional category parameter or overload input shape
  - before `sendToProviders()`, resolve the workflow and board policy
  - skip provider delivery when the category is muted
  - keep conversation persistence and SSE emission unchanged

Recommended `notify()` shape:
```ts
async notify(
  context: ChatContext,
  message: string,
  options?: { category?: ChatNotificationCategory }
): Promise<void>
```

**Step 6: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
```
Expected: PASS

**Step 7: Commit**
```bash
git add apps/daemon/src/providers/chat-provider.types.ts apps/daemon/src/services/chat/chat-notification-policy.ts apps/daemon/src/services/chat.service.ts apps/daemon/src/services/__tests__/chat.service.askAsync.test.ts apps/daemon/src/services/__tests__/chat.service.notification-policy.test.ts apps/daemon/src/stores/ticket.store.ts apps/daemon/src/stores/brainstorm.store.ts
git commit -m "feat(chat): add board-aware external notification filtering"
```

---

## Task 4: Classify Known Outbound Notification Sources
**Depends on:** Task 3
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/mcp/tools/chat.tools.ts`
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/services/pm/pm-poller.ts`
- Modify: `apps/daemon/src/services/pm/pm-alerts.ts` if alert kind-to-category mapping helper is added there
- Modify: `apps/daemon/src/services/session/__tests__/worker-executor-task-close-notification.test.ts`
- Modify: `apps/daemon/src/services/session/__tests__/build-notification-contract.test.ts`
- Create or modify: PM poller tests under `apps/daemon/src/services/pm/__tests__/`

**Purpose:** Ensure the real message producers assign categories that match the product model, especially the "mute builder updates" use case.

**Not In Scope:** Introducing digests or changing notification text.

**Gotchas:** `chat_notify` is a generic tool. To avoid relying on text parsing, give it an optional `category` argument and a sane default. Most agent chatter should default to `builder_updates`; high-signal sources owned by the daemon can pass explicit categories directly.

**Step 1: Write failing tests**
- Update worker/session/PM tests to assert category assignment for:
  - task closed notifications -> `builder_updates`
  - pause/resume/block lifecycle messages -> `lifecycle_events`
  - PM alerts -> `pm_alerts`
  - `chat_ask` -> `questions`
- Add a `chat.tools.ts` test asserting `chat_notify` forwards a provided category and falls back to `builder_updates` when omitted.

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
```
Expected: FAIL

**Step 3: Implement classification**
- In `apps/daemon/src/mcp/tools/chat.tools.ts`:
  - extend the tool schema for `chat_notify` with optional `category`
  - default omitted categories to `builder_updates`
- In `apps/daemon/src/services/session/worker-executor.ts`, call:
```ts
await chatService.notify({ projectId, ticketId }, `[Workflow]: Task closed: ${taskName}`, {
  category: 'builder_updates',
})
```
- In `apps/daemon/src/services/session/session.service.ts`, classify:
  - pause/resume -> `lifecycle_events`
  - explicit action-needed daemon notices -> `critical`
- In PM code, map PM-generated alerts to `pm_alerts` before they reach shared notify.

**Step 4: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/mcp/tools/chat.tools.ts apps/daemon/src/services/session/worker-executor.ts apps/daemon/src/services/session/session.service.ts apps/daemon/src/services/pm/pm-poller.ts apps/daemon/src/services/pm/pm-alerts.ts apps/daemon/src/services/session/__tests__/worker-executor-task-close-notification.test.ts apps/daemon/src/services/session/__tests__/build-notification-contract.test.ts apps/daemon/src/services/pm/__tests__/
git commit -m "feat(chat): classify outbound board notifications by category"
```

---

## Task 5: Replace Local Storage Board Defaults With API-Backed State
**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/configure/BoardSettingsPage.tsx`
- Modify: `apps/frontend/src/components/configure/BoardSettingsPage.test.tsx`
- Modify: `apps/frontend/src/components/brainstorm/EpicSettingsTab.tsx`
- Modify: `apps/frontend/src/components/brainstorm/EpicSettingsTab.test.tsx`
- Delete: `apps/frontend/src/lib/pm-storage.ts` if unused after refactor

**Purpose:** Make board settings genuinely board-scoped by loading/saving them from the API instead of browser local storage.

**Not In Scope:** The new phone notification controls UI itself; this task only fixes the data flow.

**Gotchas:** `EpicSettingsTab` still uses `loadBoardPmDefaults()` as a fallback when an epic lacks its own PM config. That behavior must be updated to use board settings from the API or a shared hook, otherwise board-level defaults remain inconsistent.

**Step 1: Rewrite the existing failing assumptions in tests**
- Replace local-storage assertions in `BoardSettingsPage.test.tsx` with API-backed assertions:
  - page loads `pmConfig` from `api.getBoardSettings`
  - PM changes save via `api.updateBoardPmSettings`
  - board changes re-load when `projectId`/`workflowId` change
- Update `EpicSettingsTab.test.tsx` so PM fallback comes from board settings API data instead of `pm-storage`.

**Step 2: Run frontend tests to verify failure**
```bash
pnpm --filter @potato-cannon/frontend test -- run src/components/configure/BoardSettingsPage.test.tsx src/components/brainstorm/EpicSettingsTab.test.tsx
```
Expected: FAIL

**Step 3: Implement API-backed board settings state**
- In `BoardSettingsPage.tsx`:
  - fetch `api.getBoardSettings(projectId, workflowId)` in `useEffect`
  - maintain local editable state initialized from API response
  - persist PM changes with `api.updateBoardPmSettings`
- In `EpicSettingsTab.tsx`:
  - fetch board settings for `workflowId`
  - use returned `pmConfig` as the fallback instead of local storage

**Step 4: Remove obsolete local-storage helper**
- Delete `apps/frontend/src/lib/pm-storage.ts` if no call sites remain.

**Step 5: Run frontend tests to verify pass**
```bash
pnpm --filter @potato-cannon/frontend test -- run src/components/configure/BoardSettingsPage.test.tsx src/components/brainstorm/EpicSettingsTab.test.tsx
```
Expected: PASS

**Step 6: Commit**
```bash
git add apps/frontend/src/components/configure/BoardSettingsPage.tsx apps/frontend/src/components/configure/BoardSettingsPage.test.tsx apps/frontend/src/components/brainstorm/EpicSettingsTab.tsx apps/frontend/src/components/brainstorm/EpicSettingsTab.test.tsx apps/frontend/src/lib/pm-storage.ts
git commit -m "feat(frontend): back board settings with API data instead of local storage"
```

---

## Task 6: Add Collapsible Board Settings Sections And Phone Notification Controls
**Depends on:** Tasks 2, 5
**Complexity:** complex
**Files:**
- Create: `apps/frontend/src/components/configure/CollapsibleSettingsSection.tsx`
- Modify: `apps/frontend/src/components/configure/BoardSettingsPage.tsx`
- Modify: `apps/frontend/src/components/configure/BoardSettingsPage.test.tsx`
- Modify: `apps/frontend/src/api/client.ts` if additional client method typing is needed

**Purpose:** Add the user-facing configuration for phone delivery and prevent the board settings page from turning into a long static wall of settings.

**Not In Scope:** Reworking epic settings or making all settings pages collapsible. This is scoped to the board settings page.

**Gotchas:** Keep the explanatory copy explicit that Potato Cannon still shows all messages even when phone delivery is muted.

**Step 1: Write failing frontend tests**
- Extend `BoardSettingsPage.test.tsx` with cases for:
  - `Phone Notifications` section renders collapsed/expanded behavior
  - preset selector loads `All notifications` by default
  - choosing `Important only` writes `questions + critical + pm_alerts`
  - advanced toggles can override preset booleans
  - saving uses `api.updateBoardNotificationSettings`

**Step 2: Run tests to verify failure**
```bash
pnpm --filter @potato-cannon/frontend test -- run src/components/configure/BoardSettingsPage.test.tsx
```
Expected: FAIL

**Step 3: Implement a dedicated collapsible settings component**
- Create `CollapsibleSettingsSection.tsx` rather than retrofitting every existing `SettingsSection` call site.
- Keep the API small:
```tsx
<CollapsibleSettingsSection
  title="Phone Notifications"
  description="Control what reaches external chat providers for this board."
  defaultOpen
>
  ...
</CollapsibleSettingsSection>
```

**Step 4: Implement the `Phone Notifications` UI**
- In `BoardSettingsPage.tsx`, add:
  - preset selector
  - explanation copy
  - advanced toggle controls for:
    - `builder_updates`
    - `pm_alerts`
    - `lifecycle_events`
    - `questions`
    - `critical`
- Persist through `api.updateBoardNotificationSettings(projectId, workflowId, partialPolicy)`.

**Step 5: Run tests to verify pass**
```bash
pnpm --filter @potato-cannon/frontend test -- run src/components/configure/BoardSettingsPage.test.tsx
```
Expected: PASS

**Step 6: Commit**
```bash
git add apps/frontend/src/components/configure/CollapsibleSettingsSection.tsx apps/frontend/src/components/configure/BoardSettingsPage.tsx apps/frontend/src/components/configure/BoardSettingsPage.test.tsx apps/frontend/src/api/client.ts
git commit -m "feat(frontend): add collapsible board settings and phone notification controls"
```

---

## Task 7: Full Integration Verification And Cleanup
**Depends on:** Tasks 1-6
**Complexity:** standard
**Files:**
- Modify: `docs/plans/2026-03-20-board-chat-notification-policy-design.md` only if implementation decisions materially diverged
- Modify: relevant CLAUDE/docs files only if the new API surface needs documenting

**Purpose:** Verify the feature works end-to-end and clean up any stale implementation artifacts.

**Not In Scope:** New feature work beyond the agreed design.

**Step 1: Typecheck and build**
```bash
pnpm build
pnpm typecheck
```
Expected: PASS

**Step 2: Run full automated tests**
```bash
pnpm test
```
Expected: PASS

**Step 3: Manual smoke test**
1. Start the daemon and frontend.
2. Open a board settings page.
3. Confirm `All notifications` is the default for a board without overrides.
4. Switch to `Mute all external chat`.
5. Trigger a builder update on a ticket in that board.
6. Verify:
   - message still appears in Potato Cannon activity/conversation UI
   - external provider does not receive it
7. Re-enable `Important only`.
8. Trigger:
   - a PM alert and verify it is delivered
   - a builder update and verify it is suppressed
   - a question and verify it follows the board policy

**Step 4: Cleanup**
- Remove any dead local-storage-specific board settings code left behind.
- Remove any temporary debug logging added during development.

**Step 5: Commit**
```bash
git add -A
git commit -m "test: verify board chat notification policy end to end"
```

---

## Implementation Order

```text
Task 1 -> Task 2 -> Task 3 -> Task 4
Task 2 -> Task 5 -> Task 6
Task 4 + Task 6 -> Task 7
```

Parallelism guidance:
- Task 3 and Task 5 can proceed in parallel after Task 2 if ownership is split carefully.
- Keep `apps/daemon/src/services/chat.service.ts` owned by the backend track.
- Keep `apps/frontend/src/components/configure/BoardSettingsPage.tsx` owned by the frontend track.

---

## Testing The Full Integration

Focused verification during implementation:
```bash
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon test
pnpm --filter @potato-cannon/frontend test -- run src/components/configure/BoardSettingsPage.test.tsx
pnpm --filter @potato-cannon/frontend test -- run src/components/brainstorm/EpicSettingsTab.test.tsx
```

Final verification:
```bash
pnpm build
pnpm typecheck
pnpm test
```

---

## Risk Notes

### R1: Workflow Resolution Gap In Chat Delivery
**Risk:** `ChatContext` does not carry `workflowId`, so filtering could silently bypass board settings if the lookup from ticket/brainstorm is incomplete.
**Mitigation:** Implement workflow resolution as a dedicated helper with direct tests for both ticket and brainstorm contexts before touching provider send logic.

### R2: Generic `chat_notify` Defaults Could Misclassify High-Signal Messages
**Risk:** Defaulting every uncategorized `chat_notify` to `builder_updates` could suppress some important agent-authored messages unexpectedly.
**Mitigation:** Add an explicit optional `category` field to the tool schema, default only when omitted, and update known high-signal daemon-owned call sites to pass categories directly.

### R3: Frontend Refactor Could Regress PM Defaults
**Risk:** Replacing local storage with API-backed board settings could break the existing "board defaults applied to new epic" flow.
**Mitigation:** Update `EpicSettingsTab` in the same track and keep tests covering its fallback behavior.

### R4: Board Settings Page Scope Creep
**Risk:** Combining collapsible sections, PM settings refactor, and phone notifications could make `BoardSettingsPage.tsx` balloon.
**Mitigation:** Introduce a dedicated `CollapsibleSettingsSection` component and keep phone notification state/preset mapping in small pure helpers if the component starts getting crowded.

### R5: Migration Rollback
**Risk:** `chat_notification_policy` is a one-way additive schema change.
**Mitigation:** The new column is nullable and harmless if code is rolled back. No destructive data migration is required.

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|---|---|---|
| Complete | PASS | Covers persistence, API, shared chat filtering, classification, frontend UX, and final verification |
| Accurate | PASS | File paths and package test commands verified against the current repo |
| Commands valid | PASS | Daemon commands include `build` before `test`; frontend uses scoped Vitest runs |
| YAGNI | PASS | No per-provider settings, digests, or regex rules included |
| Minimal | PASS | Seven tasks cover the agreed feature without adding unrelated refactors |
| Not over-engineered | PASS | Reuses existing board settings and chat seams instead of inventing a parallel system |
| Key Decisions documented | PASS | Five implementation decisions with rationale included |
| Context sections present | PASS | Purpose, Not In Scope, and Gotchas included where needed |

### Rule-of-Five-Plans Passes
| Pass | Status | Summary |
|---|---|---|
| Draft | CLEAN | Plan structure, dependencies, files, and commands are present for all tasks |
| Feasibility | CLEAN | Verified actual file locations, current schema version, package test commands, and local-storage board settings seam |
| Completeness | CLEAN | Includes the missing `EpicSettingsTab` dependency so board defaults remain truly board-scoped |
| Risk | CLEAN | Calls out workflow resolution, `chat_notify` misclassification, frontend regression, component sprawl, and migration rollback |
| Optimality | CLEAN | Chooses additive API and dedicated collapsible component over broader refactors or provider-specific logic |
