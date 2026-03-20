# Per-Project Perforce Connection Settings Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Add optional per-project `P4Port` and `P4User` overrides with an env-var toggle, visible only in Perforce mode, so teams can connect different projects to different Perforce servers or users without changing the daemon's environment.

**Architecture:** Three new optional fields (`p4UseEnvVars`, `p4Port`, `p4User`) are added to the `Project` type in both the shared and daemon type files. The `P4Provider` gains a private `p4Args()` helper that prepends `-p`/`-u` global flags to every `p4` CLI invocation when the fields are set. The ConfigurePage UI shows a toggle and conditional text fields inside the existing `vcsType === 'perforce'` block.

**Tech Stack:** TypeScript, better-sqlite3, React 19, TanStack Query, Tailwind CSS.

**Key Decisions:**
- **DB migration required (V26):** The `projects` table uses real SQL columns for every per-project setting (see V8–V11 history). There is no JSON blob column for project config. Three new nullable `TEXT`/`INTEGER` columns (`p4_use_env_vars`, `p4_port`, `p4_user`) must be added via `ALTER TABLE` in a new migration (V26). `CURRENT_SCHEMA_VERSION` must be incremented to 26. `rowToProject()` and `updateProject()` in `project.store.ts` must be updated to read/write these columns. Without this, all UI saves are silently discarded and the daemon always falls back to env vars — no error is thrown.
- **`p4UseEnvVars` semantics:** `undefined` and `true` both mean "use env vars". The fields are only forwarded to `P4Provider` when `p4UseEnvVars === false` — so stored values can't accidentally override env when the toggle is on.
- **CLI flags vs env vars for p4 CLI calls:** Per-project values are passed as `-p`/`-u` global CLI flags (not env vars) so they take precedence over any ambient env without mutating the process environment.
- **MCP server uses env vars:** The `perforce-p4-mcp` MCP server is a separate Node process that runs `p4` commands internally; it reads from its own env. So when project overrides are active, `P4PORT`/`P4USER` are injected into the MCP server's `env` object alongside `P4CLIENT`.
- **P4Client excluded:** Workspace names are auto-generated (`potato-{slug}-{ticketId}`) and owned by the daemon lifecycle; user configuration would conflict with this.

---

## Task 0: Add DB migration V26 and update project store

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/stores/migrations.ts`
- Modify: `apps/daemon/src/stores/project.store.ts`

**Purpose:** The `projects` table uses real SQL columns for every per-project setting (V8 added `p4_stream`/`agent_workspace_root`/`helix_swarm_url`; V11 added `p4_mcp_server_path`). There is no JSON blob column. Without this task, `rowToProject()` never returns the new fields and `updateProject()` silently drops saves from the UI — the daemon always falls back to env vars with no error.

**Risk note:** `ALTER TABLE ADD COLUMN` with a NULL default is safe on SQLite even with existing rows. Rollback: existing rows naturally return `NULL` for the new columns, which maps to `undefined` in TypeScript and preserves the env-var default behaviour — so a DB downgrade (removing the columns) is not required; the daemon simply ignores the columns if the code is reverted.

**Step 1: Add migration V26**

In `apps/daemon/src/stores/migrations.ts`:

1. Increment `CURRENT_SCHEMA_VERSION` to `26`.
2. Add a new `if (version < 26)` block and call site in `runMigrations`:

```typescript
if (version < 26) {
  migrateV26(db);
}
```

3. Add the migration function:

```typescript
function migrateV26(db: Database.Database): void {
  db.exec(`
    ALTER TABLE projects ADD COLUMN p4_use_env_vars INTEGER;
    ALTER TABLE projects ADD COLUMN p4_port TEXT;
    ALTER TABLE projects ADD COLUMN p4_user TEXT;
  `);
  db.pragma("user_version = 26");
}
```

**Step 2: Update rowToProject**

In `apps/daemon/src/stores/project.store.ts`, inside `rowToProject()`, after `helixSwarmUrl`:

```typescript
p4UseEnvVars: row.p4_use_env_vars === null || row.p4_use_env_vars === undefined
  ? undefined
  : (row.p4_use_env_vars as number) === 1,
p4Port: (row.p4_port as string) || undefined,
p4User: (row.p4_user as string) || undefined,
```

**Step 3: Update updateProject**

In `apps/daemon/src/stores/project.store.ts`, inside `updateProject()`, after the `helixSwarmUrl` block:

```typescript
if (updates.p4UseEnvVars !== undefined) {
  fields.push("p4_use_env_vars = ?");
  values.push(updates.p4UseEnvVars === null ? null : updates.p4UseEnvVars ? 1 : 0);
}
if (updates.p4Port !== undefined) {
  fields.push("p4_port = ?");
  values.push(updates.p4Port || null);
}
if (updates.p4User !== undefined) {
  fields.push("p4_user = ?");
  values.push(updates.p4User || null);
}
```

**Step 4: Verify typecheck**

```bash
cd apps/daemon && pnpm typecheck
```

Expected: PASS

**Step 5: Run full daemon tests**

```bash
cd apps/daemon && pnpm build && pnpm test
```

Expected: PASS

**Step 6: Commit**

```bash
git add apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/project.store.ts
git commit -m "feat: add DB migration V26 for p4_use_env_vars/p4_port/p4_user columns"
```

---

## Task 1: Add fields to shared Project type

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `packages/shared/src/types/project.types.ts`

**Purpose:** The shared type is the contract between frontend and daemon API responses. All three new fields must be here for the UI to read them.

**Step 1: Write a failing typecheck**

In `packages/shared/src/types/project.types.ts`, reference the new fields in a type assertion comment to confirm they don't exist yet:

```bash
cd packages/shared && pnpm typecheck
```

Expected: PASS (baseline — confirms existing compile state is clean)

**Step 2: Add the fields**

In `packages/shared/src/types/project.types.ts`, after `helixSwarmUrl?: string`:

```typescript
  p4UseEnvVars?: boolean
  p4Port?: string
  p4User?: string
```

**Step 3: Verify typecheck**

```bash
cd packages/shared && pnpm typecheck
```

Expected: PASS

**Step 4: Commit**

```bash
git add packages/shared/src/types/project.types.ts
git commit -m "feat: add p4UseEnvVars, p4Port, p4User to shared Project type"
```

---

## Task 2: Add fields to daemon Project type

**Depends on:** Task 0 (migration must exist before daemon type is extended, to keep store and type in sync)
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/types/config.types.ts`

**Purpose:** The daemon-side `Project` interface (distinct from the shared one) drives factory and store logic. Must mirror the shared type.

**Not In Scope:** Do not add these fields to `GlobalConfig`, `TelegramConfig`, or other types in this file.

**Step 1: Add the fields**

In `apps/daemon/src/types/config.types.ts`, after `helixSwarmUrl?: string`:

```typescript
  p4UseEnvVars?: boolean
  p4Port?: string
  p4User?: string
```

**Step 2: Verify typecheck**

```bash
cd apps/daemon && pnpm typecheck
```

Expected: PASS

**Step 3: Commit**

```bash
git add apps/daemon/src/types/config.types.ts
git commit -m "feat: add p4UseEnvVars, p4Port, p4User to daemon Project type"
```

---

## Task 3: Update P4ProviderConfig and add p4Args helper

**Depends on:** Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/vcs/p4.provider.ts`
- Test: `apps/daemon/src/services/session/vcs/__tests__/p4.provider.test.ts`

**Purpose:** Centralise connection-flag injection so every `p4` CLI call gets `-p`/`-u` when configured, without duplicating the logic at each call site. Also propagate the values into the MCP server's env.

**Not In Scope:** Do not change `detectP4VFS` — it tests for the `p4vfs` binary, not a server connection.

**Step 1: Write the failing test**

In `apps/daemon/src/services/session/vcs/__tests__/p4.provider.test.ts`, add a test that verifies `p4Args` output:

```typescript
// Add near top of test file, in a describe block for p4Args
// NOTE: uses node:test + node:assert (NOT Jest/Vitest) — consistent with existing test file style
import assert from 'node:assert'
import { describe, it } from 'node:test'
import { P4Provider } from '../p4.provider.js'

describe('P4Provider p4Args helper', () => {
  it('returns cmd unchanged when p4Port and p4User are absent', () => {
    const provider = new (P4Provider as any)({
      p4Stream: '//depot/main',
      agentWorkspaceRoot: '/tmp',
      projectSlug: 'test',
    })
    assert.deepStrictEqual(provider.p4Args(['clients', '-e', 'ws']), ['clients', '-e', 'ws'])
  })

  it('prepends -p and -u flags when both are set', () => {
    const provider = new (P4Provider as any)({
      p4Stream: '//depot/main',
      agentWorkspaceRoot: '/tmp',
      projectSlug: 'test',
      p4Port: 'ssl:p4.example.com:1666',
      p4User: 'alice',
    })
    assert.deepStrictEqual(provider.p4Args(['clients', '-e', 'ws']), [
      '-p', 'ssl:p4.example.com:1666',
      '-u', 'alice',
      'clients', '-e', 'ws',
    ])
  })

  it('prepends only -p when only p4Port is set', () => {
    const provider = new (P4Provider as any)({
      p4Stream: '//depot/main',
      agentWorkspaceRoot: '/tmp',
      projectSlug: 'test',
      p4Port: 'ssl:p4.example.com:1666',
    })
    assert.deepStrictEqual(provider.p4Args(['sync']), ['-p', 'ssl:p4.example.com:1666', 'sync'])
  })
})
```

**Step 2: Run test to verify it fails**

```bash
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test --test-name-pattern "p4Args" dist/**/*.test.js
```

Expected: FAIL (p4Args is not yet defined)

**Step 3: Add fields to P4ProviderConfig and implement helper**

In `p4.provider.ts`, update `P4ProviderConfig`:

```typescript
export interface P4ProviderConfig {
  p4Stream: string;
  agentWorkspaceRoot: string;
  helixSwarmUrl?: string;
  projectSlug: string;
  p4Port?: string;   // Optional: Perforce server address override
  p4User?: string;   // Optional: Perforce username override
}
```

Add private helper inside the `P4Provider` class, before `workspaceName`:

```typescript
  /**
   * Prepend global connection flags to a p4 command array.
   * Only adds flags when the corresponding config field is set.
   */
  private p4Args(cmd: string[]): string[] {
    return [
      ...(this.config.p4Port ? ['-p', this.config.p4Port] : []),
      ...(this.config.p4User ? ['-u', this.config.p4User] : []),
      ...cmd,
    ];
  }
```

**Step 4: Update all p4 spawnSync/execSync calls to use p4Args**

Replace the args arrays in these five call sites:

```typescript
// ensureWorkspace — clients check (line ~148)
spawnSync("p4", this.p4Args(["clients", "-e", workspaceName]), { encoding: "utf-8" })

// syncWorkspace — sync (line ~107)
spawnSync("p4", this.p4Args(["-c", workspaceName, "sync"]), { cwd: workspaceRootPath, encoding: "utf-8" })

// ensureWorkspace — client create (line ~190)
spawnSync("p4", this.p4Args(["client", "-i"]), { input: specString, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })

// _destroyWorkspace — revert (line ~249)
spawnSync("p4", this.p4Args(["-c", workspaceName, "revert", "-k", "//..."]), { encoding: "utf-8" })

// _destroyWorkspace — client delete (line ~260)
spawnSync("p4", this.p4Args(["client", "-d", "-f", workspaceName]), { encoding: "utf-8" })
```

**Step 5: Propagate overrides into getMcpServers env**

In `getMcpServers`, update the returned env object:

```typescript
return {
  "perforce-p4": {
    command: nodePath,
    args: [p4McpPath],
    env: {
      P4CLIENT: workspaceName,
      ...(this.config.p4Port ? { P4PORT: this.config.p4Port } : {}),
      ...(this.config.p4User ? { P4USER: this.config.p4User } : {}),
    },
  },
};
```

**Step 6: Run tests to verify pass**

```bash
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test --test-name-pattern "p4Args" dist/**/*.test.js
```

Expected: PASS

**Step 7: Run full daemon tests**

```bash
cd apps/daemon && pnpm build && pnpm test
```

Expected: PASS (no regressions)

**Step 8: Commit**

```bash
git add apps/daemon/src/services/session/vcs/p4.provider.ts apps/daemon/src/services/session/vcs/__tests__/p4.provider.test.ts
git commit -m "feat: add p4Port/p4User to P4ProviderConfig with p4Args helper"
```

---

## Task 4: Update VCS factory to pass new fields

**Depends on:** Task 2, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/services/session/vcs/factory.ts`
- Test: `apps/daemon/src/services/session/vcs/__tests__/p4.provider.test.ts` (or factory test if one exists)

**Purpose:** Wire the new project fields into the `P4Provider` constructor, respecting the env-var toggle.

**Step 1: Write the failing test**

Add to the test file (or a factory test if one exists):

```typescript
// NOTE: uses node:test + node:assert (NOT Jest/Vitest) — consistent with existing test file style
import assert from 'node:assert'
import { describe, it } from 'node:test'
import { createVCSProvider } from '../factory.js'

describe('createVCSProvider with p4 overrides', () => {
  it('passes p4Port and p4User when p4UseEnvVars is false', () => {
    const project = {
      id: 'proj1', slug: 'proj1', displayName: 'Proj', path: '/repo',
      registeredAt: '', vcsType: 'perforce' as const,
      p4Stream: '//depot/main', agentWorkspaceRoot: '/workspaces',
      p4UseEnvVars: false, p4Port: 'ssl:p4.example.com:1666', p4User: 'alice',
    }
    const provider = createVCSProvider(project) as any
    assert.strictEqual(provider.config.p4Port, 'ssl:p4.example.com:1666')
    assert.strictEqual(provider.config.p4User, 'alice')
  })

  it('does not pass p4Port/p4User when p4UseEnvVars is true', () => {
    const project = {
      id: 'proj1', slug: 'proj1', displayName: 'Proj', path: '/repo',
      registeredAt: '', vcsType: 'perforce' as const,
      p4Stream: '//depot/main', agentWorkspaceRoot: '/workspaces',
      p4UseEnvVars: true, p4Port: 'ssl:p4.example.com:1666', p4User: 'alice',
    }
    const provider = createVCSProvider(project) as any
    assert.strictEqual(provider.config.p4Port, undefined)
    assert.strictEqual(provider.config.p4User, undefined)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test --test-name-pattern "createVCSProvider with p4 overrides" dist/**/*.test.js
```

Expected: FAIL

**Step 3: Update factory.ts**

In `createVCSProvider`, update the `P4Provider` constructor call:

```typescript
return new P4Provider({
  p4Stream: project.p4Stream,
  agentWorkspaceRoot: project.agentWorkspaceRoot,
  helixSwarmUrl: project.helixSwarmUrl,
  projectSlug: project.slug,
  p4Port: project.p4UseEnvVars ? undefined : project.p4Port,
  p4User: project.p4UseEnvVars ? undefined : project.p4User,
});
```

**Step 4: Run tests to verify pass**

```bash
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test --test-name-pattern "createVCSProvider with p4 overrides" dist/**/*.test.js
```

Expected: PASS

**Step 5: Run full daemon tests**

```bash
cd apps/daemon && pnpm build && pnpm test
```

Expected: PASS

**Step 6: Commit**

```bash
git add apps/daemon/src/services/session/vcs/factory.ts apps/daemon/src/services/session/vcs/__tests__/p4.provider.test.ts
git commit -m "feat: wire p4Port/p4User overrides through VCS factory"
```

---

## Task 5: Update ConfigurePage UI

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/configure/ConfigurePage.tsx`

**Purpose:** Expose the three new fields to the user in the existing Perforce settings block.

**Not In Scope:** Do not add these fields to the project creation flow or any other page.

**Step 1: Add state variables**

After `helixSwarmUrlError` state (line ~65):

```typescript
const [p4UseEnvVars, setP4UseEnvVars] = useState(true)
const [p4Port, setP4Port] = useState('')
const [p4User, setP4User] = useState('')
```

**Step 2: Populate state from project in useEffect**

Inside the `if (project)` block (after `setHelixSwarmUrl`):

```typescript
setP4UseEnvVars(project.p4UseEnvVars ?? true)
setP4Port(project.p4Port || '')
setP4User(project.p4User || '')
```

**Step 3: Add handlers**

After the existing `handleHelixSwarmUrlKeyDown`:

```typescript
const handleP4UseEnvVarsChange = useCallback(
  (checked: boolean) => {
    setP4UseEnvVars(checked)
    updateProject.mutate({ id: projectId, updates: { p4UseEnvVars: checked } })
  },
  [projectId, updateProject],
)

const handleP4PortBlur = useCallback(() => {
  if (!project) return
  const newPort = p4Port.trim()
  if (newPort !== (project.p4Port || '')) {
    updateProject.mutate({ id: projectId, updates: { p4Port: newPort || undefined } })
  }
}, [p4Port, project, projectId, updateProject])

const handleP4UserBlur = useCallback(() => {
  if (!project) return
  const newUser = p4User.trim()
  if (newUser !== (project.p4User || '')) {
    updateProject.mutate({ id: projectId, updates: { p4User: newUser || undefined } })
  }
}, [p4User, project, projectId, updateProject])

const handleP4FieldKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') e.currentTarget.blur()
}, [])
```

**Step 4: Add UI in the perforce block**

In the JSX, inside the `{vcsType === 'perforce' && (` block, after the Helix Swarm URL field group, add:

```tsx
{/* P4 Connection settings */}
<div className="space-y-2">
  <label className="flex items-center gap-2 cursor-pointer">
    <input
      type="checkbox"
      checked={p4UseEnvVars}
      onChange={(e) => handleP4UseEnvVarsChange(e.target.checked)}
      className="h-4 w-4"
    />
    <span className="text-sm font-medium text-text-primary">
      Use environment variables for P4PORT and P4USER
    </span>
  </label>
  <p className="text-sm text-text-secondary pl-6">
    When enabled, P4PORT and P4USER are inherited from the daemon process environment.
  </p>
</div>

{!p4UseEnvVars && (
  <div className="space-y-3 pl-0">
    <div className="space-y-1">
      <label className="text-sm font-medium text-text-primary">
        P4 Port
      </label>
      <Input
        value={p4Port}
        onChange={(e) => setP4Port(e.target.value)}
        onBlur={handleP4PortBlur}
        onKeyDown={handleP4FieldKeyDown}
        placeholder="ssl:perforce.company.com:1666"
      />
      <p className="text-sm text-text-secondary">
        Passed as <code>-p</code> to all p4 commands for this project.
      </p>
    </div>
    <div className="space-y-1">
      <label className="text-sm font-medium text-text-primary">
        P4 User
      </label>
      <Input
        value={p4User}
        onChange={(e) => setP4User(e.target.value)}
        onBlur={handleP4UserBlur}
        onKeyDown={handleP4FieldKeyDown}
        placeholder="username"
      />
      <p className="text-sm text-text-secondary">
        Passed as <code>-u</code> to all p4 commands for this project.
      </p>
    </div>
  </div>
)}
```

**Step 5: Add UI component tests**

In `apps/frontend/src/components/configure/ConfigurePage.test.tsx`, add a new `describe` block (uses Vitest + Testing Library, consistent with existing tests):

```typescript
describe('ConfigurePage p4 connection overrides', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    // Ensure project has perforce vcsType for the p4 block to render
    ;(projectsData[0] as any).vcsType = 'perforce'
    ;(projectsData[0] as any).p4UseEnvVars = true
    ;(projectsData[0] as any).p4Port = undefined
    ;(projectsData[0] as any).p4User = undefined
  })

  afterEach(() => {
    delete (projectsData[0] as any).vcsType
    delete (projectsData[0] as any).p4UseEnvVars
    delete (projectsData[0] as any).p4Port
    delete (projectsData[0] as any).p4User
  })

  it('calls updateProject when the env-var toggle is unchecked', async () => {
    render(<ConfigurePage projectId="project-1" />)

    const checkbox = await screen.findByRole('checkbox', {
      name: /use environment variables for p4port and p4user/i,
    })
    fireEvent.click(checkbox)

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'project-1',
        updates: { p4UseEnvVars: false },
      })
    })
  })

  it('calls updateProject with p4Port on blur when override is active', async () => {
    ;(projectsData[0] as any).p4UseEnvVars = false
    render(<ConfigurePage projectId="project-1" />)

    const portInput = await screen.findByPlaceholderText('ssl:perforce.company.com:1666')
    fireEvent.change(portInput, { target: { value: 'ssl:p4.example.com:1666' } })
    fireEvent.blur(portInput)

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'project-1',
        updates: { p4Port: 'ssl:p4.example.com:1666' },
      })
    })
  })

  it('calls updateProject with p4User on blur when override is active', async () => {
    ;(projectsData[0] as any).p4UseEnvVars = false
    render(<ConfigurePage projectId="project-1" />)

    const userInput = await screen.findByPlaceholderText('username')
    fireEvent.change(userInput, { target: { value: 'alice' } })
    fireEvent.blur(userInput)

    await waitFor(() => {
      expect(mockUpdateMutate).toHaveBeenCalledWith({
        id: 'project-1',
        updates: { p4User: 'alice' },
      })
    })
  })
})
```

**Step 6: Run new tests to verify they fail**

```bash
cd apps/frontend && pnpm test --reporter=verbose ConfigurePage
```

Expected: FAIL (UI not yet implemented)

**Step 7: Verify typecheck**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: PASS

**Step 8: Run frontend tests after implementation**

```bash
cd apps/frontend && pnpm test
```

Expected: PASS

**Step 9: Commit**

```bash
git add apps/frontend/src/components/configure/ConfigurePage.tsx apps/frontend/src/components/configure/ConfigurePage.test.tsx
git commit -m "feat: add per-project P4Port/P4User toggle in ConfigurePage"
```

---

## Task 6: Build and smoke test

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5
**Complexity:** simple
**Files:** (none modified)

**Purpose:** Confirm the full monorepo compiles cleanly with all changes in place.

**Step 1: Build shared first**

```bash
pnpm build:shared
```

Expected: PASS

**Step 2: Full typecheck**

```bash
pnpm typecheck
```

Expected: PASS

**Step 3: Full test run**

```bash
pnpm test
```

Expected: PASS

**Step 4: Verify (no changes expected)**

If all pass, no commit needed. If typecheck surfaced issues, fix them in the relevant task's files and commit under that task's commit message convention.

---

## Parallel Execution Notes

Task 0 has no dependencies and must complete first (migration + store update).
Tasks 1 and 2 can run in parallel after Task 0.
Tasks 3 and 5 can start after their respective dependencies (2 and 1) are done.
Task 4 depends on Tasks 2 and 3.
Task 6 is the final integration gate.

```
Task 0 ──┬── Task 1 ──── Task 5 ──┐
          │                        │
          └── Task 2 ──┬── Task 3 ─┤
                       └───────────┤
                           Task 4 ─┤
                                   └── Task 6
```

---

## Verification Record

*(To be populated by verification sub-agents)*

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | PASS | All three new fields covered across shared type, daemon type, P4Provider, factory, and UI |
| Accurate | PASS | All file paths verified to exist; anchor comments (helixSwarmUrl, line ~65, etc.) match actual code |
| Commands valid | PASS (after fix) | Daemon test commands updated to include `pnpm build &&` before `pnpm test` (Node runner operates on dist/) |
| YAGNI | PASS | Every task directly enables the stated goal; no speculative additions |
| Minimal | PASS | Tasks 1 and 2 are irreducible separate concerns (shared vs daemon types); no redundant tasks |
| Not over-engineered | PASS | CLI flags approach avoids process.env mutation; JSON column avoids a migration; simple toggle pattern |
| Key Decisions documented | PASS | 5 decisions with rationale covering migration, semantics, CLI vs env, MCP propagation, P4Client exclusion |
| Context sections present | PASS | Purpose on all tasks, Not In Scope on Tasks 2 and 5; boundary conditions clearly described |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | PASS | 1 | All major sections present; six tasks cover every deliverable; dependencies sketched with diagram; Key Decisions documented with rationale. |
| Feasibility | PASS (after edits) | 6 | All file paths exist; fixed test assertion style (Jest→node:assert) and test-name-pattern command syntax (pnpm passthrough→direct node invocation) across Tasks 3 and 4. |
| Completeness | PASS (after edits) | 1 | Task 5 lacked tests for the new UI handlers (toggle, p4Port blur, p4User blur); added a failing-first test step targeting ConfigurePage.test.tsx. |
| Risk | EDITED | 4 | Critical: plan falsely claimed no DB migration was needed. The projects table uses real SQL columns, not a JSON blob. Added Task 0 for migration V26 (ALTER TABLE + rowToProject + updateProject) with rollback analysis; updated dependency graph and Key Decisions note. |
| Optimality | EDITED | 3 | Merged two identical handleP4PortKeyDown/handleP4UserKeyDown handlers into one handleP4FieldKeyDown; removed speculative commit template from Task 6 Step 4. |
