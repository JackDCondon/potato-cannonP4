# Agent Restart Continuity Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Preserve useful working context when ticket agents restart without weakening lifecycle safety, restart invalidation, or stale-generation fencing.

**Architecture:** Implement continuity as an explicit decision pipeline with three outputs: `resume`, `handoff`, or `fresh`. `resume` is allowed only when the current worker lifecycle, workspace identity, and Claude session compatibility all still match. `handoff` uses a bounded, structured packet built from persisted, provenance-tagged conversation/session data. Destructive lifecycle actions such as restart build any required handoff snapshot before cleanup begins. `fresh` remains the default fallback when safety or data requirements are not met.

**Tech Stack:** Node/TypeScript daemon, SQLite-backed stores, Express routes, session worker orchestration, React frontend activity panel, Vitest.

**Key Decisions:**
- **Safety gates beat continuity:** lifecycle invalidation, stale-drop, and restart semantics always override continuity restoration.
- **Persist provenance before using continuity:** continuity can only use data that records phase, generation, and source identity.
- **Use `spawn_pending` as the restart snapshot carrier:** pre-cleanup restart handoff data lives in `tickets.worker_state` on the next `spawn_pending` root so the replacement spawn can read it without reparsing deleted state.
- **Real prompt budget, not just item counts:** continuity packets must enforce byte/character caps with deterministic truncation.
- **Persist the decision on the session:** every spawned session stores `continuityMode`, `continuityReason`, and summary metadata so API/UI/debugging all read the same truth.

---

## Execution Rules

These rules are mandatory. Do not improvise around them.

1. If a lifecycle action deletes or invalidates data, build and persist any allowed handoff snapshot before deletion starts.
2. Never use `--resume` unless all resume-eligibility checks pass.
3. Restart-to-earlier-phase may never inject deleted phase artifacts, deleted feedback, deleted tasks, or deleted session highlights back into the next prompt.
4. Continuity packets must be built from persisted data only. Do not infer missing provenance at read time.
5. For daemon TypeScript changes, always run a build before daemon tests. `@potato-cannon/daemon` tests execute compiled `dist/**/*.test.js`.
6. Every spawned session must persist its continuity decision in both SQLite session metadata and `session_start` log metadata.
7. If the continuity builder cannot produce a safe packet inside the configured prompt budget, fall back to `fresh`.
8. A weaker model should never have to choose storage location, packet scope, or fallback behavior. This plan defines those choices already.

---

## Scope Summary

In scope:
1. explicit continuity contract (`resume` vs `handoff` vs `fresh`)
2. provenance tagging for conversation/session data used by continuity
3. bounded continuity packet extraction with real size limits
4. pre-cleanup continuity snapshots for destructive lifecycle actions
5. guarded `--resume` expansion for same-swimlane, same-workspace, same-lifecycle cases
6. startup recovery updates so daemon restart uses the same decision pipeline
7. API/frontend visibility of continuity decisions for debugging and support
8. rollout flags, logs, metrics, and operator guidance

Out of scope:
1. replaying raw PTY logs back into prompts
2. cross-ticket or cross-project memory sharing
3. changing ticket phase semantics or execution generation rules
4. adding a summarization LLM dependency

---

## Continuity Safety Contract

Use these exact rules when implementing continuity behavior.

### Allowed continuity sources

1. **Ticket conversation messages**
   - only if they include enough metadata to identify phase/generation/source scope
   - user-authored messages are always safest
2. **Session transcript highlights**
   - only structured assistant/tool events
   - never raw PTY chunks
3. **Pending interaction state**
   - pending question
   - pending response
   - restart reason or recovery reason metadata

### Forbidden continuity sources

1. deleted phase artifacts
2. deleted Ralph feedback
3. deleted task state from reset phases
4. deleted session history from reset phases
5. raw PTY output
6. any data without enough provenance to prove it belongs to the current continuity scope

### Continuity modes by scenario

1. **Suspended question/answer resume**
   - existing behavior stays highest priority
   - use `resume` if the current suspended-session identity is still valid
2. **Same-phase worker respawn without lifecycle invalidation**
   - use `resume` only if the full eligibility contract passes
   - otherwise use `handoff`
3. **Restart to an earlier phase**
   - never use `resume`
   - may use `handoff`, but packet content is restricted to safe user context and restart reason
   - if no safe packet exists, use `fresh`
4. **Daemon startup recovery**
   - use the same decision function as normal spawns
   - do not keep separate recovery-only continuity behavior

### Resume compatibility contract

All of the following must match before `resume` is allowed:
1. `ticketId`
2. `phase`
3. `agentSource`
4. `executionGeneration`
5. `workflowId`
6. `worktreePath`
7. `branchName` or workspace label
8. agent-definition prompt hash
9. sorted MCP server names
10. model selection
11. sorted disallowed-tools list
12. no lifecycle invalidation after the resumable session was created
13. stored Claude session ID still present

If any one check fails, do not resume. Choose `handoff` if a safe packet exists, otherwise `fresh`.

---

## Beads-Ready Task Graph

The tasks below are intentionally smaller than the previous revision. Each task should convert cleanly into one beads child issue with a single acceptance target.

### Task 1: Define Continuity Core Types and Config Defaults
**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/services/session/continuity.types.ts`
- Modify: `apps/daemon/src/types/session.types.ts`
- Modify: `apps/daemon/src/services/session/types.ts`
- Modify: `apps/daemon/src/types/config.types.ts`
- Modify: `apps/daemon/src/stores/config.store.ts`
- Modify: `packages/shared/src/types/session.types.ts`
- Test: `apps/daemon/src/stores/__tests__/config.store.test.ts`

**Purpose:** Create the contract types and config knobs that all later tasks rely on.

**Not In Scope:** writing policy logic, building packets, or wiring prompts.

**Gotchas:** count-only limits are not enough; define real size-budget fields now.

### Step 1: Write failing tests
- Add config normalization tests for:
  - `daemon.lifecycleContinuity.enabled`
  - `daemon.lifecycleContinuity.allowResumeSameSwimlane`
  - `daemon.lifecycleContinuity.maxConversationTurns`
  - `daemon.lifecycleContinuity.maxSessionEvents`
  - `daemon.lifecycleContinuity.maxCharsPerItem`
  - `daemon.lifecycleContinuity.maxPromptChars`

### Step 2: Add the continuity contracts
- Add `ContinuityMode`, `ContinuityReason`, `ContinuityPacketScope`, `ContinuityPacket`, `ContinuityDecision`, `ContinuityCompatibilityKey`, and `SessionContinuityMetadata`.
- Extend session metadata types to carry:
  - `continuityMode`
  - `continuityReason`
  - `continuityScope`
  - `continuitySummary`
  - `continuitySourceSessionId`

### Step 3: Add config fields and defaults
- Add all continuity config fields under `daemon.lifecycleContinuity`.
- Normalize invalid values to safe finite defaults.

### Step 4: Run validation commands
Run:
- `pnpm --filter @potato-cannon/shared build`
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): define lifecycle continuity core contracts and defaults"`

---

### Task 2: Extend Worker State to Carry Restart Snapshots
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/types/orchestration.types.ts`
- Modify: `apps/daemon/src/services/session/worker-state.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Make the snapshot carrier explicit by attaching optional continuity snapshot data to the `spawn_pending` worker-state root.

**Not In Scope:** building the snapshot contents.

**Gotchas:** do not invent a new temp file or a second storage mechanism; use `tickets.worker_state` so restart and replacement spawn share one source of truth.

### Step 1: Write failing tests
- Add tests asserting `invalidateTicketLifecycle(...)` can write a `spawn_pending` state that optionally includes a continuity snapshot.
- Add tests asserting old worker-state readers still accept `spawn_pending` without a snapshot.

### Step 2: Extend the `spawn_pending` shape
- Add optional fields for:
  - `continuitySnapshot`
  - `continuitySnapshotCreatedAt`
- Keep `active` worker-state roots unchanged.

### Step 3: Allow lifecycle invalidation to receive snapshot data
- Extend `InvalidateTicketLifecycleOptions` so callers can supply an optional restart snapshot.
- Serialize that snapshot into the `spawn_pending` state created during invalidation.

### Step 4: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): allow spawn-pending worker state to carry restart continuity snapshots"`

---

### Task 3: Persist Session Compatibility Metadata at Session Creation
**Depends on:** Tasks 1-2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/session.store.ts`
- Modify: `apps/daemon/src/types/session.types.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/stores/__tests__/session.store.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Persist the exact compatibility data that future resume decisions must compare.

**Gotchas:** do not rely on later log parsing for compatibility checks; persist the values on the session row when the session is created.

### Step 1: Write failing tests
- Add tests asserting stored session metadata persists:
  - `workflowId`
  - `worktreePath`
  - `branchName`
  - agent-definition prompt hash
  - sorted MCP server names
  - model selection
  - sorted disallowed-tools list

### Step 2: Build a canonical compatibility key
- Add a helper that produces one stable compatibility object from session creation inputs.
- Sort list-like fields before persisting them.
- Store only stable identifiers, not raw prompt text.

### Step 3: Persist compatibility metadata on all ticket session creation paths
- Apply the helper in:
  - normal ticket worker spawn
  - resumed suspended ticket spawn
  - any ticket respawn path that creates a stored session

### Step 4: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): persist resume compatibility metadata on stored sessions"`

---

### Task 4: Persist Conversation Provenance Metadata on Ticket Messages
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/types/conversation.types.ts`
- Modify: `packages/shared/src/types/conversation.types.ts`
- Modify: `apps/daemon/src/services/chat.service.ts`
- Modify: `apps/daemon/src/stores/conversation.store.ts`
- Test: `apps/daemon/src/services/__tests__/chat.service.askAsync.test.ts`
- Test: `apps/daemon/src/stores/__tests__/conversation.store.test.ts`

**Purpose:** Ensure ticket conversation messages carry enough metadata to be filtered safely for continuity.

**Not In Scope:** deciding which messages belong in a packet.

**Gotchas:** write provenance at message creation time; do not reconstruct it later from surrounding state.

### Step 1: Write failing tests
- Add tests asserting ticket conversation messages persist:
  - `phase`
  - `executionGeneration`
  - `agentSource` when known
  - `sourceSessionId` when known
  - `messageOrigin`

### Step 2: Add typed continuity metadata for conversation messages
- Add a typed metadata shape for continuity-relevant fields.
- Keep current message text/options behavior unchanged.

### Step 3: Update ticket conversation writes in `ChatService`
- For ticket question/user/notification writes, include best-known provenance fields.
- If a field is unknown in that code path, omit it instead of guessing.

### Step 4: Run validation commands
Run:
- `pnpm --filter @potato-cannon/shared build`
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): persist ticket conversation provenance for continuity filtering"`

---

### Task 5: Add Filtered Conversation Read Helpers
**Depends on:** Task 4
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/conversation.store.ts`
- Test: `apps/daemon/src/stores/__tests__/conversation.store.test.ts`

**Purpose:** Add deterministic ticket-conversation queries so continuity does not read the entire conversation blindly.

**Gotchas:** the helper must filter first, then bound the result window.

### Step 1: Write failing tests
- Add tests for:
  - filtering by phase
  - filtering by execution generation
  - filtering by agent source when present
  - returning most-recent matching messages while emitting them oldest-to-newest

### Step 2: Add a bounded filtered query helper
- Return only continuity-eligible messages.
- Support the exact filters used by the packet builder.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): add filtered conversation readers for continuity"`

---

### Task 6: Add Filtered Session and Transcript Highlight Readers
**Depends on:** Tasks 3-4
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/session.store.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/stores/__tests__/session.store.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Read recent candidate sessions and structured transcript highlights without mixing in raw PTY output.

**Gotchas:** `session.store` owns SQLite session rows, but transcript highlight parsing still depends on log files; keep the helper boundary explicit.

### Step 1: Write failing tests
- Add tests for:
  - filtering sessions by `ticketId`, `phase`, `agentSource`, and `executionGeneration`
  - preferring most-recent sessions first
  - parsing structured assistant/tool events only
  - excluding `raw` entries from highlights

### Step 2: Add candidate-session query helpers
- Return bounded recent sessions from SQLite.
- Add a log-highlight reader that extracts only structured entries needed for continuity.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): add filtered session readers and transcript highlights for continuity"`

---

### Task 7: Build the Bounded Continuity Packet Builder
**Depends on:** Tasks 5-6
**Complexity:** complex
**Files:**
- Create: `apps/daemon/src/services/session/continuity-context.service.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/services/session/__tests__/continuity-context.service.test.ts`

**Purpose:** Produce deterministic handoff packets inside a real prompt budget.

**Gotchas:** apply filtering and truncation in a fixed order so two runs over the same inputs produce the same packet.

### Step 1: Write failing tests
- Add tests for:
  - most-recent-window selection
  - oldest-to-newest emission order
  - per-item truncation to `maxCharsPerItem`
  - total packet reduction to `maxPromptChars`
  - returning no packet when even the minimum safe packet does not fit

### Step 2: Implement the packet builder
- Build a canonical payload with:
  - `conversationTurns[]`
  - `sessionHighlights[]`
  - `unresolvedQuestions[]`
  - `reasonForRestart`
  - `scope`
- Apply limits in this order:
  1. provenance filter
  2. count window
  3. per-item truncation
  4. total-packet trimming
  5. fail closed to no packet

### Step 3: Define packet priorities for trimming
- Highest priority:
  - unresolved question context
  - most recent user-authored turns
- Lower priority:
  - older assistant highlights
  - older tool summaries

### Step 4: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): add bounded continuity packet builder"`

---

### Task 8: Build Restart Snapshots Before Cleanup Begins
**Depends on:** Tasks 2, 4, 7
**Complexity:** complex
**Files:**
- Create: `apps/daemon/src/services/session/continuity-snapshot.service.ts`
- Modify: `apps/daemon/src/services/ticket-restart.service.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/server/__tests__/tickets-lifecycle.routes.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Capture safe restart handoff data before restart deletes sessions/history/artifacts or resets the workspace.

**Not In Scope:** consuming the snapshot on replacement spawn.

**Gotchas:** restart snapshots are only for restart-to-earlier-phase and must use `safe_user_context_only` scope.

### Step 1: Write failing tests
- Add tests asserting restart:
  - builds the snapshot before cleanup functions run
  - never chooses `resume`
  - stores the snapshot on the new `spawn_pending` worker state
  - excludes deleted-phase output and deleted derived work product

### Step 2: Build the restart snapshot builder
- Build a helper that produces only `safe_user_context_only` packets.
- Include:
  - recent safe user context
  - valid pending question/response context
  - restart reason metadata
- Exclude:
  - deleted phase assistant output
  - deleted artifacts
  - deleted feedback
  - deleted task state

### Step 3: Persist the snapshot through lifecycle invalidation
- Pass the snapshot into `invalidateTicketLifecycle(...)`.
- Write it onto the `spawn_pending` worker state before cleanup finishes.

### Step 4: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): persist safe restart handoff snapshots before cleanup"`

---

### Task 9: Consume and Clear Restart Snapshots on Replacement Spawn
**Depends on:** Task 8
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/services/session/worker-state.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Ensure the next replacement spawn uses the stored restart snapshot exactly once.

**Gotchas:** do not leave stale restart snapshots hanging around for later unrelated spawns.

### Step 1: Write failing tests
- Add tests asserting replacement spawn:
  - consumes the snapshot from `spawn_pending`
  - prefers the stored snapshot over rebuilding from possibly deleted state
  - clears the snapshot after the spawn decision is made

### Step 2: Implement one-time snapshot consumption
- Read the snapshot from `spawn_pending` worker state.
- Use it only for the immediately pending replacement spawn.
- Remove it once consumed.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): consume restart continuity snapshots exactly once"`

---

### Task 10: Implement Exact Resume Eligibility Checks
**Depends on:** Tasks 1, 3
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/services/session/continuity-policy.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Centralize the yes/no gate for `resume` so weaker models never compare partial fields ad hoc.

**Gotchas:** one missing compatibility field means no resume.

### Step 1: Write failing tests
- Add tests asserting resume is allowed only when every compatibility field matches.
- Add tests asserting each mismatch independently forces a non-resume decision.

### Step 2: Implement the resume gate
- Compare all fields from the resume compatibility contract.
- Return a reason enum for every failure branch.
- Do not fall through to `resume` on partial matches.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): add exact resume eligibility checks for continuity"`

---

### Task 11: Implement the Full Continuity Decision Function
**Depends on:** Tasks 7, 9, 10
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/continuity-policy.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/worker-executor-stale.test.ts`

**Purpose:** Decide between `resume`, `handoff`, and `fresh` in one place.

**Gotchas:** suspended question/answer resume remains the highest-priority resume path.

### Step 1: Write failing tests
- Add tests covering:
  - safe `resume`
  - unsafe resume with safe packet becomes `handoff`
  - no safe packet becomes `fresh`
  - stale generation always blocks `resume`

### Step 2: Implement the decision order
- Decision order must be:
  1. suspended question/answer resume path
  2. explicit restart snapshot if present
  3. same-lifecycle resume if fully eligible
  4. same-lifecycle handoff if safe packet exists
  5. fresh fallback

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): add unified continuity mode decision function"`

---

### Task 12: Apply the Decision Function to Normal Ticket Spawns
**Depends on:** Task 11
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/services/session/worker-executor.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/worker-executor-stale.test.ts`

**Purpose:** Make normal worker spawns and same-phase respawns use the shared continuity policy.

**Gotchas:** preserve existing stale callback handling exactly.

### Step 1: Write failing tests
- Add tests asserting normal ticket worker spawn:
  - uses `resume` when fully eligible
  - uses `handoff` when resume is blocked but packet is safe
  - uses `fresh` otherwise

### Step 2: Wire the policy into spawn paths
- Apply the policy in normal ticket worker spawn and same-phase respawn.
- Keep stale-drop and generation-fence behavior unchanged.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): apply continuity policy to normal ticket spawns"`

---

### Task 13: Apply the Decision Function to Startup Recovery Paths
**Depends on:** Task 11
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/server.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/server/__tests__/recovery.utils.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Ensure daemon restart recovery follows the same continuity rules as normal respawns.

**Gotchas:** do not leave legacy recovery behavior as a side channel that bypasses continuity checks.

### Step 1: Write failing tests
- Add tests asserting:
  - `recoverPendingResponses()` uses the shared policy
  - `recoverInterruptedSessions()` uses the shared policy
  - stale pending input is still rejected

### Step 2: Wire the policy into recovery entry points
- Replace recovery-specific continuity decisions with calls into the shared policy.
- Keep suspended-resume precedence intact.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): apply continuity policy to startup recovery paths"`

---

### Task 14: Add Ordered Continuity Prompt Sections
**Depends on:** Task 11
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/prompts.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/services/session/__tests__/worker-executor-entry-context.test.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Inject a single clear continuity section into fresh spawns without fighting the existing `PhaseEntryContext` prompt path.

**Gotchas:** resumed sessions do not get a handoff packet.

### Step 1: Write failing tests
- Add tests asserting:
  - handoff prompts include one continuity section
  - continuity appears before `Phase Entry Context`
  - prompts include mode, reason, and scope
  - resumed sessions do not get handoff injection

### Step 2: Implement deterministic formatting
- Add `formatContinuityHandoff(...)`.
- Format only from the bounded packet.
- Do not call another model to summarize.

### Step 3: Define prompt order explicitly
- For `handoff`:
  1. agent instructions
  2. continuity section
  3. normal ticket context
  4. existing `Phase Entry Context`
- For `resume`:
  - no continuity prompt injection
- For `fresh`:
  - existing prompt path

### Step 4: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "feat(daemon): add ordered continuity handoff prompt sections"`

---

### Task 15: Persist Decision Metadata on Session Start and End
**Depends on:** Tasks 1, 11
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/stores/session.store.ts`
- Test: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Make continuity decisions observable from both SQLite metadata and session logs.

**Gotchas:** the API and UI tasks depend on this persistence already being in place.

### Step 1: Write failing tests
- Add tests asserting session start metadata includes continuity fields.
- Add tests asserting session end metadata preserves continuity fields already chosen at spawn time.

### Step 2: Persist decision metadata consistently
- Write continuity metadata to the stored session row.
- Include the same metadata in `session_start` log entries.
- Preserve it in `session_end` log metadata.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(daemon): persist continuity decision metadata on sessions"`

---

### Task 16: Expose Continuity Metadata in Session APIs
**Depends on:** Task 15
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/routes/sessions.routes.ts`
- Modify: `packages/shared/src/types/session.types.ts`
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Test: `apps/frontend/src/hooks/queries.test.tsx`

**Purpose:** Make continuity behavior inspectable through typed API responses.

**Not In Scope:** rendering the metadata in the UI.

**Gotchas:** prefer stored session metadata first, use log parsing only as a backward-compatible fallback.

### Step 1: Write failing tests
- Add tests asserting session responses expose:
  - `continuityMode`
  - `continuityReason`
  - `continuityScope`
  - optional short `continuitySummary`

### Step 2: Update route and shared/client types
- Read continuity metadata from session metadata first.
- Never expose raw packet content in list APIs.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/shared build`
- `pnpm --filter @potato-cannon/frontend test -- run src/hooks/queries.test.tsx`
- `pnpm -r typecheck`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(api): expose session continuity metadata"`

---

### Task 17: Render Continuity Metadata in Ticket Activity UI
**Depends on:** Task 16
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/components/ticket-detail/ActivityTab.tsx`
- Modify: `apps/frontend/src/components/ticket-detail/TicketDetailPanel.tsx`
- Test: `apps/frontend/src/hooks/queries.test.tsx`

**Purpose:** Show support-friendly continuity badges and summaries in the ticket detail view.

**Gotchas:** keep the UI concise and do not expose raw transcript or packet text.

### Step 1: Write failing tests
- Add tests asserting Activity UI renders mode/reason badges or summary text from session metadata.

### Step 2: Implement concise UI wiring
- Render continuity mode and reason in session activity rows.
- Keep copy short and non-blocking.

### Step 3: Run validation commands
Run:
- `pnpm --filter @potato-cannon/frontend test -- run src/hooks/queries.test.tsx`
- `pnpm -r typecheck`
Expected:
- PASS

### Step 4: Commit
- `git commit -m "feat(frontend): show continuity decisions in ticket activity"`

---

### Task 18: Add Rollout Logs, Runbook Updates, and Final Quality Gates
**Depends on:** Tasks 12-17
**Complexity:** standard
**Files:**
- Modify: `docs/session-lifecycle-rollout-runbook.md`
- Modify: `docs/plans/2026-03-11-agent-restart-continuity-plan.md`
- Modify: `apps/daemon/src/server/server.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Test: `apps/daemon/src/server/__tests__/recovery.utils.test.ts`

**Purpose:** Ship continuity behind safe defaults with enough logs and runbook detail to detect regressions quickly.

**Gotchas:** rollout validation must explicitly cover daemon startup recovery and restart-to-earlier-phase.

### Step 1: Write failing rollout/logging tests
- Add tests asserting:
  - disabled continuity preserves legacy behavior
  - enabled continuity emits structured decision logs
  - recovery paths emit the same continuity logs as normal spawns

### Step 2: Add structured logging
- Emit:
  - `continuity_mode=resume|handoff|fresh`
  - `continuity_reason=<enum>`
  - `continuity_scope=<enum>`
  - `continuity_source_session_id=<id|none>`
- Log the exact fallback reason whenever `resume` is rejected.

### Step 3: Update the runbook
- Document:
  - rollout sequence
  - startup recovery validation steps
  - restart-to-earlier-phase validation steps
  - rollback toggles
  - alert ideas
  - known caveats

### Step 4: Run final quality gates
Run:
- `pnpm --filter @potato-cannon/shared build`
- `pnpm --filter @potato-cannon/daemon build`
- `pnpm --filter @potato-cannon/daemon test`
- `pnpm --filter @potato-cannon/frontend test -- run src/hooks/queries.test.tsx`
- `pnpm -r typecheck`
Expected:
- PASS

### Step 5: Commit
- `git commit -m "docs(rollout): add continuity rollout controls and recovery validation guidance"`

---

## Beads Conversion Notes

When converting this plan to beads:
1. Create one epic for the full continuity feature.
2. Create one child issue per numbered task in the task graph above.
3. Preserve task dependencies exactly.
4. Do not merge Tasks 8 and 9; snapshot creation and snapshot consumption are separate failure domains.
5. Do not merge Tasks 12 and 13; normal spawn wiring and recovery wiring must be validated independently.
6. Do not merge Tasks 16 and 17; API typing and UI rendering should land separately.

---

## Review Checkpoints (Before Beads Conversion)

1. **Checkpoint A (Storage):** approve `spawn_pending` worker state as the restart snapshot carrier.
2. **Checkpoint B (Compatibility):** approve the exact resume compatibility fields.
3. **Checkpoint C (Granularity):** approve the 18-task beads slicing and dependency graph.
4. **Checkpoint D (Verification):** approve build-before-test commands and recovery coverage.

---

## Plan Verification Checklist

- Complete: yes, now covers contract, provenance, bounded extraction, explicit restart snapshot storage, unified decision policy, recovery, API/UI, and rollout
- Accurate: yes, tasks now align with the current daemon/frontend/shared code paths that own worker state, session metadata, recovery, and lifecycle invalidation
- Commands valid: yes, daemon commands now build before daemon tests, and frontend commands match the current Vitest setup
- YAGNI: yes, continuity stays deterministic and avoids full PTY replay or new summarization services
- Minimal: yes, one continuity policy is reused across normal spawns, restarts, and recovery while keeping restart snapshot persistence in existing worker-state storage
- Not over-engineered: yes, the plan uses existing storage and orchestration surfaces instead of inventing new subsystems
- Key Decisions documented: yes, five decisions with rationale are included
- Context sections present: yes, Purpose/Not In Scope/Gotchas are included where ambiguity would cause implementation drift

---

## Verification Record

### Deep Review Amendments Applied
| Area | Status | Change |
|------|--------|--------|
| Restart snapshot storage | PASS | Chose `spawn_pending` worker state as the explicit one-time snapshot carrier |
| Resume compatibility ambiguity | PASS | Replaced vague compatibility wording with an exact 13-field contract |
| Task sizing | PASS | Split the implementation into 18 smaller beads-ready tasks with narrower acceptance targets |
| Restart flow safety | PASS | Separated snapshot creation from snapshot consumption so destructive cleanup cannot race the replacement spawn |
| Recovery parity | PASS | Split recovery wiring into its own task so startup recovery cannot silently lag behind normal spawn behavior |
| API vs UI layering | PASS | Split metadata exposure from UI rendering so typing and display can be validated independently |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | PASS | 2 | Rebuilt the task graph into smaller beads-ready slices |
| Feasibility | PASS | 3 | Chose an explicit snapshot carrier and aligned tasks to existing worker-state/session surfaces |
| Completeness | PASS | 3 | Added missing snapshot-consumption, recovery-wiring, and API/UI separation tasks |
| Risk | PASS | 4 | Tightened exact resume compatibility rules and restart cleanup boundaries |
| Optimality | PASS | 2 | Reused existing `worker_state` storage instead of inventing a new persistence path |

---

## Continuity Rollout Notes (2026-03-11)

- Structured continuity decision logs were added with:
  - `continuity_mode`
  - `continuity_reason`
  - `continuity_scope`
  - `continuity_source_session_id`
  - `continuity_resume_rejected`
- `daemon.lifecycleContinuity.enabled=false` forces a `fresh` decision with reason `disabled` (legacy-compatible behavior).
- Startup recovery and restart-to-earlier-phase paths emit the same continuity decision keys as normal ticket spawns.
