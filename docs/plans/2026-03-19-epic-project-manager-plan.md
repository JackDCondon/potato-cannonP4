# Epic Project Manager Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Add a Project Manager agent that activates when brainstorms become epics, providing status queries, ticket advancement, and proactive health monitoring via Telegram/chat.

**Architecture:** The PM is a hybrid system: on-demand Claude sessions for user queries + daemon-side polling timer for proactive alerts. Three operating modes (passive/watching/executing) configured per-board with inheritance from project and global settings. The PM reuses the existing `ChatProvider` abstraction — never touches Telegram directly.

**Tech Stack:** SQLite (better-sqlite3), Express routes, React 19 + TanStack Router/Query, Tailwind CSS, existing MCP tool pattern

**Key Decisions:**
- **Settings hierarchy:** Global → Project → Board (not Epic). Board settings stored in `board_settings` table with JSON `pm_config` column. Inheritance resolved at query time with COALESCE-style fallback.
- **Polling is daemon-side, not Claude:** A `setInterval` timer queries SQLite directly and only spawns a Claude PM session when an alert fires. This keeps costs near zero during quiet periods.
- **Brainstorm status:** Add `'epic'` to `BrainstormStatus` union type. Transition is deterministic: brainstorm creates tickets → status becomes epic → `pm_enabled` flag set → next thread interaction spawns PM skill.
- **Skill loading:** Session service checks `brainstorm.status === 'epic' && brainstorm.pm_enabled` to decide whether to load PM agent prompt vs brainstorm agent prompt. No PM skill loaded until transition.
- **Provider abstraction:** PM service only calls `ChatService.notify()` / `ChatService.askAsync()` — never `TelegramProvider` directly. Slack addition later requires zero PM changes.

---

## Task 1: Database Migration V22 — PM Fields and Board Settings

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `packages/shared/src/types/brainstorm.types.ts`

**Purpose:** Add the `pm_enabled` column to brainstorms, the `board_settings` table, and extend `BrainstormStatus` to include `'epic'`.

**Step 1: Update shared types**

In `packages/shared/src/types/brainstorm.types.ts`:
```typescript
export type BrainstormStatus = 'active' | 'completed' | 'epic'

export interface Brainstorm {
  // ... existing fields ...
  pmEnabled?: boolean  // new
}
```

**Step 2: Write the migration**

In `apps/daemon/src/stores/migrations.ts`, increment `CURRENT_SCHEMA_VERSION` to 22 and add:

```typescript
function migrateV22(db: Database.Database): void {
  // Add pm_enabled to brainstorms
  const brainstormCols = new Set(
    (db.prepare("PRAGMA table_info(brainstorms)").all() as { name: string }[]).map(r => r.name)
  );
  if (!brainstormCols.has("pm_enabled")) {
    db.exec(`ALTER TABLE brainstorms ADD COLUMN pm_enabled INTEGER NOT NULL DEFAULT 0`);
  }

  // Create board_settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_settings (
      id           TEXT PRIMARY KEY,
      workflow_id  TEXT NOT NULL UNIQUE REFERENCES project_workflows(id) ON DELETE CASCADE,
      pm_config    TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_board_settings_workflow ON board_settings(workflow_id);
  `);
}
```

Add the `if (version < 22)` block in `runMigrations()`.

**Step 3: Update brainstorm store row mapper**

In `apps/daemon/src/stores/brainstorm.store.ts`, add `pm_enabled` to `BrainstormRow` interface and `rowToBrainstorm()`:
```typescript
// In BrainstormRow:
pm_enabled: number;

// In rowToBrainstorm:
pmEnabled: row.pm_enabled === 1,
```

Also add `pmEnabled` to `UpdateBrainstormInput`:
```typescript
pmEnabled?: boolean;
```

And handle it in `updateBrainstorm()`:
```typescript
if (updates.pmEnabled !== undefined) {
  fields.push("pm_enabled = ?");
  values.push(updates.pmEnabled ? 1 : 0);
}
```

**Step 4: Run test to verify migration**
Run: `cd apps/daemon && pnpm test`
Expected: PASS (existing tests still pass, migration applies cleanly)

**Step 5: Commit**
`git commit -m "feat(db): add V22 migration for PM fields and board_settings table"`

---

## Task 2: Board Settings Store

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/stores/board-settings.store.ts`
- Create: `packages/shared/src/types/board-settings.types.ts`
- Modify: `packages/shared/src/types/index.ts` (re-export)

**Purpose:** CRUD for per-board PM settings with inheritance resolution from project/global defaults.

**Not In Scope:** Project-level or global-level PM settings storage. For v1, global defaults are hardcoded constants; project-level overrides come later.

**Step 1: Define shared types**

In `packages/shared/src/types/board-settings.types.ts`:
```typescript
export type PmMode = 'passive' | 'watching' | 'executing'

export interface PmAlertConfig {
  stuckTickets: boolean
  ralphFailures: boolean
  dependencyUnblocks: boolean
  sessionCrashes: boolean
}

export interface PmPollingConfig {
  intervalMinutes: number
  stuckThresholdMinutes: number
  alertCooldownMinutes: number
}

export interface PmConfig {
  mode: PmMode
  polling: PmPollingConfig
  alerts: PmAlertConfig
}

export interface BoardSettings {
  id: string
  workflowId: string
  pmConfig: PmConfig | null  // null = inherit all from defaults
  createdAt: string
  updatedAt: string
}

export const DEFAULT_PM_CONFIG: PmConfig = {
  mode: 'passive',
  polling: {
    intervalMinutes: 5,
    stuckThresholdMinutes: 30,
    alertCooldownMinutes: 15,
  },
  alerts: {
    stuckTickets: true,
    ralphFailures: true,
    dependencyUnblocks: true,
    sessionCrashes: true,
  },
}
```

**Step 2: Create store**

In `apps/daemon/src/stores/board-settings.store.ts`:
- Factory function `createBoardSettingsStore(db)`
- `getSettings(workflowId)` — returns `BoardSettings | null`
- `upsertSettings(workflowId, pmConfig: Partial<PmConfig>)` — INSERT OR REPLACE with merge
- `deleteSettings(workflowId)` — remove overrides (revert to inheritance)
- `getPmConfig(workflowId)` — merges board settings with `DEFAULT_PM_CONFIG`, returning fully resolved config

Follows the existing store pattern: sync operations, prepared statements, ISO timestamps, factory function for DI.

**Step 3: Run test**
Run: `cd apps/daemon && pnpm test`
Expected: PASS

**Step 4: Commit**
`git commit -m "feat(store): add board-settings store with PM config inheritance"`

---

## Task 3: Board Settings API Routes

**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/server/routes/board-settings.routes.ts`
- Modify: `apps/daemon/src/server/server.ts` (register routes)

**Purpose:** REST endpoints for reading/updating board PM settings.

**Step 1: Create route file**

Following the pattern in `apps/daemon/src/server/routes/workflows.routes.ts`:

```
GET  /api/projects/:projectId/workflows/:workflowId/settings
     → Returns resolved PmConfig (with inheritance applied)

PUT  /api/projects/:projectId/workflows/:workflowId/settings/pm
     → Body: Partial<PmConfig>
     → Validate: mode must be one of 'passive'|'watching'|'executing',
       intervalMinutes must be >= 1, threshold/cooldown must be >= 1.
       Reject invalid values with 400.
     → Verify workflowId belongs to projectId before updating.
     → Upserts board settings, returns resolved config

DELETE /api/projects/:projectId/workflows/:workflowId/settings/pm
     → Removes board overrides (revert to defaults)
```

**Step 2: Register routes in server.ts**

Import and call `registerBoardSettingsRoutes(app)` alongside other route registrations.

**Step 3: Run test**
Run: `cd apps/daemon && pnpm test`
Expected: PASS

**Step 4: Commit**
`git commit -m "feat(api): add board settings REST endpoints"`

---

## Task 4: `get_epic_status` MCP Tool

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/mcp/tools/epic.tools.ts`
- Modify: `apps/daemon/src/mcp/tools/index.ts` (register)

**Purpose:** MCP tool that returns a structured snapshot of an entire epic's state for the PM agent.

**Step 1: Define the tool**

Following the pattern in `apps/daemon/src/mcp/tools/ticket.tools.ts`:

```typescript
export const epicTools: ToolDefinition[] = [
  {
    name: "get_epic_status",
    description: "Get a full status snapshot of an epic: all tickets with phases, task progress, blockers, and summary counts.",
    scope: "session",
    inputSchema: {
      type: "object",
      properties: {
        brainstormId: {
          type: "string",
          description: "The brainstorm/epic ID. Defaults to session context.",
        },
      },
      required: [],
    },
  },
];
```

**Step 2: Implement the handler**

The handler:
1. Resolves `brainstormId` from args or `ctx.brainstormId`
2. Queries all tickets with `brainstorm_id = brainstormId` via `getTicketsByBrainstormId()`
3. For each ticket, queries task progress (`listTasks(ticketId)`) and dependencies (`ticketDependencyGetForTicket(ticketId)`)
4. Computes `stuckSince` by checking if there's an active session — if no session and ticket is in a working phase (not Ideas/Done/Blocked), check `ticket_history.entered_at` for current phase
5. Returns JSON with `epicId`, `title`, `mode` (from board settings), `tickets[]`, and `summary` counts

**Step 3: Register in index.ts**

Add `epicTools` and `epicHandlers` to `allTools` and `allHandlers` in `apps/daemon/src/mcp/tools/index.ts`.

**Step 4: Run test**
Run: `cd apps/daemon && pnpm test`
Expected: PASS

**Step 5: Commit**
`git commit -m "feat(mcp): add get_epic_status tool for PM agent"`

---

## Task 5: PM Transition Logic

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/services/pm/pm-transition.ts`
- Modify: `apps/daemon/src/services/session/session.service.ts` (skill routing)
- Modify: `apps/daemon/src/services/session/prompts.ts` (PM prompt builder)

**Purpose:** Handle the brainstorm → PM transition and route skill loading based on brainstorm status.

**Step 1: Create transition module**

`pm-transition.ts` exports:
- `transitionToEpicPm(brainstormId: string)` — Sets `pm_enabled = true` on the brainstorm. Called after brainstorm status becomes `'epic'`. Idempotent. Must also emit `eventBus.emit('brainstorm:updated', { brainstormId })` so the frontend's SSE stream picks up the status change reactively.
- `shouldUsePmSkill(brainstorm: Brainstorm): boolean` — Returns `brainstorm.status === 'epic' && brainstorm.pmEnabled === true`

**Step 2: Add PM prompt builder**

In `apps/daemon/src/services/session/prompts.ts`, add `buildPmPrompt()`:

```typescript
export function buildPmPrompt(
  projectId: string,
  brainstormId: string,
  brainstorm: { name: string; planSummary?: string | null },
  decisionsArtifact?: string,
  options?: { pendingContext?: { question: string; response: string } },
): string {
  // Similar structure to buildBrainstormPrompt but with PM-specific instructions
  // Includes: PM role description, available commands, mode info
  // Includes: planSummary, decisions artifact content
  // Includes: resume context if pendingContext provided
  // To load decisionsArtifact: read from brainstorm artifacts dir:
  //   getBrainstormFilesDir(projectId, brainstormId) + '/artifacts/decisions.md'
  // Use fs.readFile with try/catch — artifact may not exist yet
}
```

**Step 3: Modify session service skill routing**

In `session.service.ts`, modify `spawnForBrainstorm()`:
- After loading the brainstorm, check `shouldUsePmSkill(brainstorm)`
- If true: load PM agent prompt from `agents/project-manager.md` instead of `agents/brainstorm.md`
- Use `buildPmPrompt()` instead of `buildBrainstormPrompt()`
- Pass `POTATO_BRAINSTORM_ID` as before (PM reuses the brainstorm's Telegram thread)

**Gotchas:**
- The existing `spawnForBrainstorm()` at line 1468 in session.service.ts loads `agents/brainstorm.md` hardcoded. This needs to become conditional.
- The `--resume` flag behavior stays the same — PM sessions can resume just like brainstorm sessions.
- **Concurrency guard:** The existing `spawnForBrainstorm()` only logs a warning if an active session exists. Change this to a hard early-return (return existing session ID) to prevent the PM poller and user-initiated messages from spawning duplicate sessions for the same brainstorm.
- **Route guard:** Update the brainstorm spawn guard in `brainstorms.routes.ts` to handle `'epic'` status explicitly — it should proceed (spawning PM agent via the new routing logic), not block.

**Step 4: Run test**
Run: `cd apps/daemon && pnpm test`
Expected: PASS

**Step 5: Commit**
`git commit -m "feat(pm): add brainstorm-to-PM transition and skill routing"`

---

## Task 6: PM Agent Prompt

**Depends on:** Task 5
**Complexity:** standard
**Files:**
- Create: `apps/daemon/templates/workflows/product-development/agents/project-manager.md`

**Purpose:** The system prompt that defines the PM agent's personality, capabilities, and constraints.

**Step 1: Write the agent prompt**

The prompt should define:
- **Role:** You are a Project Manager for this epic. You help the human track progress, advance tickets, and monitor health.
- **Capabilities:** Status queries, ticket advancement (non-gated phases only), answering "what's next?", summarizing blockers
- **Constraints:** Never replace the human as domain expert. Human-gated phases always require human interaction. Never auto-advance gated phases regardless of mode.
- **Available tools:** `get_epic_status`, `chat_ask`, `chat_notify`, `get_ticket`
- **Mode awareness:** The prompt receives the current mode (passive/watching/executing) and adjusts behavior accordingly
- **Introduction:** On first activation, introduce self briefly: "I'm now managing this epic. Ask me for status, tell me to advance tickets, or ask what's next."

**Step 2: Verify prompt loads**

Manual test: Start daemon, create brainstorm that transitions to epic, verify PM prompt loads instead of brainstorm prompt by checking `logs/prompts/` output.

**Step 3: Commit**
`git commit -m "feat(pm): add project-manager agent prompt"`

---

## Task 7: PM Poller Service

**Depends on:** Task 4, Task 5
**Complexity:** complex
**Files:**
- Create: `apps/daemon/src/services/pm/pm-poller.ts`
- Create: `apps/daemon/src/services/pm/pm-alerts.ts`
- Modify: `apps/daemon/src/server/server.ts` (start/stop poller)

**Purpose:** Daemon-side polling timer that monitors epic health and triggers alerts by spawning PM sessions.

**Step 1: Create alert detection module**

`pm-alerts.ts` exports:
- `detectAlerts(epicId: string, config: PmConfig): PmAlert[]`
- Checks:
  - **Stuck tickets:** Query tickets with `brainstorm_id = epicId` that are in a working phase (not Ideas/Done/Blocked). For each, check if there's been no session activity (no active session AND `ticket_history.entered_at` for current phase older than `stuckThresholdMinutes`).
  - **Ralph failures:** Query `ralph_feedback` for tickets in this epic where `status = 'max_attempts'`.
  - **Session crashes:** Query `sessions` for this epic's tickets where `exit_code IS NOT NULL AND exit_code != 0` AND `ended_at` is recent.
  - **Dependency unblocks (watching mode only):** Query tickets in this epic that were previously blocked but now have all dependencies satisfied (compare current phase against dependency tier requirements).

**Step 2: Create poller service**

`pm-poller.ts` exports:
- `PmPoller` class with constructor accepting `sessionService: SessionService` for spawning Claude sessions
- `start()`, `stop()`, and `tick()` methods
- `start()` — Creates `setInterval` with the configured polling interval. Queries all brainstorms with `status = 'epic' AND pm_enabled = 1` and boards with mode != 'passive'.
- `tick()` — Wrapped in try/catch with `logger.error()` so a failed tick never crashes the interval. For each active epic, calls `detectAlerts()`, filters by cooldown, and if alerts exist:
  - In watching mode: spawns a PM Claude session via `sessionService.spawnForBrainstorm(brainstormId)` with alert context, which formats and sends `chat_notify` messages. If spawn fails, log the error and let cooldown expire for retry on next tick.
  - In executing mode: for dependency unblocks, calls `sessionService.spawnForTicket(ticketId)` to start the next phase (the existing session service handles phase resolution). For failures/stuck, same as watching mode (spawn PM session to notify).
- `stop()` — Clears the interval

**Cooldown tracking:** In-memory `Map<string, number>` of `alertKey → lastFiredTimestamp`. Keys are like `stuck:TICKET-1` or `ralph:TICKET-2:Refinement`. Cleared on daemon restart (acceptable — worst case is one duplicate alert).

**Spawn rate limit:** Track a per-process spawn counter. Cap at 10 PM sessions per hour across all epics. If the cap is hit, log a warning and skip spawning until the hour window resets. This prevents runaway costs if the daemon restarts repeatedly during an alert condition.

**Step 3: Wire into server.ts**

Following the pattern of the processing sync heartbeat (line 836 of server.ts):
- Instantiate `PmPoller` after services are initialized
- Call `pmPoller.start()` after server starts listening
- Call `pmPoller.stop()` in shutdown handler

**Step 4: Run test**
Run: `cd apps/daemon && pnpm test`
Expected: PASS

**Step 5: Commit**
`git commit -m "feat(pm): add polling service with alert detection"`

---

## Task 8: Frontend — Board Settings Route and Components

**Depends on:** Task 3
**Complexity:** complex
**Files:**
- Create: `apps/frontend/src/routes/projects/$projectId/workflows/$workflowId/settings.tsx`
- Create: `apps/frontend/src/components/configure/BoardSettingsPage.tsx`
- Create: `apps/frontend/src/components/configure/PmModeSelector.tsx`
- Create: `apps/frontend/src/components/configure/PmAlertToggles.tsx`
- Modify: `apps/frontend/src/api/client.ts` (add API functions)

**Purpose:** Per-board settings page with PM mode selector, polling config, and alert toggles.

**Step 1: Add API client functions**

In `apps/frontend/src/api/client.ts`:
```typescript
getBoardSettings: (projectId: string, workflowId: string) =>
  request<PmConfig>(`/api/projects/${projectId}/workflows/${workflowId}/settings`),

updateBoardPmSettings: (projectId: string, workflowId: string, config: Partial<PmConfig>) =>
  request<PmConfig>(`/api/projects/${projectId}/workflows/${workflowId}/settings/pm`, {
    method: 'PUT',
    body: JSON.stringify(config),
  }),

resetBoardPmSettings: (projectId: string, workflowId: string) =>
  request<void>(`/api/projects/${projectId}/workflows/${workflowId}/settings/pm`, {
    method: 'DELETE',
  }),
```

**Step 2: Create route file**

`apps/frontend/src/routes/projects/$projectId/workflows/$workflowId/settings.tsx`:
- Uses `createFileRoute` following the pattern in `configure.tsx`
- Resolves project from slug, renders `BoardSettingsPage`

**Step 3: Create components**

`BoardSettingsPage.tsx`:
- Fetches settings via `api.getBoardSettings()`
- Layout mirrors `GlobalConfigurePage` (same `SettingsSection` component pattern)
- Sections: PM Mode, Polling Config, Alerts
- Save button with dirty-checking pattern (same as global settings)

`PmModeSelector.tsx`:
- Three radio-style cards: Passive, Watching, Executing
- Each with icon and one-line description
- When mode changes, pre-populate alerts to sensible defaults (but user can override)

`PmAlertToggles.tsx`:
- Toggle switches for each alert category
- Greyed out in passive mode
- Shows "inherited from global" when value matches default and hasn't been explicitly set

**Step 4: Add navigation**

Add a settings icon/link to the board header that navigates to the board settings route.

**Step 5: Run test**
Run: `cd apps/frontend && pnpm test`
Expected: PASS

**Step 6: Commit**
`git commit -m "feat(ui): add board settings page with PM configuration"`

---

## Task 9: Frontend — Epic PM Status Indicator

**Depends on:** Task 3, Task 5
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.tsx`

**Purpose:** Show visual indicator when a brainstorm has transitioned to PM-managed epic.

**Step 1: Update brainstorm detail header**

In `BrainstormDetailPanel.tsx`:
- When `brainstorm.status === 'epic' && brainstorm.pmEnabled`, show header label "Epic — managed by PM" instead of "Brainstorm"
- Add a small badge/chip indicating the PM mode (passive/watching/executing)

**Step 2: Run test**
Run: `cd apps/frontend && pnpm test`
Expected: PASS

**Step 3: Commit**
`git commit -m "feat(ui): show PM status indicator on epic brainstorm header"`

---

## Task 10: Brainstorm Agent — Decisions Artifact Production

**Depends on:** Task 5
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/agents/brainstorm.md`

**Purpose:** Update the brainstorm agent prompt to produce a `decisions.md` artifact when transitioning to epic.

**Step 1: Update brainstorm agent prompt**

Add instructions to the brainstorm agent:
- When the brainstorm is ready to create tickets (plan is validated by human), before creating tickets:
  1. Call `save_brainstorm_artifact` with filename `decisions.md` containing: requirements summary, key trade-offs, design rationale, and constraints discussed during the brainstorm
  2. Then create tickets as normal
  3. The daemon handles the rest (status → epic, pm_enabled → true)

**Step 2: Verify manually**

Run a brainstorm session, verify the decisions.md artifact is created before tickets.

**Step 3: Commit**
`git commit -m "feat(brainstorm): produce decisions.md artifact at epic transition"`

---

## Task 11: Brainstorm Status Transition Automation

**Depends on:** Task 5
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/routes/tickets.routes.ts` (POST ticket handler)
- Modify: `apps/daemon/src/server/routes/brainstorms.routes.ts` (optional: manual transition endpoint)

**Purpose:** Automatically transition brainstorm to 'epic' status and enable PM when tickets are created from a brainstorm.

**Step 1: Hook into ticket creation route**

In `tickets.routes.ts`, in the POST handler that creates a ticket, after successfully creating a ticket with a `brainstormId`:
- Check if this is the first ticket for this brainstorm (query ticket count)
- If first ticket: update brainstorm status to `'epic'` and set `pm_enabled = true`
- If subsequent ticket: no-op (already transitioned)

This uses `transitionToEpicPm()` from Task 5.

**Note:** The `create_ticket` MCP tool in `ticket.tools.ts` delegates via HTTP to this route handler, so the transition hook must live server-side in the route, not in the MCP tool.

**Gotchas:** The brainstorm agent may create multiple tickets in sequence. The transition should be idempotent — only the first `create_ticket` call triggers it, subsequent calls are no-ops.

**Step 2: Run test**
Run: `cd apps/daemon && pnpm test`
Expected: PASS

**Step 3: Commit**
`git commit -m "feat(pm): auto-transition brainstorm to epic on first ticket creation"`

---

## Task 12: Integration Testing

**Depends on:** Task 7, Task 8, Task 11
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/services/pm/__tests__/pm-poller.test.ts`
- Create: `apps/daemon/src/services/pm/__tests__/pm-alerts.test.ts`
- Create: `apps/daemon/src/services/pm/__tests__/pm-transition.test.ts`
- Create: `apps/daemon/src/stores/__tests__/board-settings.store.test.ts`

**Purpose:** Test the PM system end-to-end: alert detection, polling lifecycle, settings inheritance, and transition logic.

**Step 1: Board settings store tests**
- Test CRUD operations
- Test inheritance resolution (board overrides > defaults)
- Test cascade delete when workflow is deleted

**Step 2: Alert detection tests**
- Test stuck ticket detection with mock ticket/session data
- Test ralph failure detection
- Test session crash detection
- Test dependency unblock detection
- Test cooldown filtering

**Step 3: Transition logic tests**
- Create: `apps/daemon/src/services/pm/__tests__/pm-transition.test.ts`
- Test `transitionToEpicPm()` sets brainstorm status to `'epic'` and `pm_enabled = true`
- Test `shouldUsePmSkill()` returns true only when status is `'epic'` and `pmEnabled`
- Test idempotency: calling transition twice is a no-op

**Step 4: Poller lifecycle tests**
- Test start/stop
- Test that passive mode epics are skipped
- Test that alerts trigger only when conditions met

**Step 5: Run all tests**
Run: `cd apps/daemon && pnpm test`
Expected: PASS

**Step 6: Commit**
`git commit -m "test(pm): add unit tests for PM poller, alerts, board settings, and transition logic"`

---

## Verification

### Manual End-to-End Test

1. Start daemon: `pnpm dev:daemon`
2. Start frontend: `pnpm dev:frontend`
3. Create a project and brainstorm
4. Complete brainstorm → create tickets → verify:
   - Brainstorm status transitions to `'epic'`
   - `pm_enabled` set to `true`
   - Next message on brainstorm thread spawns PM agent (check `logs/prompts/`)
5. Send "what's the status?" to the PM → verify it calls `get_epic_status` and responds with ticket overview
6. Navigate to board settings → verify PM mode selector, polling config, alert toggles render
7. Set mode to "watching" → verify poller starts (check daemon logs)
8. Create a stuck ticket scenario → verify alert fires after threshold

### Automated Tests

```bash
cd apps/daemon && pnpm test    # All daemon tests
cd apps/frontend && pnpm test  # All frontend tests
pnpm typecheck                 # TypeScript check all packages
```

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | PASS | All design requirements mapped to tasks |
| Accurate | PASS | All referenced files verified to exist; `save_brainstorm_artifact` tool confirmed in `scope.tools.ts` |
| Commands valid | PASS | All test/build commands match project conventions |
| YAGNI | PASS | Every task traces to a stated requirement |
| Minimal | WARN | Tasks 5+11 and 9+8 could theoretically merge, but separation is defensible |
| Not over-engineered | PASS | In-memory cooldown, daemon-side polling, simple type hierarchy |
| Key Decisions | PASS | 5 decisions with rationale documented |
| Context sections | PASS | Purpose on all tasks, Not In Scope on Task 2, Gotchas where needed |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | PASS (after fixes) | Fixed Task 9 file target → `BrainstormDetailPanel.tsx`, added Task 3 dependency to Task 9, added `ResolvedPmConfig` type alias (later removed in Optimality), added transition tests to Task 12 | Agent incorrectly flagged `ticket_history`, `ralph_feedback`, `getTicketsByBrainstormId` as missing — all exist |
| Feasibility | PASS (after fix) | Changed Task 11 from `ticket.tools.ts` to `tickets.routes.ts` — MCP tool delegates via HTTP so transition hook must be server-side | All deps verified: tables, functions, store patterns, route patterns, TanStack Router conventions |
| Completeness | PASS (after fixes) | Added SSE `brainstorm:updated` emit to `transitionToEpicPm()`, added `decisions.md` read path via `getBrainstormFilesDir()`, added try/catch + error logging to poller `tick()`, added spawn failure fallback, specified `sessionService` as `PmPoller` constructor dep | Reusable SettingsPanel intentionally deferred (user decision during brainstorming) |
| Risk | PASS (after fixes) | Added concurrency hard-guard to `spawnForBrainstorm()` (return early if active session exists), added route guard for `'epic'` status in `brainstorms.routes.ts`, added spawn rate limit (10/hour cap), added input validation on PM config API | Agent false-flagged `save_brainstorm_artifact` as non-existent (it's in `scope.tools.ts`) |
| Optimality | PASS | Removed `ResolvedPmConfig` type alias (use `PmConfig` directly). Kept `board_settings` table (user confirmed: needed for Global → Project → Board inheritance hierarchy) | Board settings table justified by multi-level inheritance architecture |
