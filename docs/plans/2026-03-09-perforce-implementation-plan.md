# Perforce VCS Abstraction — Implementation Plan

## Overview

This plan adds Perforce (P4) as a first-class VCS alongside Git in Potato Cannon by replacing the hard-coded `git worktree` isolation system with an abstract `IVCSProvider` interface. A `GitProvider` wraps the existing `worktree.ts` logic unchanged while a new `P4Provider` manages per-ticket Perforce client workspaces. A new `product-development-p4` workflow template adds a sync-agent (conflict resolution) and a shelve-agent (code review handoff) specific to Perforce teams.

## Key Decisions

- The `IVCSProvider` interface exposes three lifecycle methods (`ensureWorkspace`, `resetWorkspace`, `archiveWorkspace`) plus `getMcpServers` for provider-specific MCP tool injection.
- `GitProvider` is a thin wrapper around the existing `worktree.ts` functions — no behavioral change for existing Git projects.
- P4 workspace naming follows `potato-{projectSlug(20)}-{ticketId}` to avoid collisions across Potato Cannon instances sharing a P4 server.
- `phaseRequiresWorktree` is renamed to `phaseRequiresIsolation` and checks both `requiresIsolation` and the deprecated `requiresWorktree` field for backward compatibility.
- The `product-development-p4` template ships only 2 unique agent files (`sync-agent.md`, `shelve-agent.md`); a new 4th lookup level in `getAgentPromptForProject` falls back to the parent template for all other agents.
- `resolveExecutable` / `resolveNode` / `resolveClaude` are extracted into `apps/daemon/src/utils/resolve-executable.ts` and all raw `execSync("which ...")` calls across the daemon are replaced.
- Windows is first-class: `apps/daemon/package.json` `os` field gains `"win32"`.

## Goals

- Define and implement `IVCSProvider` abstracting Git and P4 workspace lifecycles.
- Implement `GitProvider` wrapping existing `worktree.ts` with no behavioral change.
- Implement `P4Provider` with P4VFS detection, create/delete/reset workspace operations using `spawnSync`.
- Store `p4Stream`, `agentWorkspaceRoot`, `helixSwarmUrl` in the `projects` table via migration V8.
- Inject `perforce-p4-mcp` MCP server into P4 project sessions via `provider.getMcpServers()`.
- Ship `product-development-p4` template with sync-agent and shelve-agent.
- Extend `getAgentPromptForProject` with a 4th `parentTemplate` lookup level.
- Replace all `which claude` / `which node` calls with the shared `resolveExecutable` utility.
- Surface P4 project settings (stream, workspace root, Swarm URL) in the frontend settings panel.

## Non-Goals

- Migrating existing Git projects to P4.
- Supporting P4 streams depot topology decisions (caller's responsibility).
- Supporting P4 Proxy or broker intermediaries.
- Rewriting the workflow engine or worker types.
- Automatic Helix Swarm review creation via REST API (URL construction only).
- Mixed WSL/native Windows environments.

---

### Task 1: Cross-platform executable resolver utility
**Complexity:** simple
**Depends on:** None
**Files:** `apps/daemon/src/utils/resolve-executable.ts`, `apps/daemon/package.json`

- Create `apps/daemon/src/utils/resolve-executable.ts` as a new file.
- Implement `resolveExecutable(name: string): string | null` — on Windows, tries `where` first (prefers `.exe` result), then `which`, then common fallback paths (`%APPDATA%\npm\{name}.cmd`, `C:\Program Files\Perforce\{name}.exe`); on Unix, checks `~/.local/bin`, `/usr/local/bin`, `/usr/bin`.
- Implement `resolveNode(): string` — calls `resolveExecutable("node")` and falls back to `process.execPath`.
- Implement `resolveClaude(nodePath: string): { claudePath: string; claudePrependArgs: string[] }` — move the existing `resolveClaudeExecutable` function body verbatim from `session.service.ts` (lines ~68–120).
- Export all three functions.
- Update `apps/daemon/package.json` `os` field from `["darwin", "linux"]` to `["darwin", "linux", "win32"]`.

---

### Task 2: DB migration — add P4 columns to projects table
**Complexity:** simple
**Depends on:** None
**Files:** `apps/daemon/src/stores/migrations.ts`

- Read `migrations.ts` to find the current `CURRENT_SCHEMA_VERSION` and increment it by 1.
- Add `if (version < N) { migrateVN(db); }` block inside `runMigrations()` after the last existing migration block.
- Implement `migrateVN(db)` using `db.pragma('table_info(projects)')` to guard each ALTER TABLE:
  - `ALTER TABLE projects ADD COLUMN p4_stream TEXT`
  - `ALTER TABLE projects ADD COLUMN agent_workspace_root TEXT`
  - `ALTER TABLE projects ADD COLUMN helix_swarm_url TEXT`
- Follow existing migration function patterns exactly (see design doc section 7.2).

---

### Task 3: Add P4 fields to Project type and project.store.ts
**Complexity:** simple
**Depends on:** Task 2
**Files:** `apps/daemon/src/types/config.types.ts`, `apps/daemon/src/stores/project.store.ts`

- In `config.types.ts`, add three optional fields to the `Project` interface: `p4Stream?: string`, `agentWorkspaceRoot?: string`, `helixSwarmUrl?: string`.
- In `project.store.ts`, update `rowToProject` to map `row.p4_stream`, `row.agent_workspace_root`, `row.helix_swarm_url` cast to `string | undefined`.
- Update `updateProject`: add three if-blocks for `p4Stream`, `agentWorkspaceRoot`, `helixSwarmUrl` following the existing `fields.push` / `values.push` pattern.
- Update `CreateProjectInput` to include the three new optional fields.
- Update the `createProject` INSERT to add 3 new columns/placeholders (`p4_stream`, `agent_workspace_root`, `helix_swarm_url`). **Do not rely on the "9 to 12" count** — count the actual columns in the current `createProject` INSERT statement in `project.store.ts` and add 3 to that number. The column count in the design doc may be stale if prior migrations already added columns.
- See design doc section 7.4 for explicit code snippets.

---

### Task 4: Create vcs/types.ts — IVCSProvider interface
**Complexity:** simple
**Depends on:** None
**Files:** `apps/daemon/src/services/session/vcs/types.ts`

- Create the `apps/daemon/src/services/session/vcs/` directory.
- Define and export `WorkspaceInfo` interface: `workspacePath: string`, `workspaceLabel: string`, `metadata?: Record<string, string>`.
- Define and export `IVCSProvider` interface with four methods: `ensureWorkspace(ticketId)`, `resetWorkspace(ticketId)`, `archiveWorkspace(ticketId)`, `getMcpServers(nodePath, projectId, ticketId)`.
- Define and export `McpServerConfig` interface: `command: string`, `args: string[]`, `env?: Record<string, string>`.
- See design doc section 2.1 for full interface definitions.

---

### Task 5: Create vcs/git.provider.ts — GitProvider
**Complexity:** simple
**Depends on:** Task 4
**Files:** `apps/daemon/src/services/session/vcs/git.provider.ts`

- Implement `GitProvider` class implementing `IVCSProvider`.
- Constructor: `(projectPath: string, branchPrefix: string)`.
- `ensureWorkspace`: calls `ensureWorktree` from `worktree.ts`, returns `WorkspaceInfo` with `workspaceLabel = \`${branchPrefix}/${ticketId}\``.
- `resetWorkspace`: calls `removeWorktreeAndRenameBranch` from `worktree.ts`.
- `archiveWorkspace`: calls `removeWorktreeAndBranch` from `worktree.ts`.
- `getMcpServers(nodePath, projectId, ticketId)`: returns `{}` (no additional MCP servers for Git).
- See design doc section 2.3 for full class definition.

---

### Task 6: Create vcs/p4.provider.ts — P4Provider workspace lifecycle
**Complexity:** complex
**Depends on:** Task 4
**Files:** `apps/daemon/src/services/session/vcs/p4.provider.ts`

- Define `P4ProviderConfig`: `p4Stream`, `agentWorkspaceRoot`, `helixSwarmUrl?`, `projectSlug`.
- Workspace name: `const slug = config.projectSlug.slice(0, 20); const workspaceName = \`potato-${slug}-${ticketId}\``.
- `detectP4VFS()`: Implement as a synchronous function (not `async`) — it uses `execSync` which is synchronous. Pattern: try `execSync("p4vfs help", { stdio: "pipe", encoding: "utf-8" })`, return `true`; catch: return `false`. Do NOT use `spawnSync` here; only `spawnSync` is used for `p4 client -i` (stdin piping). The design doc shows this as `async function detectP4VFS()` which is technically valid but unnecessary — implement without `async` for clarity. See design doc section 3.2 for the try/catch body.
- `ensureWorkspace(ticketId)`: check if the workspace already exists using `spawnSync('p4', ['clients', '-e', workspaceName], { encoding: 'utf-8' })` — if `stdout` is non-empty the workspace exists, return early with existing `WorkspaceInfo`. Do NOT use `p4 client -o <name>` for existence checking — it always outputs a template (including a `Root:` field) for non-existent workspaces, making it impossible to distinguish existing from new. If workspace does not exist: detect P4VFS, build client spec string, `await fs.mkdir(workspaceRootPath, { recursive: true })`, pipe spec to `spawnSync('p4', ['client', '-i'], { input: specString, stdio: ['pipe','pipe','pipe'] })`. Return `WorkspaceInfo`. See design doc section 3.3.
- `archiveWorkspace(ticketId)`: `spawnSync('p4', ['-c', workspaceName, 'revert', '-k', '//...'])`, `spawnSync('p4', ['client', '-d', '-f', workspaceName])`, `fs.rm(workspaceRootPath, { recursive: true, force: true })`. Collect errors non-fatally. See section 3.4.
- `resetWorkspace(ticketId)`: same three steps as archive. See section 3.5.
- `getMcpServers(nodePath, projectId, ticketId)`: use `createRequire(import.meta.url)` (import from `'module'`) to resolve `perforce-p4-mcp/dist/index.js`; if not found log warning and return `{}`; else return `{ "perforce-p4": { command: nodePath, args: [p4McpPath], env: { P4CLIENT: workspaceName } } }`. See section 4.2.

---

### Task 7: Create vcs/factory.ts and vcs/index.ts
**Complexity:** simple
**Depends on:** Task 5, Task 6
**Files:** `apps/daemon/src/services/session/vcs/factory.ts`, `apps/daemon/src/services/session/vcs/index.ts`

- `factory.ts`: implement `createVCSProvider(project: Project): IVCSProvider`. If `project.p4Stream` is set, validate `agentWorkspaceRoot` is present (throw if not), return `new P4Provider({ p4Stream, agentWorkspaceRoot, helixSwarmUrl, projectSlug: project.slug })`. Otherwise return `new GitProvider(project.path, project.branchPrefix ?? "potato")`. See design doc section 2.4.
- `index.ts`: re-export `IVCSProvider`, `WorkspaceInfo`, `McpServerConfig`, `GitProvider`, `P4Provider`, `createVCSProvider`.

---

### Task 8: requiresIsolation field + rename phaseRequiresWorktree
**Complexity:** simple
**Depends on:** None
**Files:** `apps/daemon/src/types/template.types.ts`, `apps/daemon/templates/workflows/workflow.schema.json`, `apps/daemon/src/services/session/phase-config.ts`

- In `template.types.ts`: add `requiresIsolation?: boolean` to `Phase` interface (alongside deprecated `requiresWorktree`); add `parentTemplate?: string` to `WorkflowTemplate` interface.
- In `workflow.schema.json`: add `requiresIsolation` as optional boolean in the phase object schema.
- In `phase-config.ts`: rename exported function `phaseRequiresWorktree` → `phaseRequiresIsolation`; update body to `return phase?.requiresIsolation ?? phase?.requiresWorktree ?? false`.
- See design doc section 8.1 for the import rename note: grep `apps/` for any other callers beyond `session.service.ts` (handled in Task 9).
- **IMPORTANT — atomic commit required:** Task 8 renames the export in `phase-config.ts` and Task 9 updates the import and call sites in `session.service.ts`. These two tasks MUST be committed together in a single commit (or Task 9 must be executed immediately after Task 8 without an intervening commit). Committing Task 8 alone will break the TypeScript build because `session.service.ts` still imports `phaseRequiresWorktree` which no longer exists.

---

### Task 9: Update session.service.ts — full VCS provider integration
**Complexity:** complex
**Depends on:** Task 4, Task 7, Task 8
**Files:** `apps/daemon/src/services/session/session.service.ts`

Add required new imports (design doc section 11.1):
```typescript
import { resolveNode } from "../../utils/resolve-executable.js";
import { createVCSProvider } from "./vcs/factory.js";
import type { McpServerConfig } from "./vcs/types.js";
```
Replace `phaseRequiresWorktree` with `phaseRequiresIsolation` in the phase-config import.
Remove `import { ensureWorktree } from "./worktree.js"` (line ~49) — unused after this change.

In `spawnAgentWorker`:
- Remove `const branchPrefix = project?.branchPrefix || 'potato'`.
- `getProjectById(projectId)` returns `Project | null`. Add an explicit null guard immediately after the existing `getProjectById` call: `if (!project) throw new Error(\`Project \${projectId} not found\`);`. This guard must appear before `createVCSProvider(project)` — `createVCSProvider` accepts `Project` (not `Project | null`) and TypeScript will error without the guard.
- Replace `phaseRequiresWorktree` + `ensureWorktree` calls with: `createVCSProvider(project)`, `await phaseRequiresIsolation(projectId, phase)`, `provider.ensureWorkspace(ticketId)`.
- Declare `let worktreePath: string; let workspaceLabel: string;` before if/else.
- Add `const nodePath = resolveNode(); const additionalMcpServers = provider.getMcpServers(nodePath, projectId, ticketId);`.
- Replace `branchName: \`${branchPrefix}/${ticketId}\`` with `branchName: workspaceLabel` in meta.

In `resumeSuspendedTicket`:
- Remove `const branchPrefix = project.branchPrefix || "potato"` (explicit removal — mirrors the same removal in `spawnAgentWorker`).
- Remove the dead `branchPrefix` reference in the `branchName` meta field.
- Create the provider: `const provider = createVCSProvider(project)`.
- Declare `let worktreePath: string; let workspaceLabel: string;` before the if/else (same pattern as `spawnAgentWorker`).
- Call `await phaseRequiresIsolation(projectId, phase)` and, if true, call `const info = await provider.ensureWorkspace(ticketId)` to populate `worktreePath` and `workspaceLabel`.
- Add `const nodePath = resolveNode(); const additionalMcpServers = provider.getMcpServers(nodePath, projectId, ticketId);`.
- Replace `branchName` hardcoded string with `workspaceLabel`.

In `spawnClaudeSession`:
- Add 15th parameter: `additionalMcpServers?: Record<string, McpServerConfig>`.
- Spread into mcpConfig: `...additionalMcpServers`.
- Call `const project = getProjectById(projectId)` (synchronous) and conditionally inject `HELIX_SWARM_URL` into PTY spawn env. Note: this is a second `getProjectById` call for the same project (the first is in `spawnAgentWorker`/`resumeSuspendedTicket`). This is intentional — passing `project` as a 16th parameter would be a larger API change. `getProjectById` is a fast synchronous SQLite read; the redundancy is acceptable.
- Replace `execSync("which node", ...)` at lines ~393 and ~710 with `resolveNode()`.
- Replace local `resolveClaudeExecutable` body with call to `resolveClaude` from shared utility. Delete the existing function body (lines ~68–120) and replace the entire function body with a single delegation call: `return resolveClaude(nodePath)`. Do not add a second copy alongside the old body.

Update both `spawnAgentWorker` and `resumeSuspendedTicket` call sites to pass `additionalMcpServers` as the 15th positional argument. See design doc sections 11.1, 11.3 for complete call-site code.

Also rename call sites at lines ~907 and ~1034 from `phaseRequiresWorktree` to `phaseRequiresIsolation`.

---

### Task 10: Update ticket.store.ts — provider.archiveWorkspace
**Complexity:** simple
**Depends on:** Task 7
**Files:** `apps/daemon/src/stores/ticket.store.ts`

- Remove `import { removeWorktreeAndBranch } from "../services/session/worktree.js"` (line 13).
- Add `import { createVCSProvider } from "../services/session/vcs/factory.js"`.
- In `archiveTicket()` (~line 527): the existing code already null-checks `project` at line ~523 (`if (!project) throw new Error(...)`). The null guard is already present — do not add a duplicate. Replace the `removeWorktreeAndBranch` call (which comes after the null-check) with:
  ```typescript
  const provider = createVCSProvider(project); // project is non-null here; guard is above
  const cleanupResult = await provider.archiveWorkspace(ticketId);
  ```
- Map the result back to the `ArchiveResult.cleanup` shape (defined in `packages/shared/src/types/ticket.types.ts`):
  - `worktreeRemoved: cleanupResult.errors.length === 0` (true if P4 workspace deleted without errors)
  - `branchRemoved: false` (no Git branch to remove for P4 projects)
  - `errors: cleanupResult.errors`
- Log `cleanupResult.errors` non-fatally (same console.warn pattern as before).
- See design doc section 11.2.

---

### Task 11: Update ticket-restart.service.ts — provider.resetWorkspace
**Complexity:** simple
**Depends on:** Task 7
**Files:** `apps/daemon/src/services/ticket-restart.service.ts`

- Remove `import { removeWorktreeAndRenameBranch } from "./session/worktree.js"` (line 8).
- Add `import { createVCSProvider } from "./session/vcs/factory.js"`.
- In `restartToPhase()` (~line 89): replace the `removeWorktreeAndRenameBranch(...)` call with:
  ```typescript
  const provider = createVCSProvider(project);
  const resetResult = await provider.resetWorkspace(ticketId);
  worktreeRemoved = resetResult.errors.length === 0; // true if P4 workspace reset without errors
  branchRenamed = null; // P4 has no branch to rename; frontend must handle null gracefully
  ```
- Log `resetResult.errors` non-fatally using `console.warn` (same pattern as before).
- The `RestartResult.cleanup.worktreeRemoved` and `branchRenamed` fields are already declared as `let` before the if-block, so this assignment works without type changes.
- See design doc section 11.2.

---

### Task 12: Add perforce-p4-mcp npm dependency
**Complexity:** simple
**Depends on:** Task 6
**Files:** `apps/daemon/package.json`

- Check npmjs.com for current published version of `perforce-p4-mcp`.
- Add `"perforce-p4-mcp": "^<version>"` to the `dependencies` section of `apps/daemon/package.json`.
- Run `pnpm install` to update the lockfile.
- See design doc section 4.3.

---

### Task 13: Create product-development-p4 workflow.json
**Complexity:** standard
**Depends on:** Task 8
**Files:** `apps/daemon/templates/workflows/product-development-p4/workflow.json`

- Create the directory `apps/daemon/templates/workflows/product-development-p4/agents/`.
- Write `workflow.json` with `"name": "product-development-p4"`, `"parentTemplate": "product-development"`.
- **Copy ALL phases from `product-development/workflow.json`** into the new `workflow.json`. The `parentTemplate` field only enables agent prompt file fallback (via `getAgentPromptForProject`) — it does NOT merge phase definitions. The workflow loader (`getWorkflow`) reads a single `workflow.json` file; there is no phase inheritance at the workflow level. A workflow missing phases will have no `Refinement`, `Architecture`, etc. phases at all.
- Apply exactly two modifications to the full copied phase list:
  1. In the `Build` phase `build-task-loop` workers array, prepend a `sync-agent` worker (type `"agent"`, source `"agents/sync-agent.md"`) before `build-ralph-loop`.
  2. Replace the `Pull Requests` phase entirely with a `Shelve` phase: `id: "Shelve"`, `name: "Shelve"`, single `shelve-agent` worker (source `"agents/shelve-agent.md"`), `transitions.next: null`, `requiresIsolation: true`.
- See design doc sections 6.1, 8.2.

---

### Task 14: Write sync-agent.md prompt
**Complexity:** standard
**Depends on:** Task 13
**Files:** `apps/daemon/templates/workflows/product-development-p4/agents/sync-agent.md`

- Write the sync-agent prompt as a Markdown agent definition.
- Steps: (1) `modify_files (action: sync)` targeting `//...@head`; (2) `modify_files (action: resolve, mode: preview)` to check for conflicts; (3) `modify_files (action: resolve, mode: auto)` to attempt auto-merge; (4) recheck conflicts; (5) if clean, exit 0.
- On unresolvable conflicts or binary files: call `chat_notify` with list of conflicting files, then exit non-zero to trigger Blocked ticket path.
- See design doc section 5.2.

---

### Task 15: Write shelve-agent.md prompt
**Complexity:** standard
**Depends on:** Task 13
**Files:** `apps/daemon/templates/workflows/product-development-p4/agents/shelve-agent.md`

- Write the shelve-agent prompt as a Markdown agent definition.
- Steps: (1) read artifacts; (2) consolidate files into single numbered CL via `modify_changelists`; (3) verify no files open outside CL; (4) `modify_shelves (action: shelve)`; (5) check `HELIX_SWARM_URL` env var — if set notify with `{HELIX_SWARM_URL}/reviews/{clNumber}`, else notify with CL number + manual submit instructions.
- See design doc section 6.2.

---

### Task 16: Extend getAgentPromptForProject with parentTemplate fallback
**Complexity:** standard
**Depends on:** Task 8
**Files:** `apps/daemon/src/stores/template.store.ts`

- In `getAgentPromptForProject`, hoist the `const project = await getProjectById(projectId)` call (currently inside the level-3 block) to BEFORE the try/catch, so it is in scope at level 4.
- Wrap the existing level-3 `return getAgentPrompt(project.template.name, agentPath)` in a try/catch block (the `getProjectById` call and the null-check guard remain before the try). The catch block falls through to level 4.
- Add level 4 after the catch block: call `getWorkflow(project.template.name)` to retrieve the workflow definition; if `workflow?.parentTemplate` is set, wrap the level-4 call in its own try/catch:
  ```typescript
  try {
    return await getAgentPrompt(workflow.parentTemplate, agentPath);
  } catch {
    throw new Error(`Agent ${agentPath} not found in template chain for ${project.template.name} or its parent ${workflow.parentTemplate}`);
  }
  ```
  The `await` is required — `getAgentPrompt` is `async`; omitting it returns `Promise<Promise<string>>` causing a TypeScript error. Wrapping in try/catch ensures the user sees the friendlier "not found in template chain" message rather than a raw `fs.readFile` error.
- If `workflow?.parentTemplate` is not set (no parent template), throw `new Error(\`Agent \${agentPath} not found in template chain\`)`.
- See design doc section 8.2 for the full 4-level pseudocode.

---

### Task 17: Update projects.routes.ts — PATCH, GET, POST
**Complexity:** standard
**Depends on:** Task 3
**Files:** `apps/daemon/src/server/routes/projects.routes.ts`

- In `PATCH /api/projects/:id` handler: extend `req.body` cast to include `p4Stream?: string`, `agentWorkspaceRoot?: string`, `helixSwarmUrl?: string`.
- Auto-assign template when `p4Stream` is set and no template is explicitly supplied in the same request. Add the following logic inside the PATCH handler after destructuring `req.body`, before calling `updateProject`:
  ```typescript
  const { p4Stream, agentWorkspaceRoot, helixSwarmUrl, template, ...rest } = req.body as { ... };
  const effectiveTemplate = template ?? (p4Stream ? "product-development-p4" : undefined);
  // then pass effectiveTemplate to updateProject instead of template
  ```
  This ensures an explicit `template` field in the request body always wins; auto-assignment only fires when `template` is absent from the request.
- In `GET /api/projects` projection map: add `p4Stream`, `agentWorkspaceRoot`, `helixSwarmUrl`.
- In `POST /api/projects`: after existing git detection, add `p4 info` detection to extract `Client stream:` into `suggestedP4Stream`.
- Change POST response from `res.json(refreshedProject)` to `res.json({ ...refreshedProject, suggestedP4Stream })`.
- See design doc sections 10.1, 10.2.

---

### Task 18: Pre-build P4 validation in worker-executor.ts
**Complexity:** standard
**Depends on:** Task 7, Task 8
**Files:** `apps/daemon/src/services/session/worker-executor.ts`

- Add `import { getProjectById } from "../../stores/project.store.js"` to `worker-executor.ts` (it does not currently import this). The project object is needed for the P4 validation checks.
- Before `ensureWorkspace()` is called for isolation phases, fetch `const project = getProjectById(projectId)`. If `project?.p4Stream` is not set (Git project), skip validation entirely.
- For P4 projects, validate:
  1. `project.p4Stream` non-empty.
  2. `project.agentWorkspaceRoot` non-empty.
  3. `agentWorkspaceRoot` directory exists or is creatable (`fs.accessSync` or `fs.mkdirSync`).
  4. `spawnSync('p4', ['info'], { encoding: 'utf-8' })` exits with code 0 (P4 CLI on PATH, server reachable).
- On failure: call `onTicketBlocked` callback with a human-readable error message.
- See design doc section 10.4.

---

### Task 19: Frontend — Perforce settings section
**Complexity:** standard
**Depends on:** Task 17
**Files:** `apps/frontend/src/routes/` (project settings panel), `apps/frontend/src/api/client.ts`, `apps/frontend/src/hooks/queries.ts`

- Add a "Perforce" section to the project settings panel with three fields: P4 Stream (validates `//` prefix), Agent Workspace Root (required when P4 Stream set), Helix Swarm URL (optional).
- Hide Branch Prefix field when `p4Stream` is non-empty.
- Pre-fill template selector with `product-development-p4` when `p4Stream` is set (UI hint only).
- Pre-fill P4 Stream field from `suggestedP4Stream` on project registration response.
- Extend `updateProject` API function and `useUpdateProject` mutation type for three new fields.
- See design doc section 10.3.

---

### Task 20: Replace remaining `which` calls in daemon files
**Complexity:** simple
**Depends on:** Task 1
**Files:** `apps/daemon/src/marketplace/bootstrap.ts`, `apps/daemon/src/services/summarize.ts`, `apps/daemon/src/server/routes/artifact-chat.routes.ts`, `apps/daemon/src/system-agents/runner.ts`

- In each file, replace `execSync("which claude", ...)` with `resolveExecutable("claude") ?? "claude"`.
- Add `import { resolveExecutable } from '../../utils/resolve-executable.js'` (adjust relative path per file).
- Files and line numbers per design doc section 9.3: `bootstrap.ts:23`, `summarize.ts:43`, `artifact-chat.routes.ts:348`, `runner.ts:72`.
- Note: `session.service.ts` `which` replacements are handled in Task 9.
