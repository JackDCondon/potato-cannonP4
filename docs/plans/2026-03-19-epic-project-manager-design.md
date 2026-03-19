# Epic Project Manager Agent

**Date:** 2026-03-19
**Status:** Design

## Overview

The Project Manager (PM) agent is a passive orchestration layer that activates when a brainstorm transitions to an epic. It inherits the brainstorm's Telegram/chat thread and becomes the human's single point of contact for managing the entire epic lifecycle — from status queries to ticket advancement — without replacing the human as the domain expert.

## Core Concept

### Lifecycle

1. **Brainstorm phase** — Normal brainstorm flow. Human and agent refine the plan collaboratively.
2. **Transition** — Brainstorm agent creates tickets, brainstorm status becomes `epic`. The brainstorm agent produces a **decisions artifact** (`decisions.md`) capturing key trade-offs and rationale.
3. **PM activation** — The daemon sets `pm_enabled` on the brainstorm record. Next interaction on the thread spawns a Claude session with the PM skill instead of the brainstorm skill.
4. **Ongoing** — The PM responds to queries, manages ticket advancement, and (depending on mode) proactively monitors epic health via a daemon-side polling timer.

### Three Operating Modes

| Mode | Behavior | Alerts | Auto-advance |
|------|----------|--------|--------------|
| **Passive** | Only responds when messaged. No polling. | None | Never |
| **Watching** | Polls epic state on interval. Alerts when action needed. | Stuck tickets, ralph failures, dependency unblocks, session crashes | Never |
| **Executing** | Auto-advances non-gated phases. Alerts on failures. | Stuck tickets, ralph failures, session crashes | Yes (non-gated only) |

**Critical invariant:** The PM never replaces the human as subject matter expert. Human-gated phases (e.g., Refinement Q&A) always require human interaction regardless of mode.

### Alert Categories

| Alert | Description | Watching | Executing |
|-------|-------------|----------|-----------|
| Stuck tickets | No session activity for N minutes | On | On |
| Ralph loop failures | Max review attempts hit, needs intervention | On | On |
| Dependency unblocks | Ticket ready to advance, all deps satisfied | On | Off (auto-advances) |
| Session crashes | Claude session exited unexpectedly | On | On |

Phase completion is **not** tracked — existing agents already notify on completion.

## PM Agent Context

When a PM session spawns, it receives:

- **Decisions artifact** — Produced by the brainstorm agent at transition. Compact summary of requirements, trade-offs, and rationale.
- **Plan summary** — From `brainstorms.plan_summary`.
- **Live epic state** — Retrieved via the `get_epic_status` MCP tool.

The PM never gets the full brainstorm conversation history. This keeps token usage predictable.

## New MCP Tool: `get_epic_status`

Returns a structured snapshot of the entire epic:

```json
{
  "epicId": "brainstorm-123",
  "title": "Auth Rewrite",
  "mode": "watching",
  "tickets": [
    {
      "id": "ticket-1",
      "title": "OAuth2 Provider",
      "phase": "Build",
      "taskProgress": { "completed": 3, "total": 5 },
      "blockedBy": [],
      "stuckSince": null
    },
    {
      "id": "ticket-2",
      "title": "Session Storage Migration",
      "phase": "Architecture",
      "taskProgress": null,
      "blockedBy": ["ticket-1"],
      "stuckSince": "2026-03-19T10:30:00Z"
    }
  ],
  "summary": { "total": 7, "done": 2, "inProgress": 3, "blocked": 1, "notStarted": 1 }
}
```

## Polling Architecture

The polling loop is a **daemon-side timer**, not a Claude session. It queries SQLite directly and only spawns a PM Claude session when it detects something worth reporting.

```
Daemon Timer (configurable interval)
    |
    +-- Query ticket states, session status, ralph feedback
    +-- Compare against alert thresholds
    |
    +-- Nothing to report -> sleep until next interval
    +-- Alert triggered -> spawn PM session with alert context
            |
            +-- PM formats message -> chat_notify to Telegram/chat thread
```

No tokens burned during quiet periods.

### Configurable Thresholds

- **Polling interval** — Default 5 minutes. Range: 1-30 minutes.
- **Stuck threshold** — Default 30 minutes. How long a ticket sits with no session activity before alerting.
- **Alert cooldown** — Default 15 minutes. Prevents repeated alerts for the same issue.

### Executing Mode Auto-Advance

When polling detects a non-gated phase is complete, the daemon advances the ticket directly (no Claude session needed). The PM session only spawns if there's something to communicate or a decision to make.

## Settings Architecture

### Hierarchy

```
Global (all projects)
    +-- Project (per project, existing "Configure" page)
        +-- Board (per board within a project)
```

Board-level settings apply to all epics on that board. No epic-level settings. Null/missing values inherit up the chain.

### Settings Schema

```json
{
  "pm": {
    "mode": "watching",
    "polling": {
      "intervalMinutes": 5,
      "stuckThresholdMinutes": 30,
      "alertCooldownMinutes": 15
    },
    "alerts": {
      "stuckTickets": true,
      "ralphFailures": true,
      "dependencyUnblocks": true,
      "sessionCrashes": true
    }
  }
}
```

### Frontend UI

**New route:** `/settings/board/:boardId` — mirrors the existing global settings view pattern.

**Access point:** Settings icon on the board header.

**Layout:**
- Mode selector — Three radio-style cards (passive / watching / executing) with one-line descriptions
- Polling section — Interval slider, stuck threshold input. Greyed out in passive mode.
- Alert toggles — Per category, pre-populated based on mode but overridable.
- Each setting shows "inherited from project" or "inherited from global" when not overridden, with a reset-to-default action.

**Reusability:** The settings panel component is generic — takes a schema and renders controls with inheritance indicators. Reused across global, project, and board levels. Future uses: model tier overrides, workflow template config, notification preferences.

## Brainstorm to PM Transition

### Trigger

Automatic and deterministic: when brainstorm status becomes `epic` (tickets created), the daemon marks `pm_enabled = true`.

### Steps

1. Brainstorm agent creates tickets via `create_ticket` MCP tool (existing flow).
2. Brainstorm status -> `epic` (existing behavior).
3. Brainstorm agent produces `decisions.md` artifact via `attach_artifact` — summarizes requirements, trade-offs, rationale.
4. Daemon sets `pm_enabled` on the brainstorm record. Polling timer starts if board mode is watching or executing.
5. Next message on the thread spawns a PM session. PM introduces itself: "I'm now managing this epic."

### Skill Loading

- **Before transition:** Brainstorm skill loaded. PM skill never referenced.
- **After transition:** PM skill loaded. Brainstorm skill no longer used.
- **Detection:** Daemon checks `brainstorm.status === 'epic' && brainstorm.pm_enabled` when resolving which skill to load.

### Frontend

- Brainstorm detail header changes from "Brainstorm" to "Epic — managed by PM"
- Chat interface remains identical — same thread, same input box.

## Provider Abstraction

The PM service interacts exclusively with `ChatService` (the provider-agnostic layer), never directly with `TelegramProvider`. All thread routing, message formatting, and delivery go through the `ChatProvider` abstraction. Adding Slack later requires only implementing a new `SlackProvider` — no PM changes needed.

## Implementation Components

### New — Daemon

| Component | Purpose |
|-----------|---------|
| `services/pm/pm-poller.ts` | Daemon-side timer, queries epic state, triggers alerts |
| `services/pm/pm-alerts.ts` | Alert detection logic (stuck, ralph failures, crashes, unblocks) |
| `services/pm/pm-transition.ts` | Brainstorm -> PM activation (flag setting, skill resolution) |
| `mcp/tools/epic.tools.ts` | `get_epic_status` MCP tool |
| `stores/board-settings.store.ts` | Board-level settings CRUD with inheritance resolution |
| Migration | `pm_enabled` on brainstorms, `board_settings` table |

### New — Frontend

| Component | Purpose |
|-----------|---------|
| `/settings/board/:boardId` route | Board settings page |
| `SettingsPanel` component | Reusable schema-driven settings with inheritance |
| Mode selector component | Passive / watching / executing cards |
| Updated brainstorm detail header | Shows PM status after transition |

### New — Templates/Skills

| Component | Purpose |
|-----------|---------|
| PM agent prompt | System prompt defining PM personality, capabilities, constraints |
| Decisions artifact template | Structure for brainstorm agent's handoff artifact |

### No Changes Needed

- Telegram provider — already handles thread routing via `ChatProvider` interface
- Worker executor — PM doesn't interfere with ticket execution
- Existing MCP tools — PM reuses `chat_ask`, `chat_notify`, `get_ticket`, `create_ticket`
- Brainstorm flow — existing gates and ticket creation remain as-is

### Implementation Order

1. Board settings store + migration (foundation)
2. `get_epic_status` MCP tool (PM needs this)
3. PM service (poller, alerts, transition logic)
4. PM agent prompt
5. Frontend board settings UI
6. Brainstorm agent update (produce decisions artifact at transition)
