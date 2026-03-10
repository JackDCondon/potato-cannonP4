# Agent-Agnostic Provider Routing Plan (Brainstorm Output)

## Summary

This document explores whether Potato Cannon should become agent-provider agnostic so workflows use capability tiers (`deep`, `standard`, `fast`) instead of Claude-specific model names (`opus`, `sonnet`, `haiku`).

Bottom line: this is viable and strategically strong, but only if we first isolate Claude CLI coupling behind a runtime adapter. The coupling is deep in session spawning, resume behavior, artifact chat, system-agent runner, summarization, and marketplace bootstrap.

Recommendation: proceed in staged increments with backward compatibility, starting with a Claude adapter that preserves current behavior while introducing provider-neutral contracts.

## Problem Statement

Today, workflow worker definitions include provider-specific model values. This limits:

- Provider flexibility (OpenAI, Anthropic, future providers)
- Runtime switching at global/project level
- Long-term maintainability of orchestration logic

Desired future state:

- Workflows express intent tiers (`deep`, `standard`, `fast`)
- Global or project-level provider choice determines concrete model mapping
- Session orchestration remains stable regardless of provider backend

## Current State Findings (Codebase Snapshot)

Observed hard coupling points:

1. Session runtime is Claude CLI specific
- `apps/daemon/src/services/session/session.service.ts`
- `spawnClaudeSession()` directly builds Claude flags (`--print`, `--model`, `--resume`, `--mcp-config`)
- Claude-specific session identity persistence (`claudeSessionId`)

2. Model resolution assumes Anthropic naming
- `apps/daemon/src/services/session/model-resolver.ts`
- Recognized shortcuts: `haiku`, `sonnet`, `opus`
- Explicit allowlist behavior for `claude-*` ids and provider `anthropic`

3. Workflow schema and templates are Claude-centric
- `apps/daemon/templates/workflows/workflow.schema.json`
- `apps/daemon/templates/workflows/product-development/workflow.json`
- Many worker `model` fields are `haiku|sonnet|opus`

4. Other runtime surfaces also spawn Claude directly
- `apps/daemon/src/server/routes/artifact-chat.routes.ts`
- `apps/daemon/src/system-agents/runner.ts`
- `apps/daemon/src/services/summarize.ts`
- `apps/daemon/src/marketplace/bootstrap.ts`

5. Executable resolution is Claude-specific
- `apps/daemon/src/utils/resolve-executable.ts` (`resolveClaude()`)

## Goals

- Introduce provider-neutral model tiering: `deep`, `standard`, `fast`
- Support global provider switching with safe defaults
- Preserve current behavior for existing projects/templates during migration
- Avoid regressions in ticket orchestration, ralph loops, task loops, and brainstorm resume

## Non-Goals (Initial Scope)

- Building every provider feature parity on day one
- Rewriting agent prompts
- Removing Claude support
- Solving marketplace plugin parity for non-Claude providers in phase 1

## Approaches

### Option A: Direct Search and Replace (Not Recommended)

Replace model strings in templates and patch session spawn logic ad hoc.

Pros:
- Fastest apparent path

Cons:
- High break risk due to hidden coupling
- No clean extension path for second provider
- Difficult rollback and debugging

Verdict: reject.

### Option B: Provider Adapter Layer + Tier Resolver (Recommended)

Add a runtime abstraction that normalizes:
- Session spawn
- Resume semantics
- Model selection from tiers
- Structured output/event parsing

Workflows reference tier labels, not vendor model names.

Pros:
- Safe migration with compatibility mode
- Enables OpenAI/Claude switching without touching orchestration core
- Clear test boundaries

Cons:
- Medium implementation effort
- Requires careful compatibility mapping

Verdict: best long-term cost and reliability tradeoff.

### Option C: Dual-Schema Transitional Mode

Keep existing `model` and add new `tier`, prefer `tier` when present.

Pros:
- Low migration friction for existing templates

Cons:
- Prolongs mixed configuration complexity
- Requires clear deprecation policy

Verdict: useful as part of Option B rollout, not as a standalone strategy.

## Recommended Architecture

1. Introduce `AgentRuntime` interface
- `spawnInteractiveSession(...)`
- `resumeSession(...)`
- `runOneShot(...)`
- `parseOutputEvent(...)`

2. Implement `ClaudeRuntime` first
- Preserve current CLI behavior and flags
- Keep current session stability while moving call sites to interface

3. Introduce provider-neutral tier resolution
- New type: `ModelTier = 'fast' | 'standard' | 'deep'`
- New resolver maps tier to provider model id via config

4. Add global and project provider config
- Global default provider + tier map
- Optional project override
- Future optional per-workflow override

5. Backward compatibility bridge
- If workflow has `model` string/object, translate to equivalent tier or explicit provider model under ClaudeRuntime
- Warn (not fail) for deprecated model-only configs during transition

## Proposed Migration Plan (No Implementation Yet)

### Phase 0: Design Freeze and Contracts
- Define provider-neutral runtime contracts
- Define config schema for provider + tier mapping
- Decide resume semantics per provider (session token vs conversation id)

### Phase 1: Internal Abstraction Without Behavior Change
- Refactor Claude-only spawn sites to call `AgentRuntime`
- Keep effective behavior identical under ClaudeRuntime
- Add tests proving no regression

### Phase 2: Tier Adoption
- Extend schema to support `tier` on agent workers
- Add compatibility logic for existing `model`
- Update default templates to use tiers

### Phase 3: Provider Selection
- Add global/project setting for provider choice
- Route runtime creation via provider factory
- Keep Claude as default

### Phase 4: Second Provider Pilot (OpenAI or Claude parity mode)
- Implement second runtime adapter with a limited capability subset
- Verify ticket build flow, resume, artifact chat, summarization

### Phase 5: Deprecation and Cleanup
- Mark model-only workflow fields as deprecated
- Provide migration utility/doc
- Remove legacy paths after adoption threshold

## Key Risks and Mitigations

1. Resume semantics mismatch
- Risk: providers differ from Claude `--resume`
- Mitigation: runtime-owned resume contract with adapter-specific persistence

2. Output/event format differences
- Risk: orchestration expects Claude stream-json events
- Mitigation: normalize events in adapter before entering orchestration

3. Remote control behavior is Claude-url specific
- Risk: feature cannot generalize directly
- Mitigation: feature-flag remote control per provider capability

4. Marketplace bootstrap is Claude plugin specific
- Risk: false expectations for non-Claude providers
- Mitigation: explicitly scope marketplace support as Claude-only initially

5. Template ecosystem migration cost
- Risk: user templates still use old model strings
- Mitigation: dual-read compatibility and lint warnings

## Viability Assessment

Worth doing if any of these are true:

- You want provider optionality this quarter
- You want cost routing flexibility independent of vendor naming
- You expect frequent model churn and do not want workflow churn

Not worth doing right now if:

- You will stay Anthropic-only for the next 6-12 months
- Team cannot absorb a medium refactor touching critical execution paths

Current recommendation: proceed, but as an incremental refactor with strict compatibility gates.

## Success Criteria

- Existing workflows run unchanged under ClaudeRuntime
- New workflows can declare `deep|standard|fast` only
- Global provider switch changes backend without workflow edits
- Core pipeline tests pass for both providers in pilot scope
- No regression in session recovery, loop execution, and ticket transitions

## Suggested Implementation File Targets

Primary files likely impacted:

- `apps/daemon/src/services/session/session.service.ts`
- `apps/daemon/src/services/session/model-resolver.ts`
- `apps/daemon/src/utils/resolve-executable.ts`
- `apps/daemon/src/system-agents/runner.ts`
- `apps/daemon/src/server/routes/artifact-chat.routes.ts`
- `apps/daemon/src/services/summarize.ts`
- `apps/daemon/templates/workflows/workflow.schema.json`
- `apps/daemon/templates/workflows/product-development/workflow.json`
- `apps/daemon/src/types/template.types.ts`
- `packages/shared/src/types/template.types.ts`

## Decision Checkpoint

Go forward if you agree to:

- Keep backward compatibility for current templates
- Treat this as a multi-phase refactor, not a one-shot rewrite
- Accept Claude-first abstraction as the safest first milestone

If approved, the next document should be a task-level implementation plan with tests and migration commands.
