# Token Usage Optimization Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Reduce total tokens consumed per ticket to extend Claude subscription credits, and surface token usage in the UI.

**Architecture:** Four parallel optimization tracks: (A) token observability via DB migration + API + UI, (B) ralph loop resume for doer agents to avoid full prompt rebuild on retry, (C) context-aware MCP tool filtering to reduce tool schema tokens per session, (D) shared.md split to avoid sending scope/dependency content to agents that don't need it.

**Tech Stack:** TypeScript, Node.js (better-sqlite3), Express, React 19, Vitest (frontend tests), Node test runner (daemon tests)

**Key Decisions:**
- **No prompt caching:** Potato Cannon uses Claude Code CLI on a subscription (not API key), so `cache_control` is unavailable. All optimizations are structural.
- **model tiering already correct:** `verify-spec-agent` is already `modelTier: "low"` (Haiku) and `verify-quality-agent` is `modelTier: "high"`. No changes needed here.
- **`resumeOnRalphRetry` opt-in per agent:** Applied only to "doer" agents (refinement, architect, builder) via a new flag in `workflow.json`. Reviewer agents always start fresh for unbiased review.
- **Tool filtering via `disallowTools` + agent source env var:** The existing `disallowTools` mechanism is extended to be applied at the MCP proxy `ListTools` level, not just as a hint. Agent source is passed as an env var so the proxy can request filtered lists from the daemon.
- **Token observability light-touch UX:** Token counts only appear in (1) session completion notifications and (2) the session detail panel in SessionsTab — nowhere else.

---

## Track A: Token Observability

### Task 1: DB migration — add token columns to sessions table
**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/session.store.ts`

**Purpose:** Persist input/output token counts from Claude stream events so they can be displayed in the UI.

**Step 1: Write the failing test**
```typescript
// apps/daemon/src/stores/__tests__/session.store.test.ts (append to existing file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../migrations.js';

test('sessions table has input_tokens and output_tokens columns', () => {
  const dbPath = path.join(os.tmpdir(), `potato-token-col-test-${Date.now()}.db`);
  const db = new Database(dbPath);
  runMigrations(db);
  const info = db.prepare("PRAGMA table_info(sessions)").all() as Array<{name: string}>;
  const columns = info.map(r => r.name);
  assert.ok(columns.includes('input_tokens'), 'missing input_tokens');
  assert.ok(columns.includes('output_tokens'), 'missing output_tokens');
  db.close();
});
```

**Step 2: Run test to verify it fails**
```
cd apps/daemon && pnpm test
```
Expected: FAIL — columns don't exist yet

**Step 3: Add V24 migration**

In `apps/daemon/src/stores/migrations.ts`, update `CURRENT_SCHEMA_VERSION` from `23` to `24` and add at the bottom of the migrations array:
```typescript
{
  version: 24,
  up: (db) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN input_tokens INTEGER;
      ALTER TABLE sessions ADD COLUMN output_tokens INTEGER;
    `);
  },
},
```

In `apps/daemon/src/stores/session.store.ts`, update `SessionRow` interface (around line 13):
```typescript
export interface SessionRow {
  // ... existing fields ...
  input_tokens: number | null;
  output_tokens: number | null;
}
```

Add `updateSessionTokens` method after `updateClaudeSessionId` (~line 147):
```typescript
updateSessionTokens(sessionId: string, inputTokens: number, outputTokens: number): boolean {
  const result = this.db
    .prepare("UPDATE sessions SET input_tokens = ?, output_tokens = ? WHERE id = ?")
    .run(inputTokens, outputTokens, sessionId);
  return result.changes > 0;
}
```

Add convenience function at the bottom of the file alongside existing ones:
```typescript
export function updateSessionTokens(sessionId: string, inputTokens: number, outputTokens: number): boolean {
  return getSessionStore().updateSessionTokens(sessionId, inputTokens, outputTokens);
}
```

**Step 4: Run test to verify it passes**
```
cd apps/daemon && pnpm test
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/session.store.ts
git commit -m "feat(daemon): add input_tokens/output_tokens columns to sessions table (V24 migration)"
```

---

### Task 2: Parse and persist token counts from Claude stream
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`

**Purpose:** The Claude Code CLI emits a `result` event at the end of each session containing token usage. Capture this and persist it.

**Not In Scope:** Parsing mid-session token counts or estimating tokens. Only the final `result` event.

**Gotchas:** The `result` event is emitted on the PTY stream as a JSON line. The session service already parses stream-json events (see how `session_id` is captured in the `system` event handler, ~line 1224). Follow the same pattern.

**Step 1: Write the failing test**

The token parsing can be unit-tested by extracting the logic into a small helper:
```typescript
// apps/daemon/src/services/session/__tests__/session.service.test.ts (append to existing file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTokensFromResultEvent } from '../session.service.js';

test('extractTokensFromResultEvent parses usage from result event', () => {
  const event = {
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: { input_tokens: 1500, output_tokens: 300 }
  };
  const tokens = extractTokensFromResultEvent(event);
  assert.deepEqual(tokens, { inputTokens: 1500, outputTokens: 300 });
});

test('extractTokensFromResultEvent returns null when no usage', () => {
  const event = { type: 'result', subtype: 'error', result: 'failed' };
  const tokens = extractTokensFromResultEvent(event);
  assert.equal(tokens, null);
});
```

**Step 2: Run test to verify it fails**
```
cd apps/daemon && pnpm test
```
Expected: FAIL — function doesn't exist yet

**Step 3: Implement**

In `apps/daemon/src/services/session/session.service.ts`, export a pure helper function:
```typescript
export function extractTokensFromResultEvent(
  event: Record<string, unknown>
): { inputTokens: number; outputTokens: number } | null {
  const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  if (!usage?.input_tokens || !usage?.output_tokens) return null;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}
```

In the PTY `onData` handler where stream-json events are parsed (find the section that handles `event.type === 'system'` for session ID capture, ~line 1224), add handling for `result` events alongside it:
```typescript
if (event.type === 'result') {
  const tokens = extractTokensFromResultEvent(event);
  if (tokens) {
    updateSessionTokens(sessionId, tokens.inputTokens, tokens.outputTokens);
  }
}
```

**Step 4: Run test to verify it passes**
```
cd apps/daemon && pnpm test
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/services/session/session.service.ts
git commit -m "feat(daemon): parse and persist token counts from Claude result event"
```

---

### Task 3: Expose token counts in sessions API responses
**Depends on:** Task 2
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/server/routes/sessions.routes.ts`
- Modify: `packages/shared/src/types/` (Session type if defined there, else in the routes file)

**Purpose:** The frontend needs token counts to display them. Add them to the session API response.

**Gotchas:** Check how `TicketSessionResponse` and `Session` types are defined. They may be in `packages/shared/src/types/` or inlined in the routes file. Find them with Glob before editing.

**Step 1: Write the failing test**
```typescript
// apps/daemon/src/server/routes/__tests__/sessions.routes.test.ts (append to existing or create)
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('GET /api/projects/:projectId/tickets/:ticketId/sessions includes inputTokens and outputTokens', async () => {
  // Insert a session row with input_tokens=1000 and output_tokens=200
  // Call the route handler or make a supertest request
  // Assert the response body contains inputTokens: 1000, outputTokens: 200
  // This is a light integration test — adapt to whatever test harness exists for routes
});
```

**Step 2: Run test to verify it fails**
```
cd apps/daemon && pnpm test
```
Expected: FAIL — fields not yet in response

**Step 3: Find the Session response type**
```
Glob: packages/shared/src/types/**/*.ts
Grep: "TicketSessionResponse\|interface Session" in apps/daemon/src/server/routes/sessions.routes.ts
```

**Step 4: Add token fields to the response type**
Add to the relevant interface/type:
```typescript
inputTokens: number | null;
outputTokens: number | null;
```

**Step 5: Map from DB row in the route handler**

In `apps/daemon/src/server/routes/sessions.routes.ts`, in the route that maps session rows to responses (the `GET /api/projects/:projectId/tickets/:ticketId/sessions` route, ~line 82), add:
```typescript
inputTokens: session.input_tokens ?? null,
outputTokens: session.output_tokens ?? null,
```

Also update the `GET /api/sessions` route (~line 72) similarly.

**Step 6: Update frontend API types**

In `apps/frontend/src/hooks/queries.ts`, find the `useTicketSessions` and `useSessions` hooks and ensure the mapped type includes the new fields. They likely derive from shared types — update those too.

**Step 7: Run test to verify it passes**
```
cd apps/daemon && pnpm test
```
Expected: PASS

**Step 8: Commit**
```
git add apps/daemon/src/server/routes/sessions.routes.ts packages/shared/src/types/
git commit -m "feat(api): expose input_tokens and output_tokens in sessions API responses"
```

---

### Task 4: Display token counts in SessionsTab and completion notifications
**Depends on:** Task 3
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/ticket-detail/SessionsTab.tsx`
- Modify: `apps/frontend/src/components/sessions/SessionCard.tsx`
- Modify: `apps/daemon/src/services/session/session.service.ts` (for completion notification)

**Purpose:** Surface token counts in exactly two places: the session detail in SessionsTab and the session completion notification text.

**Not In Scope:** Token counts on task cards, running totals in the header or sidebar, aggregate stats anywhere.

**Step 1: Write the failing frontend test**
```typescript
// apps/frontend/src/components/ticket-detail/SessionsTab.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

describe('SessionsTab token display', () => {
  it('shows token count when session has token data', () => {
    const session = buildMockSession({ inputTokens: 8400, outputTokens: 1200 });
    render(<SessionsTabCard session={session} />);
    expect(screen.getByText(/9,600 tokens/)).toBeInTheDocument();
  });

  it('omits token count when session has no token data', () => {
    const session = buildMockSession({ inputTokens: null, outputTokens: null });
    render(<SessionsTabCard session={session} />);
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**
```
cd apps/frontend && pnpm test
```
Expected: FAIL

**Step 3: Add token display to SessionsTab.tsx**

In the inline `SessionCard` component inside `SessionsTab.tsx` (~line 91), after the duration display, add:
```tsx
{session.inputTokens != null && session.outputTokens != null && (
  <span className="text-xs text-muted-foreground">
    {((session.inputTokens + session.outputTokens) / 1000).toFixed(1)}k tokens
  </span>
)}
```

**Step 4: Add token count to session completion notification**

In `apps/daemon/src/services/session/session.service.ts`, find where session completion is notified (the `chat_notify` call or equivalent after session ends). Append the token count when available:

```typescript
const tokenSuffix = inputTokens != null
  ? ` · ${((inputTokens + outputTokens) / 1000).toFixed(1)}k tokens`
  : '';
// Append tokenSuffix to the existing notification message string
```

**Step 5: Run test to verify it passes**
```
cd apps/frontend && pnpm test
```
Expected: PASS

**Step 6: Commit**
```
git add apps/frontend/src/components/ticket-detail/SessionsTab.tsx apps/frontend/src/components/sessions/SessionCard.tsx apps/daemon/src/services/session/session.service.ts
git commit -m "feat(ui): show token counts in session detail and completion notifications"
```

---

## Track B: Ralph Loop Resume for Doer Agents

### Task 5: Add `resumeOnRalphRetry` type + schema changes
**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/types/template.types.ts` (lines 49-55)
- Modify: `apps/daemon/src/types/orchestration.types.ts` (lines 26-32)
- Modify: `apps/daemon/templates/workflows/workflow.schema.json`

**Purpose:** Add the opt-in flag and the state field needed to store the session ID across ralph loop iterations.

**Step 1: Verify typecheck fails before change**
```
cd apps/daemon && pnpm typecheck
```
Expected: no error yet (field not on type, so usage would fail — we'll add usage in a downstream task). Skip this step and proceed directly to implementation; typecheck after Step 3 will confirm correctness.

**Step 2: Implement type changes**

In `apps/daemon/src/types/template.types.ts`, update `AgentWorker`:
```typescript
export interface AgentWorker extends BaseWorker {
  type: "agent";
  source: string;
  disallowTools?: string[];
  modelTier?: ModelTier | ModelTierMap;
  model?: ModelSpec;
  resumeOnRalphRetry?: boolean;  // When true: on ralph loop retry, resume this agent's previous session instead of spawning fresh
}
```

In `apps/daemon/src/types/orchestration.types.ts`, update `RalphLoopState`:
```typescript
export interface RalphLoopState extends BaseWorkerState {
  type: "ralphLoop";
  iteration: number;
  maxAttempts?: number;
  workerIndex: number;
  activeWorker: WorkerState | null;
  lastDoerClaudeSessionId?: string;  // Claude session ID of the most recent doer agent run, for --resume on retry
}
```

In `apps/daemon/templates/workflows/workflow.schema.json`, find the agent worker definition in the schema and add:
```json
"resumeOnRalphRetry": {
  "type": "boolean",
  "description": "When true, resume the previous Claude session on ralph loop retry instead of spawning fresh"
}
```

**Step 3: Run typecheck to verify changes are valid**
```
cd apps/daemon && pnpm typecheck
```
Expected: PASS (no TypeScript errors)

**Step 4: Commit**
```
git add apps/daemon/src/types/template.types.ts apps/daemon/src/types/orchestration.types.ts apps/daemon/templates/workflows/workflow.schema.json
git commit -m "feat(types): add resumeOnRalphRetry to AgentWorker and lastDoerClaudeSessionId to RalphLoopState"
```

---

### Task 6: Capture doer session ID in processNestedCompletion
**Depends on:** Task 5
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/worker-executor.ts` (lines 802-873)

**Purpose:** When a doer agent completes inside a ralph loop (whether approved or rejected), capture its Claude session ID into the RalphLoopState before the state resets for the next iteration.

**Gotchas:** The session ID must be captured from the DB (via `getActiveSessionForTicket` or similar) because the PTY process has already exited by this point. The claude_session_id field is set by `updateClaudeSessionId` during streaming.

**Step 1: Write the failing test**

Extract the state-mutation logic into a pure helper `captureDoerSessionIdIfNeeded(ralphState, agentWorker, claudeSessionId)` and test it directly:
```typescript
// apps/daemon/src/services/session/__tests__/worker-executor.test.ts (new file or append to existing)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDoerSessionIdIfNeeded } from '../worker-executor.js';

test('captureDoerSessionIdIfNeeded sets lastDoerClaudeSessionId when agent has resumeOnRalphRetry', () => {
  const ralphState = { type: 'ralphLoop', iteration: 0, workerIndex: 0, activeWorker: null };
  const agentWorker = { id: 'builder-agent', type: 'agent', source: 'agents/builder.md', resumeOnRalphRetry: true };
  captureDoerSessionIdIfNeeded(ralphState, agentWorker, 'claude-session-abc123');
  assert.equal(ralphState.lastDoerClaudeSessionId, 'claude-session-abc123');
});

test('captureDoerSessionIdIfNeeded does nothing when agent lacks resumeOnRalphRetry', () => {
  const ralphState = { type: 'ralphLoop', iteration: 0, workerIndex: 0, activeWorker: null };
  const agentWorker = { id: 'verify-spec-agent', type: 'agent', source: 'agents/verify-spec.md' };
  captureDoerSessionIdIfNeeded(ralphState, agentWorker, 'claude-session-xyz');
  assert.equal(ralphState.lastDoerClaudeSessionId, undefined);
});
```

**Step 2: Run test to verify it fails**
```
cd apps/daemon && pnpm test
```
Expected: FAIL — `captureDoerSessionIdIfNeeded` not exported yet

**Step 3: Implement**

Export a pure helper function from `apps/daemon/src/services/session/worker-executor.ts`:
```typescript
export function captureDoerSessionIdIfNeeded(
  ralphState: RalphLoopState,
  agentWorker: AgentWorker,
  claudeSessionId: string
): void {
  if (agentWorker.resumeOnRalphRetry) {
    ralphState.lastDoerClaudeSessionId = claudeSessionId;
  }
}
```

Then in `processNestedCompletion` (~line 837), call it before `handleRalphLoopAgentCompletion`:
```typescript
const currentWorker = getCurrentWorker(ralphWorker, ralphState);
if (currentWorker && isAgentWorker(currentWorker)) {
  const activeSession = getActiveSessionForTicket(ticketId);
  if (activeSession?.claude_session_id) {
    captureDoerSessionIdIfNeeded(ralphState as RalphLoopState, currentWorker, activeSession.claude_session_id);
  }
}
```

**Gotchas:** Import `getActiveSessionForTicket` from `session.store.ts` if not already imported. Ensure this runs before the `handleRalphLoopAgentCompletion` call that resets `workerIndex`.

**Step 4: Run test to verify it passes**
```
cd apps/daemon && pnpm test
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/src/services/session/worker-executor.ts
git commit -m "feat(daemon): capture doer agent claude session ID in RalphLoopState on completion"
```

---

### Task 7: Pass resume session ID through executeNextWorker → spawnAgent
**Depends on:** Task 6
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/worker-executor.ts` (lines 406-507, ~line 65)

**Purpose:** When spawning a doer agent on a retry iteration, pass the stored `lastDoerClaudeSessionId` through the callback chain.

**Step 1: Update `ExecutorCallbacks.spawnAgent` signature**

Find the `ExecutorCallbacks` interface (~line 65 in worker-executor.ts). Update `spawnAgent`:
```typescript
spawnAgent: (
  agentWorker: AgentWorker,
  taskContext?: TaskContext,
  ralphContext?: { phaseId: string; ralphLoopId: string; taskId: string | null },
  phaseEntryContext?: PhaseEntryContext,
  resumeClaudeSessionId?: string,  // <-- new optional param
) => Promise<string>;
```

**Step 2: Update `executeNextWorker` to pass the ID**

In `executeNextWorker` (~line 425-463), when calling `callbacks.spawnAgent`, check if we're in a ralph loop retry with a doer agent that has the flag:

```typescript
// When spawning an agent inside a ralph loop:
const resumeSessionId =
  parentRalphState?.lastDoerClaudeSessionId &&
  agentWorker.resumeOnRalphRetry &&
  parentRalphState.iteration > 0  // iteration 0 is the first attempt, always fresh
    ? parentRalphState.lastDoerClaudeSessionId
    : undefined;

await callbacks.spawnAgent(agentWorker, taskContext, ralphContext, phaseEntryContext, resumeSessionId);
```

**Gotchas:** The `parentRalphState` must be accessible at the agent spawn point. `executeNextWorker` is called recursively; ensure the parent ralph state is passed down through the call chain. You may need to add a `parentState?: RalphLoopState` parameter to track this.

**Step 3: Commit**
```
git add apps/daemon/src/services/session/worker-executor.ts
git commit -m "feat(daemon): thread resumeClaudeSessionId through spawnAgent callback for ralph retry"
```

---

### Task 8: Use resume session ID in spawnAgentWorker
**Depends on:** Task 7
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts` (lines 1720-1907)

**Purpose:** Accept the explicit resume session ID in `spawnAgentWorker` and bypass the continuity compatibility check when it's provided. Also trim the "Previous Attempts" prompt injection when resuming.

**Not In Scope:** Modifying the continuity policy for non-ralph-resume cases. Only bypass when `resumeClaudeSessionId` is explicitly provided.

**Step 1: Update `spawnAgentWorker` signature**

At ~line 1720:
```typescript
async spawnAgentWorker(
  projectId: string,
  ticketId: string,
  phase: TicketPhase,
  projectPath: string,
  agentWorker: AgentWorker,
  taskContext?: TaskContext,
  ralphContext?: { phaseId: string; ralphLoopId: string; taskId: string | null },
  phaseEntryContext?: PhaseEntryContext,
  resumeClaudeSessionId?: string,  // <-- new optional param
): Promise<string>
```

**Step 2: Use the resume session ID, bypassing continuity**

In `spawnAgentWorker`, find where the continuity decision is made (~line 1779-1836). Add an early-out when `resumeClaudeSessionId` is provided:
```typescript
let continuityDecision: ContinuityDecision;
if (resumeClaudeSessionId) {
  // Explicit resume from ralph retry — bypass compatibility check
  continuityDecision = {
    action: 'resume',
    claudeSessionId: resumeClaudeSessionId,
    reason: 'ralph_retry_resume',
  };
} else {
  // Existing continuity logic
  continuityDecision = await this.buildContinuityDecision(/* ... */);
}
```

**Step 3: Trim "Previous Attempts" injection when resuming**

In `buildAgentPrompt` or wherever previous ralph attempts are injected into the prompt, add a guard:
```typescript
// Only inject previous attempts section when NOT resuming
// (on resume, the agent already has full context of what it did)
if (!isResuming) {
  promptSections.push(buildPreviousAttemptsSection(attempts));
} else {
  // Just send the rejection reason as the new user message
  promptSections.push(`Previous attempt was rejected. Reason: ${latestRejectionReason}. Please address this and complete the task.`);
}
```

**Step 4: Commit**
```
git add apps/daemon/src/services/session/session.service.ts
git commit -m "feat(daemon): use explicit resumeClaudeSessionId in spawnAgentWorker, trim Previous Attempts on resume"
```

---

### Task 9: Configure workflow.json for ralph resume on doer agents
**Depends on:** Task 8
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/workflow.json`

**Purpose:** Enable the feature for the three doer agents: refinement, architect, builder.

**Step 1: Add flag to doer agents in workflow.json**

```json
// refinement-agent (currently ~line 18):
{
  "id": "refinement-agent",
  "type": "agent",
  "source": "agents/refinement.md",
  "description": "Creates refinement draft from brainstorm",
  "modelTier": "high",
  "resumeOnRalphRetry": true
}

// architect-agent (currently ~line 61):
{
  "id": "architect-agent",
  "type": "agent",
  "source": "agents/architect.md",
  "description": "Creates architecture draft from refinement",
  "disallowTools": ["Skill(superpowers:*)"],
  "modelTier": "high",
  "resumeOnRalphRetry": true
}

// builder-agent (currently ~line 156):
{
  "id": "builder-agent",
  "type": "agent",
  "source": "agents/builder.md",
  "description": "Executes individual build tickets from specification",
  "disallowTools": ["Skill(superpowers:*)"],
  "modelTier": "low",
  "resumeOnRalphRetry": true
}
```

**Step 2: Typecheck**
```
cd apps/daemon && pnpm typecheck
```
Expected: no errors

**Step 3: Commit**
```
git add apps/daemon/templates/workflows/product-development/workflow.json
git commit -m "feat(workflow): enable resumeOnRalphRetry for refinement, architect, and builder agents"
```

---

## Track C: MCP Tool Filtering

### Task 10: Pass agent source env var to MCP proxy
**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts` (find where MCP proxy env vars are set)
- Modify: `apps/daemon/src/mcp/proxy.ts`

**Purpose:** The MCP proxy needs to know which agent it's serving so it can request a filtered tool list. Currently only `POTATO_AGENT_MODEL` is passed.

**Gotchas:** Find where the MCP proxy process is spawned and its env vars are set. Search for `POTATO_AGENT_MODEL` in session.service.ts to find the exact location.

**Step 1: Find the proxy spawn location**
```
Grep: "POTATO_AGENT_MODEL" in apps/daemon/src/services/session/session.service.ts
```

**Step 2: Add POTATO_AGENT_SOURCE to the proxy env**

At the location found above, add alongside `POTATO_AGENT_MODEL`:
```typescript
POTATO_AGENT_SOURCE: agentWorker.source,  // e.g., "agents/builder.md"
```

**Step 3: Read the new env var in proxy.ts**

In `apps/daemon/src/mcp/proxy.ts` (~line 23-27, alongside the other const declarations), add:
```typescript
const agentSource = process.env.POTATO_AGENT_SOURCE ?? '';
```

**Step 4: Send agentSource on ListTools request**

Update the `fetchTools` function (~line 39) to accept and pass agentSource as a query param:
```typescript
async function fetchTools(daemonUrl: string, agentSource?: string): Promise<unknown[]> {
  try {
    const url = new URL(`${daemonUrl}/mcp/tools`);
    if (agentSource) url.searchParams.set('agentSource', agentSource);
    const response = await fetch(url.toString());
    const data = await response.json();
    return data.tools || [];
  } catch (error) {
    console.error('[MCP Proxy] Failed to fetch tools:', (error as Error).message);
    return [];
  }
}
```
Then in the `ListToolsRequestSchema` handler (~line 83), pass `agentSource`:
```typescript
cachedTools = await fetchTools(daemonUrl, agentSource);
```

**Step 5: Write and run test for fetchTools URL construction**

Extract `buildToolsUrl(daemonUrl, agentSource, projectId)` as a pure helper and test it:
```typescript
// apps/daemon/src/mcp/__tests__/proxy.test.ts (new file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsUrl } from '../proxy.js';

test('buildToolsUrl includes agentSource and projectId as query params', () => {
  const url = buildToolsUrl('http://localhost:8443', 'agents/builder.md', 'proj-123');
  assert.ok(url.includes('agentSource=agents%2Fbuilder.md'));
  assert.ok(url.includes('projectId=proj-123'));
});

test('buildToolsUrl omits params when not provided', () => {
  const url = buildToolsUrl('http://localhost:8443', '', '');
  assert.ok(!url.includes('agentSource'));
  assert.ok(!url.includes('projectId'));
});
```
```
cd apps/daemon && pnpm test
```
Expected: PASS after implementing the helper.

**Step 6: Commit**
```
git add apps/daemon/src/services/session/session.service.ts apps/daemon/src/mcp/proxy.ts
git commit -m "feat(mcp): pass POTATO_AGENT_SOURCE to proxy and include in ListTools request"
```

---

### Task 11: Filter tool list by agent source in daemon
**Depends on:** Task 10
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/routes/` (find the `/mcp/tools` route)
- Modify: related service if tool list is built in a service layer

**Purpose:** The daemon's `/mcp/tools` endpoint should accept `?agentSource=agents/builder.md` and apply the agent's `disallowTools` list from the workflow config.

**Gotchas:** The daemon needs the project's workflow config to look up the agent's `disallowTools`. This requires `projectId` in the request context, which is already in the proxy's env. Add `projectId` to the ListTools request alongside `agentSource`.

**Step 1: Find the /mcp/tools route**
```
Grep: "/mcp/tools" in apps/daemon/src/
```

**Step 2: Update proxy to also send projectId**

In `apps/daemon/src/mcp/proxy.ts`, also add `projectId` to the ListTools URL params:
```typescript
if (projectId) url.searchParams.set('projectId', projectId);
```

**Step 3: Update the tools route to filter**

In the tools route handler:
```typescript
const { agentSource, projectId } = req.query as { agentSource?: string; projectId?: string };

let tools = getAllTools(); // existing logic

if (agentSource && projectId) {
  const agentWorker = findAgentWorkerInWorkflow(projectId, agentSource);
  if (agentWorker?.disallowTools?.length) {
    tools = tools.filter(tool =>
      !agentWorker.disallowTools!.some(pattern => matchesTool(tool.name, pattern))
    );
  }
}
```

Implement `findAgentWorkerInWorkflow` as a helper that loads the project's workflow config and finds the agent matching `agentSource`. Reuse any existing workflow-loading logic.

**Step 4: Write and run test for filterToolsByDisallowList**

Extract the filtering logic into a pure helper and test it:
```typescript
// apps/daemon/src/server/routes/__tests__/mcp-tools.test.ts (new file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterToolsByDisallowList } from '../mcp-tools-filter.js';  // or wherever the helper lives

test('filterToolsByDisallowList removes tools matching disallowTools patterns', () => {
  const tools = [
    { name: 'create_task' },
    { name: 'ralph_loop_dock' },
    { name: 'chat_notify' },
    { name: 'attach_artifact' },
  ];
  const disallowTools = ['create_task', 'attach_artifact'];
  const result = filterToolsByDisallowList(tools, disallowTools);
  assert.deepEqual(result.map(t => t.name), ['ralph_loop_dock', 'chat_notify']);
});

test('filterToolsByDisallowList returns all tools when disallowList is empty', () => {
  const tools = [{ name: 'create_task' }, { name: 'ralph_loop_dock' }];
  const result = filterToolsByDisallowList(tools, []);
  assert.equal(result.length, 2);
});
```
```
cd apps/daemon && pnpm test
```
Expected: PASS after implementing the helper.

**Step 5: Commit**
```
git add apps/daemon/src/server/routes/ apps/daemon/src/mcp/proxy.ts
git commit -m "feat(mcp): filter tool list by agent's disallowTools config at ListTools time"
```

---

### Task 12: Add disallowTools to reviewer agents in workflow.json
**Depends on:** Task 11
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/workflow.json`

**Purpose:** Reviewer agents (verify-spec, verify-quality, adversarial agents) only need a small subset of tools. Add `disallowTools` to restrict them to what they actually need.

**Not In Scope:** Restricting tools for non-reviewer agents beyond what's already configured.

**Step 1: Identify minimal tool sets**

Reviewer agents need: `ralph_loop_dock`, `chat_notify`, `chat_ask`. They do NOT need task creation, artifact management, scope tools, etc.

**Step 2: Add disallowTools**

```json
// verify-spec-agent — add disallowTools:
{
  "id": "verify-spec-agent",
  "type": "agent",
  "source": "agents/verify-spec.md",
  "description": "Verifies the specification of the individual build tasks against the specification",
  "modelTier": "low",
  "disallowTools": [
    "create_task", "update_task_status", "add_comment_to_task",
    "attach_artifact", "list_artifacts",
    "get_scope_context", "get_sibling_tickets", "get_dependents",
    "set_plan_summary", "add_dependency", "delete_dependency",
    "create_ticket", "Skill(superpowers:*)"
  ]
}

// verify-quality-agent — same:
{
  "id": "verify-quality-agent",
  "type": "agent",
  "source": "agents/verify-quality.md",
  "description": "Verifies the quality of the individual build task code",
  "modelTier": "high",
  "disallowTools": [
    "TodoWrite",
    "create_task", "update_task_status", "add_comment_to_task",
    "attach_artifact", "list_artifacts",
    "get_scope_context", "get_sibling_tickets", "get_dependents",
    "set_plan_summary", "add_dependency", "delete_dependency",
    "create_ticket"
  ]
}
```

Apply similar lists to adversarial-refinement-agent and adversarial-architect-agent.

**Step 3: Typecheck**
```
cd apps/daemon && pnpm typecheck
```

**Step 4: Validate workflow.json parses and agents are found**

Run the existing workflow loading path (or add a test that loads the workflow and asserts `disallowTools` is present on reviewer agents):
```typescript
// apps/daemon/src/__tests__/workflow-config.test.ts (new file or append)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('reviewer agents in workflow.json have disallowTools configured', () => {
  const workflowPath = path.resolve('templates/workflows/product-development/workflow.json');
  const workflow = JSON.parse(readFileSync(workflowPath, 'utf-8'));
  const allWorkers = workflow.phases.flatMap((p: any) => p.workers ?? []);
  const flattenWorkers = (workers: any[]): any[] =>
    workers.flatMap(w => [w, ...(w.workers ? flattenWorkers(w.workers) : [])]);
  const flat = flattenWorkers(allWorkers);
  const reviewers = ['verify-spec-agent', 'verify-quality-agent'];
  for (const id of reviewers) {
    const agent = flat.find((w: any) => w.id === id);
    assert.ok(agent, `agent ${id} not found`);
    assert.ok(Array.isArray(agent.disallowTools) && agent.disallowTools.length > 0, `${id} missing disallowTools`);
  }
});
```
```
cd apps/daemon && pnpm test
```
Expected: PASS

**Step 5: Commit**
```
git add apps/daemon/templates/workflows/product-development/workflow.json
git commit -m "feat(workflow): add restrictive disallowTools to reviewer agents to reduce tool schema tokens"
```

---

## Track D: Shared.md Split

### Task 13: Split shared.md and update agent-loader
**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/daemon/templates/workflows/product-development/agents/shared-core.md`
- Create: `apps/daemon/templates/workflows/product-development/agents/shared-scope.md`
- Modify (then delete): `apps/daemon/templates/workflows/product-development/agents/shared.md`
- Modify: `apps/daemon/src/services/session/agent-loader.ts`

**Purpose:** The current `shared.md` prepends scope/dependency content to every agent. Only agents using scope/dependency tools need it. Split to avoid sending unnecessary tokens to reviewers.

**Not In Scope:** Changing which tools agents have access to (that's Task 12). This is purely about the prompt preamble.

**Step 1: Create shared-core.md**

Content: any content from `shared.md` that is universally relevant (ticket metadata conventions, general instructions). If `shared.md` is entirely scope-specific, `shared-core.md` can be empty or minimal.

Read `agents/shared.md` first to understand the split:
```
Read: apps/daemon/templates/workflows/product-development/agents/shared.md
```

**Step 2: Create shared-scope.md**

Content: the Scope Context and Ticket Dependencies sections from the current `shared.md` (the content about `get_sibling_tickets`, `get_dependencies`, and cross-ticket artifact access).

**Step 3: Write the failing test for loadSharedPreamble**

Extract `loadSharedPreamble` as an exported function and test it:
```typescript
// apps/daemon/src/services/session/__tests__/agent-loader.test.ts (new file or append)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

test('loadSharedPreamble without scope does not include scope content', async () => {
  // Create a temp project dir with shared-core.md and shared-scope.md
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loader-test-'));
  const agentsDir = path.join(tmpDir, 'agents');
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(path.join(agentsDir, 'shared-core.md'), 'CORE CONTENT');
  await fs.writeFile(path.join(agentsDir, 'shared-scope.md'), 'SCOPE CONTENT');
  // Call loadSharedPreamble with a mock projectId pointing to tmpDir
  // Assert result contains "CORE CONTENT" but not "SCOPE CONTENT"
  await fs.rm(tmpDir, { recursive: true });
});

test('loadSharedPreamble with includeScope=true includes scope content', async () => {
  // Same setup, call with includeScope=true
  // Assert result contains both "CORE CONTENT" and "SCOPE CONTENT"
});
```
```
cd apps/daemon && pnpm test
```
Expected: FAIL — `loadSharedPreamble` not yet exported / files don't exist

**Step 4: Update agent-loader.ts**

In `apps/daemon/src/services/session/agent-loader.ts`, update `loadSharedPreamble` (~line 72-86) to accept a flag:

```typescript
export async function loadSharedPreamble(
  projectId: string,
  includeScope = false
): Promise<string> {
  const core = await loadPromptFile(projectId, 'agents/shared-core.md');
  if (!includeScope) return core;
  const scope = await loadPromptFile(projectId, 'agents/shared-scope.md');
  return [core, scope].filter(Boolean).join('\n\n---\n\n');
}
```

Update `loadAgentDefinition` to pass `includeScope` based on whether the agent uses scope tools. Scope-using agents are: refinement-agent, architect-agent, specification-agent, builder-agent, taskmaster-agent. Reviewers and adversarial agents do NOT get scope content.

**Chosen approach:** Check the agent `source` filename against a hardcoded set of known scope-using agent filenames (e.g., `['refinement.md', 'architect.md', 'specification.md', 'builder.md', 'taskmaster.md']`). Do NOT add another flag to `AgentWorker` — that flag would be redundant with `disallowTools` already configured on those agents and would double the surface area for config drift.

**Step 5: Run test to verify it passes**
```
cd apps/daemon && pnpm test
```
Expected: PASS

**Step 6: Verify no references to old shared.md remain**
```
Grep: "shared\.md" in apps/daemon/src/
```
Expected: zero matches (all references updated to shared-core.md / shared-scope.md)

**Step 7: Delete old shared.md**
```
git rm apps/daemon/templates/workflows/product-development/agents/shared.md
```

**Step 8: Full typecheck**
```
pnpm typecheck
```
Expected: no errors

**Step 9: Commit**
```
git add apps/daemon/templates/workflows/product-development/agents/
git add apps/daemon/src/services/session/agent-loader.ts
git commit -m "feat(workflow): split shared.md into shared-core + shared-scope, scope preamble only for agents that need it"
```

---

## Track E: Documentation Updates

### Task 14: Update sub-documentation for changed subsystems
**Depends on:** Tasks 1-13 (all implementation complete)
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/mcp/CLAUDE.md` (document agentSource/projectId query params on /mcp/tools, tool filtering behavior)
- Modify: `apps/daemon/src/services/session/CLAUDE.md` (document resumeOnRalphRetry, lastDoerClaudeSessionId, ralph retry resume flow)
- Modify: `apps/daemon/templates/workflows/CLAUDE.md` (document resumeOnRalphRetry and disallowTools fields in agent worker schema)
- Modify: `apps/daemon/src/stores/CLAUDE.md` (document new input_tokens/output_tokens columns on sessions table, updateSessionTokens API)

**Purpose:** Keep sub-documentation in sync with the new features so future implementers understand the system correctly.

**Step 1: Update each CLAUDE.md with the relevant new API surface**

- In `mcp/CLAUDE.md`: Add a section noting that `/mcp/tools` accepts `?agentSource=` and `?projectId=` query params, and that tools are filtered per agent's `disallowTools` config at ListTools time.
- In `session/CLAUDE.md`: Add a section on the ralph resume mechanism: `resumeOnRalphRetry` flag, `lastDoerClaudeSessionId` in RalphLoopState, and the `resumeClaudeSessionId` param threaded through `spawnAgentWorker`.
- In `workflows/CLAUDE.md`: Add `resumeOnRalphRetry` and `disallowTools` to the agent worker field table with descriptions.
- In `stores/CLAUDE.md`: Add `input_tokens` and `output_tokens` to the sessions table schema section, and document `updateSessionTokens()`.

**Step 2: Commit**
```
git add apps/daemon/src/mcp/CLAUDE.md apps/daemon/src/services/session/CLAUDE.md apps/daemon/templates/workflows/CLAUDE.md apps/daemon/src/stores/CLAUDE.md
git commit -m "docs: update CLAUDE.md files for token observability, ralph resume, and tool filtering"
```

---

## Implementation Order

```
Track A (Observability):   Task 1 → Task 2 → Task 3 → Task 4
Track B (Ralph Resume):    Task 5 → Task 6 → Task 7 → Task 8 → Task 9
Track C (Tool Filtering):  Task 10 → Task 11 → Task 12
Track D (Shared.md):       Task 13
Track E (Docs):            Task 14 (after all other tracks)
```

All four tracks are independent and can be parallelized. Within each track, tasks are sequential.

**Suggested parallel dispatch:**
- Agent 1: Track A (Tasks 1-4)
- Agent 2: Track B (Tasks 5-9)
- Agent 3: Tracks C + D (Tasks 10-13)
- After all agents complete: Task 14 (documentation updates)

---

## Testing the Full Integration

After all tracks complete:

```bash
# Build and typecheck everything
pnpm build && pnpm typecheck

# Run all tests
pnpm test

# Manual smoke test:
# 1. Start daemon: pnpm dev:daemon
# 2. Start frontend: pnpm dev:frontend
# 3. Create a ticket and run it through the Build phase
# 4. Verify:
#    - Session Viewer shows token count after each session completes
#    - Completion notification includes token count
#    - ralph loop retry uses --resume for builder (check daemon logs for "ralph_retry_resume")
#    - MCP proxy logs show filtered tool count for reviewer agents
```

---

## Risk Notes

### R1: Parallel track merge conflicts on session.service.ts (HIGH)
**Affected tasks:** Task 2 (Track A), Task 8 (Track B), Task 10 (Track C)
**Risk:** All three tasks modify `apps/daemon/src/services/session/session.service.ts`. With the suggested parallel dispatch (Agent 1 = Track A, Agent 2 = Track B, Agent 3 = Track C+D), Tasks 2, 8, and 10 will produce conflicting commits in the same file and require manual merge resolution.
**Mitigation:** Agent 3 should complete Task 10's changes to `session.service.ts` (adding `POTATO_AGENT_SOURCE` to env) in a separate short commit before or after Track A/B land. Alternatively, assign all `session.service.ts` edits to a single agent sequentially. At minimum: merge Track A first, then rebase Track B and C on top.

### R2: Ralph resume captures wrong Claude session ID on chained retries (MEDIUM)
**Affected tasks:** Task 6, Task 7, Task 8
**Risk:** The existing code (session.service.ts line 1175) explicitly documents: *"Don't overwrite claude_session_id for resumed sessions — Claude gives resumed sessions a new transient ID, but --resume only works with the original ID."* If `captureDoerSessionIdIfNeeded` in Task 6 reads `getActiveSessionForTicket()` after a `--resume` run, the stored `claude_session_id` may be the transient new ID rather than the original resumable ID. Passing this on iteration 3+ would cause `--resume` to fail or start a fresh session silently.
**Mitigation:** In Task 6's `captureDoerSessionIdIfNeeded`, read the `claude_session_id` from the session row that was started at the *beginning* of the current iteration (before PTY exit), or alternatively store it at session spawn time rather than at completion time. The session spawn path already has the `existingClaudeSessionId` variable (line 2119) — capture it there and pass it through to the state update rather than re-reading from the DB at completion time.

### R3: POTATO_AGENT_SOURCE path traversal in /mcp/tools endpoint (MEDIUM)
**Affected tasks:** Task 10, Task 11
**Risk:** `agentSource` (e.g., `agents/builder.md`) flows from an env var set at spawn time into a URL query param, then into the daemon's workflow-config lookup. If `findAgentWorkerInWorkflow` in Task 11 uses `agentSource` as a file path component without sanitization, a malicious or misconfigured value (e.g., `../../etc/passwd`) could cause path traversal when loading files.
**Mitigation:** In Task 11's route handler, validate that `agentSource` matches the expected format (e.g., `^agents/[\w\-]+\.md$`) before using it. Since `POTATO_AGENT_SOURCE` is set by the daemon itself (not user input), severity is low in production, but the sanitization guard is still good practice.

### R4: shared.md deletion in Task 13 has no documented rollback (LOW)
**Affected tasks:** Task 13
**Risk:** Deleting `shared.md` and splitting into `shared-core.md` / `shared-scope.md` is irreversible without a git revert. If `agent-loader.ts` has a bug in production (e.g., `loadSharedPreamble` silently returns empty string for some agents), all agents lose their preamble context until a fix is deployed.
**Mitigation:** (1) Run `pnpm test` and `pnpm typecheck` before the `git rm` commit in Step 7. (2) The file is recoverable via `git revert` or `git show HEAD~1:apps/daemon/templates/workflows/product-development/agents/shared.md > shared.md` if needed — note this explicitly in the task. (3) The test in Step 3 that validates `loadSharedPreamble` covers the main regression path.

### R5: DB migration rollback (LOW / ACCEPTABLE)
**Affected tasks:** Task 1
**Risk:** V24 migration adds two nullable INTEGER columns. SQLite does not support `DROP COLUMN` in older versions (supported from 3.35.0). If a rollback to V23 is needed, the columns cannot be removed without recreating the table.
**Assessment:** Acceptable risk. The columns are nullable with no defaults, causing zero impact on existing code. Rollback by reverting the application code is sufficient — the extra columns in the DB are harmless.

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | ✓ | All four optimization tracks fully specified with TDD steps, implementation guidance, and integration smoke tests |
| Accurate | ✓ (fixed) | Schema path corrected: workflow.schema.json is shared top-level, not inside product-development subdirectory (3 edits) |
| Commands valid | ✓ | All test/build commands match CLAUDE.md conventions |
| YAGNI | ✓ | Every task maps directly to a stated goal; no speculative infrastructure |
| Minimal | ✓ | Tasks are appropriately granular; none could be eliminated without losing a required feature |
| Not over-engineered | ✓ | Reuses existing patterns throughout (env-var pattern, disallowTools, loadSharedPreamble extension point) |
| Key Decisions documented | ✓ | Five key decisions with rationale documented |
| Context sections present | ✓ | Purpose and Not In Scope present on all non-obvious tasks; Gotchas provide implementation-critical context |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | CLEAN | 0 | All required sections present; 13 deliverables with dependencies; Key Decisions with rationale. No structural gaps. |
| Feasibility | EDITED | 4 | Fixed daemon test paths (__tests__/ subdirectory convention), replaced nonexistent openTestDb() helper, fixed relative import path in Task 2 test, corrected proxy.ts line reference to fetchTools(). |
| Completeness | EDITED | 8 | Added test steps to Tasks 3, 6, 10, 11, 12, 13; added verification step before destructive git rm in Task 13; added Task 14 for CLAUDE.md documentation updates. |
| Risk | EDITED | 1 | Added Risk Notes section covering 5 risks: parallel merge conflicts on session.service.ts, session ID capture timing on chained retries, POTATO_AGENT_SOURCE path traversal, shared.md deletion rollback, SQLite migration rollback. |
| Optimality | EDITED | 3 | Fixed Task 5 TDD step (TypeScript interface validated via typecheck, not runtime test); resolved Task 13 ambiguous implementation choice to simpler hardcoded list approach. All 14 tasks serve stated requirements. |
