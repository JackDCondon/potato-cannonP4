# Token Usage Optimization

**Date:** 2026-03-20
**Status:** Design
**Goal:** Reduce total tokens consumed per ticket to extend Claude subscription credits

## Context

Potato Cannon spawns Claude Code CLI sessions (subscription-based, not API key). Prompt caching (`cache_control`) is off the table. The optimization surface is structural: send fewer tokens per session, and spawn fewer sessions overall.

A single ticket running the default product-development workflow can create **24–49+ Claude sessions**. Every session pays the full context setup cost: CLAUDE.md + 28 MCP tool definitions + agent prompt + ticket context. Savings per session compound across all sessions.

## Scope

Two related problems:

1. **Observability** — surface token usage in the UI so data-driven decisions are possible
2. **Optimization** — structural changes to reduce tokens consumed, based on research findings

---

## Part 1: Token Observability

### Philosophy

Token data should be *discoverable, not prominent*. No counters on every card. Surface data contextually in places where the user is already inspecting a specific session.

### Two surfaces only

**1. Session completion notification (enrich existing)**

When a session completes, append one subtle line to the existing notification:

```
Builder · 12,400 tokens · 2m 14s
```

No new UI, no new screen. More signal in an existing event.

**2. Session Viewer detail panel (on-demand)**

When a session row is clicked in the Session Viewer, the detail panel already shows logs/output. Add a token summary section:

- Input tokens
- Output tokens
- Total tokens

What we explicitly do **not** add:
- Token counts on task cards
- Running totals on the main ticket view
- Any persistent counters in the sidebar or header

### Data source

Claude Code CLI streams JSON events via `--output-format stream-json`. The `result` event at session end contains `usage` with input/output token counts. The session service already processes these events — it just needs to persist the token counts to the `sessions` table and expose them via the API.

**Schema change:** Add `input_tokens INTEGER` and `output_tokens INTEGER` columns to the `sessions` table (migration required).

---

## Part 2: Token Optimization

### 2a. Context-aware MCP tool filtering

**Problem:** All 28 MCP tools are registered for every session regardless of context. A `verify-quality` session that only calls `ralph_loop_dock` still receives 28 tool schemas.

**Solution:** Define a tool allowlist per agent in `workflow.json` (or agent definition). The MCP proxy already reads `agentId` from environment variables — extend it to filter the tool list before returning to Claude.

The existing `disallowTools` field on `AgentWorker` already supports this pattern. We can use it directly, or add an `allowTools` whitelist for clarity.

**Approximate tool sets per agent type:**

| Agent | Tools needed | Count |
|-------|-------------|-------|
| `builder-agent` | task, artifact, chat, ralph | ~10 |
| `verify-spec-agent` | ralph, chat | ~4 |
| `verify-quality-agent` | ralph, chat | ~4 |
| `refinement-agent` | task, artifact, chat, ralph, scope | ~12 |
| `adversarial-*` | ralph, chat | ~4 |
| `taskmaster-agent` | task, chat, ticket | ~8 |

**Files to change:**
- `apps/daemon/templates/workflows/product-development/workflow.json` — add `disallowTools` or `allowTools` per agent
- `apps/daemon/src/mcp/proxy.ts` — apply filter on `ListTools` response

### 2b. Split `shared.md` into scoped preambles

**Problem:** `shared.md` (~1.7KB, covers dependency/scope context) is prepended to every agent prompt. Roughly half the agents never use scope or dependency tools.

**Solution:** Split into two files:

- `shared-core.md` (~300 tokens) — universal content every agent needs
- `shared-scope.md` (~700 tokens) — dependency/scope context, only for agents that use `get_scope_context`, `get_dependencies`, `get_dependents`, `get_sibling_tickets`

Agent definition files reference which preamble(s) to load, or the agent loader infers from `allowTools`.

**Files to change:**
- `apps/daemon/templates/workflows/product-development/agents/shared.md` — split into two files
- `apps/daemon/src/services/session/agent-loader.ts` — update `loadSharedPreamble()` to support scoped loading

### 2c. Ralph loop resume for "doer" agents

**Problem:** On ralph loop retry, the "doer" agent (builder, refinement, architect) gets a completely fresh session with the full prompt rebuilt. Only the "Previous Attempts" section changed. This wastes the entire prior context setup cost.

**Solution:** Add `resumeOnRalphRetry: boolean` to `AgentWorker`. When `true`, the ralph loop stores the Claude session ID from the completed session and passes it via `--resume` on the next iteration.

**Rule: Resume the doer, never the reviewer.**

| Agent | `resumeOnRalphRetry` | Reason |
|-------|---------------------|--------|
| `refinement-agent` | ✓ `true` | Creates the document; needs context of what it wrote |
| `adversarial-refinement-agent` | `false` | Must start fresh for unbiased review |
| `architect-agent` | ✓ `true` | Creates the architecture; needs full prior context |
| `adversarial-architect-agent` | `false` | Must start fresh |
| `builder-agent` | ✓ `true` | Wrote the code; focused fix is cheaper than full rebuild |
| `verify-spec-agent` | `false` | Must start fresh |
| `verify-quality-agent` | `false` | Must start fresh |

**Important nuance:** When resuming, the "Previous Attempts" section currently injected into the prompt is partially redundant — the resumed session already knows what it did. On resume, skip or significantly trim the feedback injection; instead pass only a short message: `"verify-quality rejected. Reason: {reason}. Please address and complete."`

**Implementation touch points:**

1. `packages/shared/src/types/template.types.ts` — add `resumeOnRalphRetry?: boolean` to `AgentWorker`
2. `apps/daemon/src/types/orchestration.types.ts` — add `lastDoerClaudeSessionId?: string` to `RalphLoopState`
3. `apps/daemon/src/services/session/worker-executor.ts`
   - `processNestedCompletion()` (~line 837): capture Claude session ID into `RalphLoopState` before reset
   - `executeNextWorker()` (~line 425): check flag + stored ID, pass to `spawnAgent` callback
4. `apps/daemon/src/services/session/session.service.ts`
   - `spawnAgentWorker()` (~line 1720): accept optional `resumeClaudeSessionId`, bypass continuity compatibility check when set
5. `apps/daemon/templates/workflows/product-development/workflow.json` — set `resumeOnRalphRetry: true` on `refinement-agent`, `architect-agent`, `builder-agent`
6. `apps/daemon/templates/workflows/product-development/workflow.schema.json` — add `resumeOnRalphRetry` to agent worker schema

### 2d. Model tiering for reviewers

**Problem:** `verify-spec` and `verify-quality` are both on Sonnet/Opus. `verify-spec` is a mechanical checklist check ("did we build what was specified?") that does not require deep reasoning.

**Solution:**
- `verify-spec-agent` → Haiku (mechanical checklist, ~20x cheaper than Opus)
- `verify-quality-agent` → keep Sonnet/Opus (deep reasoning, quality judgment)

This follows the same philosophy as `builder-agent` using Haiku: detailed specs eliminate the need for reasoning in mechanical execution tasks. The quality gate lives at `verify-quality`.

**Files to change:**
- `apps/daemon/templates/workflows/product-development/workflow.json` — set `model` or `modelTier` on `verify-spec-agent`

---

## Implementation Order

Ordered by impact-to-effort ratio:

| Priority | Change | Effort | Token Impact |
|----------|--------|--------|-------------|
| 1 | Model tiering: verify-spec → Haiku | Low | Medium — every Build task |
| 2 | Ralph loop resume for doer agents | Medium | High — every retry across all phases |
| 3 | MCP tool filtering | Medium | Medium — every session |
| 4 | Split shared.md | Low | Small-Medium — every session |
| 5 | Token observability (DB + API) | Medium | N/A — visibility only |
| 6 | Token display in Session Viewer + notifications | Medium | N/A — visibility only |

---

## What We Explicitly Did Not Include

- **Prompt caching (`cache_control`)** — API-only feature, not available on Claude subscription
- **Direct Anthropic API calls for reviewers** — too much architectural risk, would lose Claude Code native tools
- **Collapsing verify-spec + verify-quality into one session** — would lose model tiering and risk quality degradation
- **Removing phases or reducing ralph loop `maxAttempts`** — quality trade-off not worth the token saving
