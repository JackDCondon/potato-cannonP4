# Model Tier Provider Routing Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Replace workflow-level vendor model names with provider-agnostic `modelTier` routing, add global default provider plus per-project provider override, and resolve tiers to concrete models at runtime without changing ticket complexity semantics.
**Architecture:** Workflows continue routing by ticket or task `complexity`, but they now route to `modelTier` values (`low`, `mid`, `high`) instead of provider model names. Runtime resolution then selects the effective provider from global config or project override and maps the chosen tier to a concrete model string before the existing session spawn path runs. Invalid legacy workflow config (`model`, `opus`, `sonnet`, `haiku`) becomes a hard error instead of silently falling back.
**Tech Stack:** TypeScript monorepo, Node test runner in daemon, React + Vitest in frontend, SQLite-backed config/project stores, JSON workflow templates.
**Key Decisions:**
- **Keep complexity separate from tiers:** `simple|standard|complex` remains ticket/task complexity, while `low|mid|high` becomes agent runtime intent. This preserves the current workflow behavior where a simple ticket can still route to a high-tier worker.
- **Use `modelTier` instead of overloading `model`:** Renaming the field makes the new meaning explicit and prevents future agents from assuming the value is a provider model ID.
- **Hard cutover, no compatibility bridge:** Legacy workflow config should fail fast so the repo can be corrected once and not carry migration code indefinitely.
- **Add provider selection now, but keep the current spawn path:** Global default provider plus per-project override is enough architectural surface for this feature; the selected provider still resolves to a concrete model string and flows through the current Claude session spawn path.
- **Fail early during template load and spawn:** JSON schema updates alone are not enough because template loading currently uses `JSON.parse` without strict schema enforcement. Runtime validation must reject old fields and old values before work starts.
---

## Implementation Notes For The Executor

- I'm using the `writing-plans` skill to create the implementation plan.
- Apply `test-driven-development` on each task before implementation changes.
- Use `rule-of-five-code` for non-trivial code changes and `verification-before-completion` before claiming the refactor is done.
- Do not add a compatibility bridge for `model` or legacy model names. Any workflow that still uses them should fail with a clear error message.
- Do not change ticket complexity behavior. This plan intentionally preserves the existing `simple|standard|complex` routing input.
- Keep provider selection scope to:
  - global default provider
  - optional project override
- Do not add workflow-level provider overrides in this feature.
- Do not attempt a full non-Claude runtime abstraction here. The selected provider only needs to supply a concrete model string to the current session runtime.

## Required Outcome

After this refactor:

- Workflow workers use `modelTier`, not `model`
- `modelTier` accepts either:
  - a single tier string: `low | mid | high`
  - or a complexity map: `{ simple, standard, complex }` whose values are `low | mid | high`
- Global config stores:
  - a default provider id
  - an array of AI providers, each with `low|mid|high` model mappings
- Project config optionally stores a provider override
- Runtime resolves:
  - effective provider from project override or global default
  - effective tier from worker `modelTier` plus task/ticket complexity
  - final concrete model from provider tier mapping
- Legacy workflow config using `model` or `opus|sonnet|haiku` fails fast during template read/validation and again during session spawn if invalid data leaks through

## Non-Goals

- Full provider runtime abstraction or non-Claude execution parity
- Workflow-level provider overrides
- Automatic migration of existing user templates outside the repository
- Keeping old `model` fields working temporarily
- Reinterpreting ticket complexity as model tier

## Task 1: Introduce Shared Tier Types And Rename Worker Field
**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `packages/shared/src/types/template.types.ts`
- Modify: `packages/shared/src/types/worker.types.ts`
- Modify: `packages/shared/src/types/project.types.ts`
- Modify: `apps/daemon/src/types/template.types.ts`
- Modify: `apps/daemon/src/types/config.types.ts`
- Test: `apps/daemon/src/services/session/__tests__/model-tier-resolver.test.ts`

**Purpose:** Establish a single source of truth for `ModelTier`, `ModelTierMap`, AI provider config, and project provider override before touching runtime logic.

**Not In Scope:** Runtime behavior, UI, routes, or workflow template edits.

**Gotchas:** `packages/shared` and daemon local types are currently not symmetrical; the executor must update both deliberately instead of assuming one re-exports the other.

**Step 1: Write the failing test**
Create `apps/daemon/src/services/session/__tests__/model-tier-resolver.test.ts` with assertions that import the new tier types and fail because the resolver file/types do not exist yet.

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveModelTier } from "../model-tier-resolver.js";

describe("resolveModelTier", () => {
  it("selects a direct tier string unchanged", () => {
    assert.strictEqual(resolveModelTier("high", "simple"), "high");
  });
});
```

**Step 2: Run test to verify it fails**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/model-tier-resolver.test.js
```
Expected: FAIL because `model-tier-resolver.ts` and the new type shapes do not exist yet.

**Step 3: Write minimal implementation**
- In `packages/shared/src/types/template.types.ts`:
  - add `export type ModelTier = 'low' | 'mid' | 'high'`
  - add `export interface ModelTierMap { simple?: ModelTier; standard?: ModelTier; complex?: ModelTier }`
  - replace `TemplateAgent['model']` with `modelTier?: ModelTier | ModelTierMap`
- In `packages/shared/src/types/worker.types.ts`:
  - replace any `model?: string` field with `modelTier?: ModelTier | ModelTierMap`
- In `packages/shared/src/types/project.types.ts`:
  - add `providerOverride?: string`
- In `apps/daemon/src/types/template.types.ts`:
  - replace `ModelSpec`/`ComplexityModelMap` with `ModelTier`/`ModelTierMap`
  - add a strict type guard for tier maps
  - rename `AgentWorker.model` to `AgentWorker.modelTier`
- In `apps/daemon/src/types/config.types.ts`:
  - add `AiProviderConfig`, `AiConfig`, and `providerOverride?: string` on `Project`

**Step 4: Run test to verify it passes**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/model-tier-resolver.test.js
```
Expected: still FAIL on missing resolver details if only the types are done; this task is complete when the types compile cleanly and the test failure moves from missing types to missing resolver behavior.

**Step 5: Commit**
```bash
git add packages/shared/src/types/template.types.ts packages/shared/src/types/worker.types.ts packages/shared/src/types/project.types.ts apps/daemon/src/types/template.types.ts apps/daemon/src/types/config.types.ts apps/daemon/src/services/session/__tests__/model-tier-resolver.test.ts
git commit -m "refactor: introduce model tier types"
```

## Task 2: Extend Config And Project Persistence For Provider Routing
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/project.store.ts`
- Modify: `apps/daemon/src/stores/config.store.ts`
- Modify: `apps/daemon/src/stores/__tests__/migrations.test.ts`
- Modify: `apps/daemon/src/stores/__tests__/project.store.test.ts`
- Modify: `apps/daemon/src/stores/__tests__/config.store.test.ts`

**Purpose:** Persist the new AI provider settings and project-level provider override so runtime selection has stable data.

**Not In Scope:** HTTP routes or frontend forms.

**Gotchas:** `config` is already SQLite-backed but still normalized through file-based legacy defaults; both code paths must understand the new `ai` section.

**Step 1: Write the failing tests**
- In `apps/daemon/src/stores/__tests__/migrations.test.ts`, add a test asserting the schema version increments and the `projects` table contains `provider_override`.
- In `apps/daemon/src/stores/__tests__/project.store.test.ts`, add a test that `providerOverride` round-trips through create/update/get.
- In `apps/daemon/src/stores/__tests__/config.store.test.ts`, add tests that:
  - `normalize*Config` applies defaults for `ai.defaultProvider` and `ai.providers`
  - config store round-trips AI config

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/stores/__tests__/migrations.test.js dist/stores/__tests__/project.store.test.js dist/stores/__tests__/config.store.test.js
```
Expected: FAIL because schema, row mapping, and config normalization do not support the new fields yet.

**Step 3: Write minimal implementation**
- In `apps/daemon/src/stores/migrations.ts`:
  - add a new migration that:
    - bumps schema version
    - adds `provider_override TEXT` to `projects`
- In `apps/daemon/src/stores/project.store.ts`:
  - read/write `provider_override`
  - include `providerOverride` in `rowToProject`, `createProject`, and `updateProject`
- In `apps/daemon/src/stores/config.store.ts`:
  - add `DEFAULT_AI_CONFIG`
  - normalize `config.ai.defaultProvider`
  - normalize `config.ai.providers` as an array with valid provider entries
  - keep existing legacy config behavior untouched outside the new `ai` branch

**Step 4: Run tests to verify they pass**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/stores/__tests__/migrations.test.js dist/stores/__tests__/project.store.test.js dist/stores/__tests__/config.store.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/project.store.ts apps/daemon/src/stores/config.store.ts apps/daemon/src/stores/__tests__/migrations.test.ts apps/daemon/src/stores/__tests__/project.store.test.ts apps/daemon/src/stores/__tests__/config.store.test.ts
git commit -m "feat: persist ai provider routing config"
```

## Task 3: Add Global AI Config API And Frontend Global Settings UI
**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/routes/config.routes.ts`
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Modify: `apps/frontend/src/routes/global-configure.tsx`
- Create: `apps/daemon/src/server/__tests__/config.routes.test.ts`
- Create: `apps/frontend/src/routes/global-configure.test.tsx`

**Purpose:** Expose default provider selection and provider-tier mappings through the existing global settings surface.

**Not In Scope:** Project-specific provider override UI.

**Gotchas:** The current global config API only exposes Perforce settings, so response and request shapes must be expanded without regressing that page’s existing behavior.

**Step 1: Write the failing tests**
- Add daemon route tests for:
  - `GET /api/config/global` returning `ai.defaultProvider` and `ai.providers`
  - `PUT /api/config/global/ai` validating payload shape and saving config
- Add frontend route tests for:
  - loading existing AI config
  - editing default provider
  - editing a provider’s `low|mid|high` mappings
  - preserving Perforce controls

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/frontend exec vitest run src/routes/global-configure.test.tsx
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/server/__tests__/config.routes.test.js
```
Expected: FAIL because the API and UI do not expose AI config yet.

**Step 3: Write minimal implementation**
- In `apps/daemon/src/server/routes/config.routes.ts`:
  - extend `GET /api/config/global`
  - add `PUT /api/config/global/ai`
  - validate:
    - non-empty `defaultProvider`
    - unique provider ids
    - each provider has `models.low`, `models.mid`, `models.high`
- In `apps/frontend/src/api/client.ts`:
  - extend `GlobalConfigResponse`
  - add `updateAiGlobalConfig(...)`
- In `apps/frontend/src/hooks/queries.ts`:
  - add mutation hooks if needed, or keep route-local calls if simpler
- In `apps/frontend/src/routes/global-configure.tsx`:
  - keep Perforce section intact
  - add an AI settings section with:
    - default provider select
    - editable provider rows/cards
    - fields for low/mid/high concrete model names

**Step 4: Run tests to verify they pass**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/frontend exec vitest run src/routes/global-configure.test.tsx
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/server/__tests__/config.routes.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/server/routes/config.routes.ts apps/frontend/src/api/client.ts apps/frontend/src/hooks/queries.ts apps/frontend/src/routes/global-configure.tsx apps/daemon/src/server/__tests__/config.routes.test.ts apps/frontend/src/routes/global-configure.test.tsx
git commit -m "feat: add global ai provider settings"
```

## Task 4: Add Project Provider Override To Project API And Configure UI
**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/server/routes/projects.routes.ts`
- Modify: `apps/frontend/src/api/client.ts`
- Modify: `apps/frontend/src/hooks/queries.ts`
- Modify: `apps/frontend/src/components/configure/ConfigurePage.tsx`
- Modify: `apps/frontend/src/components/configure/ConfigurePage.test.tsx`
- Modify: `apps/daemon/src/server/__tests__/projects.routes.test.ts`

**Purpose:** Let each project opt into a provider override while inheriting the global default when unset.

**Not In Scope:** Workflow-level provider overrides.

**Gotchas:** The configure page currently only loads project data, not global config; the executor can either fetch global config directly in the page or add a lightweight shared hook, but should not over-abstract this.

**Step 1: Write the failing tests**
- Add daemon route tests for PATCHing `providerOverride`
- Add frontend tests for:
  - rendering provider override select
  - saving a provider override
  - clearing the override back to inherited/default behavior

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/frontend exec vitest run src/components/configure/ConfigurePage.test.tsx
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/server/__tests__/projects.routes.test.js
```
Expected: FAIL because neither the route nor UI handles `providerOverride`.

**Step 3: Write minimal implementation**
- In `apps/daemon/src/server/routes/projects.routes.ts`:
  - include `providerOverride` in GET project payloads
  - accept and persist `providerOverride` in PATCH
- In frontend API/hooks:
  - add `providerOverride?: string | null` to update payloads
- In `ConfigurePage.tsx`:
  - fetch global AI config for provider options
  - add a select field:
    - `Inherited (defaultProvider)`
    - each configured provider id

**Step 4: Run tests to verify they pass**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/frontend exec vitest run src/components/configure/ConfigurePage.test.tsx
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/server/__tests__/projects.routes.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/server/routes/projects.routes.ts apps/frontend/src/api/client.ts apps/frontend/src/hooks/queries.ts apps/frontend/src/components/configure/ConfigurePage.tsx apps/frontend/src/components/configure/ConfigurePage.test.tsx apps/daemon/src/server/__tests__/projects.routes.test.ts
git commit -m "feat: add project ai provider override"
```

## Task 5: Replace Workflow `model` With `modelTier` In Schema, Editor, And Shared UI Types
**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/templates/workflows/workflow.schema.json`
- Modify: `packages/shared/src/types/template.types.ts`
- Modify: `apps/frontend/src/components/templates/AgentCard.tsx`
- Create: `apps/frontend/src/components/templates/AgentCard.test.tsx`

**Purpose:** Make `modelTier` the only valid workflow authoring field and update the template editor to author tier maps instead of model maps.

**Not In Scope:** Runtime resolution or template file content changes.

**Gotchas:** The template editor currently defaults to `haiku|sonnet|opus`; those defaults must become `low|mid|high`, and any helper names should stop saying “model” unless they refer to the final concrete provider model.

**Step 1: Write the failing test**
Create `apps/frontend/src/components/templates/AgentCard.test.tsx` asserting that:
- the editor labels the section as tier routing
- selects show `low|mid|high`
- changes write `agent.modelTier`, not `agent.model`

**Step 2: Run test to verify it fails**
Run:
```bash
pnpm --filter @potato-cannon/frontend exec vitest run src/components/templates/AgentCard.test.tsx
```
Expected: FAIL because the component still reads and writes `model`.

**Step 3: Write minimal implementation**
- In `workflow.schema.json`:
  - remove `model`
  - add `modelTier`
  - allow:
    - single string enum `low|mid|high`
    - complexity map whose values are `low|mid|high`
- In `AgentCard.tsx`:
  - rename helper functions to `getTierMatrix`
  - default to `{ simple: 'low', standard: 'mid', complex: 'high' }`
  - write `onChange({ ...agent, modelTier: next })`
  - update labels from “Model Routing” to “Tier Routing”

**Step 4: Run test to verify it passes**
Run:
```bash
pnpm --filter @potato-cannon/frontend exec vitest run src/components/templates/AgentCard.test.tsx
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/templates/workflows/workflow.schema.json packages/shared/src/types/template.types.ts apps/frontend/src/components/templates/AgentCard.tsx apps/frontend/src/components/templates/AgentCard.test.tsx
git commit -m "refactor: rename workflow model routing to model tiers"
```

## Task 6: Add Strict Workflow Validation For `modelTier` And Legacy Rejection
**Depends on:** Task 1, Task 5
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/stores/template.store.ts`
- Modify: `apps/daemon/src/stores/__tests__/template.store.test.ts`
- Modify: `apps/daemon/src/stores/__tests__/template.store.workflow-context.test.ts`

**Purpose:** Enforce the new contract during template load because schema files alone are not currently protecting runtime reads.

**Not In Scope:** Session execution. This task only ensures invalid workflow files never become valid runtime objects.

**Gotchas:** `template.store.ts` currently uses raw `JSON.parse`; the validator should be a small local runtime validator, not a large new schema-validation dependency, unless the repo already has a preferred validator hiding elsewhere.

**Step 1: Write the failing tests**
Add tests proving `getWorkflow(...)` or the relevant template-loading path:
- accepts `modelTier`
- rejects:
  - `model`
  - `opus`
  - `sonnet`
  - `haiku`
  - invalid tier strings

Use temporary workflow fixture directories in the test, not the bundled templates.

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/stores/__tests__/template.store.test.js dist/stores/__tests__/template.store.workflow-context.test.js
```
Expected: FAIL because template loading currently accepts raw JSON without semantic validation.

**Step 3: Write minimal implementation**
- In `template.store.ts`, add validation helpers such as:
  - `isModelTier(...)`
  - `assertValidModelTierConfig(...)`
  - `assertNoLegacyModelConfig(...)`
- Call validation immediately after parsing workflow JSON in every load path
- Throw actionable errors, for example:
  - `Workflow template "product-development" uses deprecated field "model"; use "modelTier".`
  - `Workflow template "bug-fix" uses invalid legacy model value "opus"; use "high".`

**Step 4: Run tests to verify they pass**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/stores/__tests__/template.store.test.js dist/stores/__tests__/template.store.workflow-context.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/stores/template.store.ts apps/daemon/src/stores/__tests__/template.store.test.ts apps/daemon/src/stores/__tests__/template.store.workflow-context.test.ts
git commit -m "feat: validate model tier workflow config strictly"
```

## Task 7: Implement Tier And Provider Model Resolution
**Depends on:** Task 1, Task 2
**Complexity:** complex
**Files:**
- Create: `apps/daemon/src/services/session/model-tier-resolver.ts`
- Modify: `apps/daemon/src/services/session/__tests__/model-tier-resolver.test.ts`
- Modify: `apps/daemon/src/services/session/__tests__/session.service.test.ts`

**Purpose:** Replace Anthropic-specific model resolution with provider-aware tier resolution while preserving the existing complexity-driven behavior.

**Not In Scope:** Actual session spawn changes; this task stops at pure resolution and tests.

**Gotchas:** The resolver must not treat complexity as tier. Complexity chooses among configured tier values; the resulting tier is then mapped through the selected provider.

**Step 1: Expand the failing tests**
Add resolver coverage for:
- direct `modelTier: "high"`
- complexity map resolution:
  - `simple -> low`
  - `standard -> mid`
  - `complex -> high`
- provider selection precedence:
  - project override wins
  - otherwise global default
- provider model lookup:
  - `high -> opus`, etc.
- missing provider
- missing tier mapping
- invalid legacy strings rejected

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/model-tier-resolver.test.js dist/services/session/__tests__/session.service.test.js
```
Expected: FAIL because the resolver logic is still Anthropic/model-name based.

**Step 3: Write minimal implementation**
Create `model-tier-resolver.ts` with small focused functions:

```ts
export function resolveModelTier(
  modelTier: ModelTier | ModelTierMap | undefined,
  complexity?: Complexity | null,
): ModelTier | null

export function resolveEffectiveProvider(
  project: { providerOverride?: string },
  config: GlobalConfig,
): AiProviderConfig

export function resolveConcreteModelForWorker(input: {
  modelTier: ModelTier | ModelTierMap | undefined;
  complexity?: Complexity | null;
  project: { providerOverride?: string };
  config: GlobalConfig;
}): { providerId: string; tier: ModelTier; model: string } | null
```

Keep the file pure and dependency-light so it is easy to test directly.

**Step 4: Run tests to verify they pass**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/model-tier-resolver.test.js dist/services/session/__tests__/session.service.test.js
```
Expected: PASS for pure resolver behavior; `session.service` integration may still fail until Task 8 lands.

**Step 5: Commit**
```bash
git add apps/daemon/src/services/session/model-tier-resolver.ts apps/daemon/src/services/session/__tests__/model-tier-resolver.test.ts apps/daemon/src/services/session/__tests__/session.service.test.ts
git commit -m "feat: resolve model tiers through provider routing"
```

## Task 8: Wire Session Execution To Provider-Aware Tier Resolution And Add Hard Guards
**Depends on:** Task 4, Task 6, Task 7
**Complexity:** complex
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/services/session/continuity.types.ts`
- Modify: `apps/daemon/src/services/session/continuity-policy.ts`
- Modify: `apps/daemon/src/services/session/__tests__/session.service.test.ts`
- Modify: `apps/daemon/src/stores/__tests__/session.store.test.ts`

**Purpose:** Use the new resolver to produce the final concrete model string and keep continuity/session metadata coherent.

**Not In Scope:** Non-Claude runtime abstraction, artifact chat, summarization, or marketplace changes.

**Gotchas:** Session metadata currently stores `model` as a string for continuity and diagnostics. Keep storing the resolved concrete model there unless a compelling reason appears during implementation; do not expand scope to store tiers everywhere.

**Step 1: Write the failing tests**
Extend `session.service.test.ts` to prove:
- agent worker reads `modelTier`
- task complexity still affects the chosen tier
- project override changes the resolved concrete model
- invalid legacy config throws before spawn

Add or update store tests only if session metadata shape needs a contract assertion.

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/session.service.test.js dist/stores/__tests__/session.store.test.js
```
Expected: FAIL because `session.service.ts` still imports and uses the old model resolver and worker field.

**Step 3: Write minimal implementation**
- In `session.service.ts`:
  - replace `resolveModel(...)` import with `resolveConcreteModelForWorker(...)`
  - compute active provider from project + global config
  - resolve final model string before calling spawn
  - retain `--model <resolved-model>` behavior
  - throw on invalid worker config instead of defaulting silently
- Keep continuity metadata on the resolved concrete model string so existing comparison logic remains simple

**Step 4: Run tests to verify they pass**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/session.service.test.js dist/stores/__tests__/session.store.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/src/services/session/session.service.ts apps/daemon/src/services/session/continuity.types.ts apps/daemon/src/services/session/continuity-policy.ts apps/daemon/src/services/session/__tests__/session.service.test.ts apps/daemon/src/stores/__tests__/session.store.test.ts
git commit -m "refactor: route session models through provider tiers"
```

## Task 9: Update Bundled Workflow Templates And Workflow Docs
**Depends on:** Task 5, Task 6
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/templates/workflows/product-development/workflow.json`
- Modify: `apps/daemon/templates/workflows/product-development-p4/workflow.json`
- Modify: `apps/daemon/templates/workflows/bug-fix/workflow.json`
- Modify: `apps/daemon/templates/workflows/CLAUDE.md`
- Modify: `apps/daemon/templates/workflows/product-development/changelog.md`

**Purpose:** Correct the canonical templates and template documentation so the repo itself no longer models the old concept.

**Not In Scope:** Editing historical plan documents under `docs/plans/` except where this plan tells the executor to document the new behavior.

**Gotchas:** Some workers may use a direct single value while others use complexity maps. Preserve the existing complexity behavior, only swap the outputs from model names to tiers.

**Step 1: Write the failing test**
Add or extend a daemon template-store test to assert the bundled workflows load successfully after the schema/validator changes.

**Step 2: Run test to verify it fails**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/stores/__tests__/template.store.test.js
```
Expected: FAIL until bundled workflows stop using `model` and old values.

**Step 3: Write minimal implementation**
- Replace every worker `model` key with `modelTier`
- Replace direct values:
  - `haiku -> low`
  - `sonnet -> mid`
  - `opus -> high`
- Replace complexity maps so their values are tiers, not provider model names
- Update `CLAUDE.md` documentation to describe `modelTier`
- Update changelog text away from Claude-specific naming in workflow authoring

**Step 4: Run test to verify it passes**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/stores/__tests__/template.store.test.js
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/daemon/templates/workflows/product-development/workflow.json apps/daemon/templates/workflows/product-development-p4/workflow.json apps/daemon/templates/workflows/bug-fix/workflow.json apps/daemon/templates/workflows/CLAUDE.md apps/daemon/templates/workflows/product-development/changelog.md
git commit -m "refactor: update bundled workflows to model tiers"
```

## Task 10: Update User-Facing Workflow/Board Displays From Model Names To Tiers
**Depends on:** Task 5, Task 8, Task 9
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/board/AgentPromptEditor.tsx`
- Modify: `apps/frontend/src/components/board/SwimlaneBackside.tsx`
- Modify: `apps/frontend/src/components/board/WorkerTree.tsx`
- Modify: `apps/frontend/src/components/board/WorkerTreeItem.tsx`
- Modify: `apps/frontend/src/components/board/Board.test.tsx`
- Modify: `apps/frontend/src/components/board/TicketCard.test.tsx`

**Purpose:** Make the visible workflow UI consistent with the new terminology so users do not keep seeing stale model labels after the backend changes.

**Not In Scope:** Reworking layout or broader board UX.

**Gotchas:** Some components only display the resolved value pulled from workflow metadata; they should show the tier label, not try to resolve or display the concrete provider model there.

**Step 1: Write the failing tests**
Add or update component tests asserting:
- tier badges/rendering use `low|mid|high`
- prompt editors and worker details no longer mention `model`

**Step 2: Run tests to verify they fail**
Run:
```bash
pnpm --filter @potato-cannon/frontend exec vitest run src/components/board/Board.test.tsx src/components/board/TicketCard.test.tsx
```
Expected: FAIL where assertions still expect `model` labels or old props.

**Step 3: Write minimal implementation**
- Rename props and labels from `model` to `modelTier` where they reflect workflow config
- Update badges/tooltips/copy to say `Tier` or `Model Tier`
- Do not expose resolved provider model names in these workflow authoring views

**Step 4: Run tests to verify they pass**
Run:
```bash
pnpm --filter @potato-cannon/frontend exec vitest run src/components/board/Board.test.tsx src/components/board/TicketCard.test.tsx
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/frontend/src/components/board/AgentPromptEditor.tsx apps/frontend/src/components/board/SwimlaneBackside.tsx apps/frontend/src/components/board/WorkerTree.tsx apps/frontend/src/components/board/WorkerTreeItem.tsx apps/frontend/src/components/board/Board.test.tsx apps/frontend/src/components/board/TicketCard.test.tsx
git commit -m "refactor: update workflow ui to model tier terminology"
```

## Task 11: Document The New Config Contract And Run Full Verification
**Depends on:** Task 3, Task 4, Task 8, Task 9, Task 10
**Complexity:** standard
**Files:**
- Modify: `README.md`
- Modify: `apps/daemon/src/stores/CLAUDE.md`
- Modify: `docs/plans/2026-03-12-model-tier-provider-routing-plan.md`

**Purpose:** Leave the repo in a teachable state for the weaker implementation agent and future maintainers, with final verification captured in the same plan artifact.

**Not In Scope:** Historical plan cleanup or cross-repo migration docs.

**Gotchas:** Only update docs that describe current behavior; do not rewrite old historical design records as if they were current implementation truth.

**Step 1: Write the doc changes**
- In `README.md`, document:
  - workflow `modelTier`
  - global default provider
  - project override
- In `apps/daemon/src/stores/CLAUDE.md`, add any relevant config/project field updates if that file documents persisted shapes

**Step 2: Run focused verification**
Run:
```bash
pnpm --filter @potato-cannon/shared build
pnpm --filter @potato-cannon/daemon build
pnpm --filter @potato-cannon/frontend build
pnpm typecheck
pnpm --filter @potato-cannon/daemon exec node --experimental-test-module-mocks --test dist/services/session/__tests__/model-tier-resolver.test.js dist/services/session/__tests__/session.service.test.js dist/stores/__tests__/config.store.test.js dist/stores/__tests__/project.store.test.js dist/stores/__tests__/template.store.test.js dist/server/__tests__/projects.routes.test.js dist/server/__tests__/config.routes.test.js
pnpm --filter @potato-cannon/frontend exec vitest run src/routes/global-configure.test.tsx src/components/configure/ConfigurePage.test.tsx src/components/templates/AgentCard.test.tsx src/components/board/Board.test.tsx src/components/board/TicketCard.test.tsx
```
Expected:
- builds PASS
- typecheck PASS
- targeted daemon tests PASS
- targeted frontend tests PASS

**Step 3: Manual verification**
1. Open global settings and set:
   - default provider `anthropic`
   - mappings `low=haiku`, `mid=sonnet`, `high=opus`
2. Open a project and set provider override to a non-default provider from config.
3. Open workflow editor and confirm workers edit `modelTier`, not `model`.
4. Trigger a ticket in each complexity band and confirm the resolved spawn model matches:
   - worker `modelTier` routing by complexity
   - project override or inherited provider
5. Intentionally set a bundled or test workflow to use `model: "opus"` and confirm template load fails with a clear error.

**Step 4: Final commit**
```bash
git add README.md apps/daemon/src/stores/CLAUDE.md docs/plans/2026-03-12-model-tier-provider-routing-plan.md
git commit -m "docs: document model tier provider routing"
```

## Plan Verification Checklist

- **Complete:** Covers type system, persistence, API, UI, runtime resolution, bundled templates, validation, and verification.
- **Accurate:** All referenced files exist today except newly created tests; template loading behavior was verified and currently uses raw `JSON.parse`.
- **Commands valid:** Build/test commands match the current repo scripts; daemon tests target built `dist/**/*.test.js` files and frontend tests use `vitest run`.
- **YAGNI:** Scope stops at provider selection and tier resolution; it explicitly excludes workflow-level provider overrides and a full provider runtime abstraction.
- **Minimal:** The plan reuses existing config, project, template, and session seams instead of introducing a new orchestration subsystem.
- **Not over-engineered:** Provider selection resolves to a concrete model string and continues through the existing spawn path.
- **Key Decisions documented:** Yes, in the header.
- **Context sections present:** Each task includes purpose, dependencies, files, and boundary notes where needed.

## Rule-Of-Five Review Record

### Pass 1: Draft
- Result: PASS
- Notes: The plan has a complete end-to-end structure with tasks covering types, persistence, routes, UI, validation, runtime, templates, and verification.

### Pass 2: Feasibility
- Result: PASS
- Notes: File paths were verified against the repository. The main feasibility adjustment was adding explicit template-load validation because the repo does not currently enforce `workflow.schema.json` during `JSON.parse`.

### Pass 3: Completeness
- Result: PASS
- Notes: All confirmed requirements map to tasks:
  - `modelTier` rename
  - tier values `low|mid|high`
  - complexity remains distinct
  - global default provider
  - per-project override
  - shipped template updates
  - no fallback for legacy model names

### Pass 4: Risk
- Result: PASS
- Notes: Main risks are partial cutover and hidden old `model` usage. The plan mitigates this with strict template validation, spawn-time guards, bundled template updates, and targeted UI updates.

### Pass 5: Optimality
- Result: PASS
- Notes: The plan intentionally avoids a full provider-runtime abstraction and avoids workflow-level provider overrides. It makes the smallest architectural change that still gets provider selection and tier-based workflow authoring right.

## Verification Record

**Artifact:** `docs/plans/2026-03-12-model-tier-provider-routing-plan.md`
**Verification Status:** PASS
**Verified On:** 2026-03-12
**Verification Summary:**
- Draft structure complete
- File targets validated against current repo layout
- Commands aligned to current package scripts
- Scope kept to the approved `global + project` provider-selection model
- Risks called out where schema enforcement is currently weak
