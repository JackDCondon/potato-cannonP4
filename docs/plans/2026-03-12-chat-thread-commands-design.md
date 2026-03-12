# Chat Thread Commands Design (Slack + Telegram)

Date: 2026-03-12

## Goal
Add ticket-thread commands that work identically across Slack and Telegram:
- `push`
- `push!`
- `status`

## Scope
In scope:
- Command parsing and handling for ticket chat threads only.
- Phase movement rule for `push` and `push!`.
- Status reporting with assigned worker derived from live/persisted orchestration state.

Out of scope:
- Provider-specific slash command APIs.
- New database fields.
- Brainstorm thread commands.

## Command Contract
Commands are plain-text, case-insensitive, trimmed:
- `push`
- `push!`
- `status`

Routing contract:
- Parse command text before normal pending-question answer handling.
- If context is not a ticket, ignore command and fall through to existing behavior.
- If command is recognized and handled, do not write a pending response answer.

Interaction with pending question:
- `status`: always allowed (read-only).
- `push`: blocked when pending question exists.
- `push!`: bypasses holding-lane gate; still blocked by lifecycle safety constraints.

## Feasible Integration Point (Corrected)
`push` requires lifecycle-safe movement using `SessionService.invalidateTicketLifecycle(...)`.
That method is available in `server.ts` callback flow, not inside `ChatService`.

Implementation split:
- `ChatService`: add lightweight command parser/helper (classification only, no lifecycle transition).
- `server.ts` provider callbacks: execute ticket-thread command actions using `sessionService` and store APIs.
- Shared helper function in server layer to avoid Telegram/Slack duplication.

This preserves one command behavior across both providers while using the correct dependency boundary.

## `push` and `push!` Behavior
Data source:
- Resolve full phase list using workflow-aware helpers for the ticket context.

Target movement:
- Move exactly one swimlane right (current index + 1).

Holding-lane rule:
- Holding lane means current phase has zero workers.
- `push` requires holding lane.
- `push!` bypasses this rule.

Hard blocks for both `push` and `push!`:
- Ticket archived.
- Ticket in terminal phase.
- No lane to the right.
- Lifecycle conflict during transition.

Execution path:
- Use lifecycle-safe transition path (`invalidateTicketLifecycle`) with expected phase + generation.
- Emit standard ticket update/moved events.
- Reuse existing automated spawn behavior for phases with workers.

Responses:
- Success: report old lane -> new lane.
- Blocked: clear reason.

## `status` Behavior
Response fields:
- Ticket id and title.
- Current swimlane (`ticket.phase`).
- Assigned worker.
- Active session (`yes`/`no`).
- Last activity timestamp.

Assigned worker resolution (no schema change):
1. If active session exists and `agent_source` is set, use `agent_source`.
2. Else inspect persisted ticket `worker_state` and resolve active worker id from state tree (`activeWorker` / `workerIndex`).
3. Else `none`.

Last activity resolution:
1. Latest conversation message timestamp for ticket conversation.
2. Else latest session start/end time.
3. Else `unknown`.

## Requirements Traceability
Requirement: Command support in ticket thread.
- Covered by parser + server command handler shared by Slack/Telegram callbacks.

Requirement: `push` only from holding lane, move right by one.
- Covered by holding check + right-lane resolver.

Requirement: `push!` override.
- Covered by bypassing holding check only.

Requirement: `status` shows swimlane, assigned worker, active session, last activity.
- Covered by status payload resolver using ticket/session/worker_state/conversation data.

## Implementation Tasks
1. Add command parser utility (`push`, `push!`, `status`) with normalization tests.
2. Add server-level command handler for ticket contexts (single helper used by both providers).
3. Implement `push`/`push!` lane-resolution + lifecycle-safe transition execution.
4. Implement `status` payload resolver (worker_state + session + activity timestamp).
5. Wire both provider callbacks to run command handler before normal `chatService.handleResponse`.
6. Add command response formatting helpers and provider thread send path.
7. Add unit tests and integration tests for command behavior and regressions.

## Risk Assessment and Mitigations
Risk: Stale lifecycle updates race with other moves.
- Mitigation: enforce expected phase + generation and handle conflict response.

Risk: Duplicate handling from both callbacks.
- Mitigation: one shared server helper invoked by both providers.

Risk: Command accidentally treated as pending answer.
- Mitigation: command branch returns handled result before answer write path.

Risk: Wrong assigned worker reporting in nested loops.
- Mitigation: derive from normalized worker_state traversal, fallback to `none` if unresolved.

Risk: Session respawn side effects after push.
- Mitigation: rely on existing spawn logic used by lifecycle transitions; add integration tests.

## Rollback Plan
- Keep command handling isolated to one helper entrypoint so rollback is a single code-path revert.
- If issues appear, disable command matching in that helper and fall back to existing plain-answer behavior (no schema changes).

## Testing Plan
Unit tests:
- Command parser normalization (`push`, `PUSH`, whitespace, `push!`, `status`).
- Pending question gating (`push` blocked, `status` allowed).
- Holding-lane enforcement for `push`.
- `push!` bypass behavior.
- No-right-lane and terminal-phase blocks.
- Assigned worker derivation from active session and `worker_state`.

Integration tests:
- Provider callback receives `push` in ticket thread -> ticket phase advances by one lane.
- `push` in non-holding lane is blocked.
- `push!` in non-holding lane succeeds when lifecycle permits.
- `status` returns required fields and stable format.
- Non-command answer path remains unchanged.

## Acceptance Criteria
- Slack and Telegram accept `push`, `push!`, `status` in ticket threads.
- `push` enforces holding-lane rule; `push!` overrides only that rule.
- `status` includes swimlane, dynamic assigned worker, active session, and last activity.
- No schema migration required.
- Existing pending-question flow and provider routing regressions: none.

## Optimality Notes
- No provider-specific command APIs for v1 (YAGNI).
- No new persistent fields; reuse `worker_state` + session metadata.
- Single shared handler in server layer minimizes duplication and future maintenance.
