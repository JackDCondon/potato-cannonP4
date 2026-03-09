# Perforce VCS Abstraction Design

**Date:** 2026-03-09
**Status:** Draft
**Scope:** Add Perforce (P4) as a supported VCS alongside Git, replacing the Git-only worktree system with an abstract provider pattern. Windows is a first-class platform.

---

## 1. Overview

### Problem Statement

Potato Cannon currently hard-codes Git worktrees as the code-isolation mechanism for Build-phase agents. Every ticket gets a `git worktree add` call; cleanup does `git worktree remove`. This couples the orchestration engine to Git in three places: `worktree.ts`, `session.service.ts` (calls `ensureWorktree`), and `phase-config.ts` (`phaseRequiresWorktree`). Teams using Perforce cannot use Potato Cannon at all.

Additionally, several files call `execSync("which claude")` or `execSync("which node")`, which fail silently on Windows outside Git Bash. The session service already has a robust cross-platform resolver (`resolveClaudeExecutable`) that other files don't use.

### Goals

1. Define an `IVCSProvider` interface that abstracts workspace lifecycle (create, use, archive/delete).
2. Implement `GitProvider` wrapping the existing `worktree.ts` logic with no behavioral changes.
3. Implement `P4Provider` managing Perforce client workspaces per ticket.
4. Inject the correct provider into `session.service.ts` based on project configuration.
5. Store P4-specific project config (`p4Stream`, `agentWorkspaceRoot`, `helixSwarmUrl`) in the `projects` table.
6. Add a `sync-agent` worker to the P4 Build taskLoop to handle `p4 sync` + conflict resolution before each task's builder runs.
7. Provide a `shelve-agent` replacing `pr-agent` in a new `product-development-p4` workflow template.
8. Extract `resolveExecutable` to a shared utility and replace all raw `which` calls.
9. Inject the `perforce-p4-mcp` MCP server into sessions for P4 projects.
10. Windows must work natively (paths, P4 CLI invocation, no Unix-only assumptions).

### Non-Goals

- Migrating existing Git projects to P4.
- Supporting P4 `streams` depot topology decisions (caller's responsibility).
- Supporting P4 Proxy or broker intermediaries.
- Rewriting the workflow engine or worker types.
- GUI for Swarm configuration beyond the project settings panel.

---

## 2. Architecture

### 2.1 VCS Provider Interface

New file: `apps/daemon/src/services/session/vcs/types.ts`

```typescript
/**
 * Result of ensuring an isolated workspace for a ticket.
 */
export interface WorkspaceInfo {
  /** Absolute path the agent should use as its working directory. */
  workspacePath: string;
  /** Human-readable identifier (branch name for Git, CL# for P4). */
  workspaceLabel: string;
  /** VCS-specific extra data passed through to MCP config injection. */
  metadata?: Record<string, string>;
}

export interface IVCSProvider {
  /**
   * Ensure an isolated workspace exists for this ticket.
   * Idempotent: if it already exists, return its info.
   */
  ensureWorkspace(ticketId: string): Promise<WorkspaceInfo>;

  /**
   * Clean up the workspace after a phase restart.
   * For Git: renames the branch to a reset-timestamped name.
   * For P4: deletes and recreates the client workspace.
   */
  resetWorkspace(ticketId: string): Promise<{ errors: string[] }>;

  /**
   * Archive/delete the workspace when the ticket is done or archived.
   * Errors are non-fatal: archiving should proceed regardless.
   */
  archiveWorkspace(ticketId: string): Promise<{ errors: string[] }>;

  /**
   * Return extra MCP server entries to inject for this provider.
   * Git returns {}. P4 returns the perforce-p4-mcp config.
   */
  getMcpServers(
    nodePath: string,
    projectId: string,
    ticketId: string,
  ): Record<string, McpServerConfig>;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
```

### 2.2 File Structure

```
apps/daemon/src/services/session/vcs/
├── types.ts            ← IVCSProvider interface above
├── git.provider.ts     ← GitProvider (wraps existing worktree.ts logic)
├── p4.provider.ts      ← P4Provider (new)
├── factory.ts          ← createVCSProvider(project) → IVCSProvider
└── index.ts            ← re-exports
```

The existing `worktree.ts` is **not deleted** but stops being called directly by `session.service.ts`. It becomes an implementation detail of `git.provider.ts`.

### 2.3 GitProvider

`apps/daemon/src/services/session/vcs/git.provider.ts`

```typescript
export class GitProvider implements IVCSProvider {
  constructor(
    private projectPath: string,
    private branchPrefix: string,
  ) {}

  async ensureWorkspace(ticketId: string): Promise<WorkspaceInfo> {
    const worktreePath = await ensureWorktree(
      this.projectPath,
      ticketId,
      this.branchPrefix,
    );
    return {
      workspacePath: worktreePath,
      workspaceLabel: `${this.branchPrefix}/${ticketId}`,
    };
  }

  async resetWorkspace(ticketId: string) {
    const result = await removeWorktreeAndRenameBranch(
      this.projectPath,
      ticketId,
      this.branchPrefix,
    );
    return { errors: result.errors };
  }

  async archiveWorkspace(ticketId: string) {
    const result = await removeWorktreeAndBranch(
      this.projectPath,
      ticketId,
      this.branchPrefix,
    );
    return { errors: result.errors };
  }

  getMcpServers(nodePath: string, projectId: string, ticketId: string): Record<string, McpServerConfig> {
    return {};
  }
}
```

### 2.4 Factory

`apps/daemon/src/services/session/vcs/factory.ts`

```typescript
export function createVCSProvider(project: Project): IVCSProvider {
  if (project.p4Stream) {
    // P4 project
    if (!project.agentWorkspaceRoot) {
      throw new Error(
        `Project ${project.id} has p4Stream but no agentWorkspaceRoot configured`,
      );
    }
    return new P4Provider({
      p4Stream: project.p4Stream,
      agentWorkspaceRoot: project.agentWorkspaceRoot,
      helixSwarmUrl: project.helixSwarmUrl,
      projectSlug: project.slug,
    });
  }
  // Default: Git
  return new GitProvider(project.path, project.branchPrefix ?? "potato");
}
```

---

## 3. P4 Workspace Lifecycle

### 3.1 Workspace Naming and Paths

| Concept | Value |
|---------|-------|
| Workspace name | `potato-{projectSlug}-{ticketId}` (where `projectSlug` is truncated to 20 chars) |
| Workspace root | `path.join(agentWorkspaceRoot, workspaceName)` |
| Stream | `project.p4Stream` (e.g. `//MyDepot/Dev`) |

The agent's working directory (`workspacePath`) is the workspace root. Use `path.join` for directory creation to get OS-native separators. On Windows, P4 accepts backslashes in the client spec `Root:` field directly. The `projectSlug` is the project's database slug (lowercased, non-alphanumeric replaced with `-`), truncated to 20 characters for workspace naming only — the slug in the database is not affected:

```typescript
const slug = project.slug.slice(0, 20);
const workspaceName = `potato-${slug}-${ticketId}`;
const workspaceRootPath = path.join(agentWorkspaceRoot, workspaceName);
```

This ensures workspace names are unique per P4 server even when multiple Potato Cannon instances share a server.

### 3.2 P4VFS Detection

Before creating a workspace, `P4Provider.ensureWorkspace()` calls `detectP4VFS()`:

```typescript
async function detectP4VFS(): Promise<boolean> {
  try {
    // p4vfs is the Virtual File System client; presence on PATH is sufficient
    execSync("p4vfs help", { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}
```

- If P4VFS is available: create workspace with `Type: vclient` (virtual client — files materialize on access, near-zero disk usage).
- If not: create a regular workspace. The workspace starts empty (have-table at zero, no files downloaded). The sync-agent performs the first real sync at the start of the Build phase. Individual files are opened via `p4 edit`, which auto-syncs the specific file being opened.

Detection result is logged clearly so operators know which mode is active.

### 3.3 Create Operation

`P4Provider.ensureWorkspace()` steps:

1. Check if workspace `potato-{projectSlug}-{ticketId}` already exists using `spawnSync('p4', ['clients', '-e', workspaceName], { encoding: 'utf-8' })` — if `result.stdout` is non-empty the workspace exists, return early with the existing `WorkspaceInfo`. Do NOT use `p4 client -o <name>` for existence checking — it always emits a template (including `Root:` and other fields) for any name whether the workspace exists or not, making it impossible to distinguish a real workspace from a non-existent one.
2. If it exists (non-empty stdout), return its root path (idempotent).
3. Detect P4VFS.
4. Build a client spec:
   ```
   Client: potato-{projectSlug}-{ticketId}
   Root:   {workspaceRootPath}
   Stream: {p4Stream}
   Type:   vclient      # or omit for regular workspace if no P4VFS
   Options: noallwrite noclobber nocompress unlocked nomodtime normdir
   ```
   Where `workspaceRootPath = path.join(agentWorkspaceRoot, workspaceName)` (OS-native separators; P4 on Windows accepts backslashes in the spec).
4b. Create the workspace root directory:
   ```typescript
   await fs.mkdir(workspaceRootPath, { recursive: true });
   ```
   This creates both `agentWorkspaceRoot` and the per-ticket subdirectory if they don't exist. `p4 client -i` creates the workspace spec on the server but does not create the local directory; `p4 sync` will fail if the `Root` directory doesn't exist.
5. Create the workspace spec by piping it to `p4 client -i` using `spawnSync` (not `execSync`) to safely pipe stdin:
   ```typescript
   spawnSync('p4', ['client', '-i'], {
     input: clientSpecString,
     encoding: 'utf-8',
     stdio: ['pipe', 'pipe', 'pipe'],
   });
   ```
6. Return `WorkspaceInfo`. For non-vclient workspaces, the workspace starts empty (no files, have-table at zero). The sync-agent performs the first real sync when the Build phase begins. Agents only need files they actually edit, and `p4 edit` auto-syncs the file being opened.

The daemon uses `spawnSync`/`execSync` (synchronous P4 CLI) for workspace create/delete — not MCP. The MCP tools are for agent use during the session.

### 3.4 Delete/Archive Operation

`P4Provider.archiveWorkspace()` steps:

1. Remove open-file flags from the changelist (no-op if no files are open):
   ```typescript
   spawnSync('p4', ['-c', workspaceName, 'revert', '-k', '//...'], { encoding: 'utf-8' });
   ```
   Files remain modified on disk — directory deletion in step 3 removes them.
2. Delete the workspace spec:
   ```typescript
   spawnSync('p4', ['client', '-d', '-f', workspaceName], { encoding: 'utf-8' });
   ```
3. Delete the directory with `fs.rm(workspaceRootPath, { recursive: true, force: true })`.
4. Return errors array (non-fatal; log but don't block archiving).

### 3.5 Reset Operation (Phase Restart)

`P4Provider.resetWorkspace()` steps:

1. Remove open-file flags from the changelist (files remain modified on disk — directory deletion in step 3 removes them):
   ```typescript
   spawnSync('p4', ['-c', workspaceName, 'revert', '-k', '//...'], { encoding: 'utf-8' });
   ```
2. Delete workspace spec:
   ```typescript
   spawnSync('p4', ['client', '-d', '-f', workspaceName], { encoding: 'utf-8' });
   ```
3. Delete directory: `fs.rm(workspaceRootPath, { recursive: true, force: true })`.
4. Return errors (caller will call `ensureWorkspace` again to recreate).

This matches the Git behavior: reset discards changes but allows `ensureWorkspace` to start fresh.

### 3.6 P4Provider Class Signature

`apps/daemon/src/services/session/vcs/p4.provider.ts`

```typescript
interface P4ProviderConfig {
  p4Stream: string;
  agentWorkspaceRoot: string;
  helixSwarmUrl?: string;
  projectSlug: string;
}

export class P4Provider implements IVCSProvider {
  constructor(private config: P4ProviderConfig) {}

  async ensureWorkspace(ticketId: string): Promise<WorkspaceInfo>;
  async resetWorkspace(ticketId: string): Promise<{ errors: string[] }>;
  async archiveWorkspace(ticketId: string): Promise<{ errors: string[] }>;
  getMcpServers(
    nodePath: string,
    projectId: string,
    ticketId: string,
  ): Record<string, McpServerConfig>;
}
```

---

## 4. P4 MCP Integration

### 4.1 Injection Point

In `session.service.ts`, `spawnClaudeSession()` builds an `mcpConfig` object. Currently it always contains only `potato-cannon`. After this change, it calls `provider.getMcpServers(nodePath, projectId, ticketId)` and merges the result into `mcpConfig.mcpServers`.

```typescript
// Before (current)
const mcpConfig = {
  mcpServers: {
    "potato-cannon": { command: nodePath, args: [mcpProxyPath], env: {...} },
  },
};

// After
const additionalMcpServers = provider.getMcpServers(nodePath, projectId, ticketId);
const mcpConfig = {
  mcpServers: {
    "potato-cannon": { command: nodePath, args: [mcpProxyPath], env: {...} },
    ...additionalMcpServers,
  },
};
```

### 4.2 P4 MCP Server Config

`P4Provider.getMcpServers()` computes `workspaceName` internally from its stored config, then returns the MCP server entry. The complete method body:

```typescript
getMcpServers(nodePath: string, projectId: string, ticketId: string): Record<string, McpServerConfig> {
  const slug = this.config.projectSlug.slice(0, 20);
  const workspaceName = `potato-${slug}-${ticketId}`;
  const p4McpPath = (() => {
    const require = createRequire(import.meta.url);
    try { return require.resolve('perforce-p4-mcp/dist/index.js'); } catch { return null; }
  })();
  if (!p4McpPath) {
    console.warn('[P4Provider] perforce-p4-mcp not found; P4 MCP tools unavailable');
    return {};
  }
  return {
    "perforce-p4": {
      command: nodePath,
      args: [p4McpPath],
      env: { P4CLIENT: workspaceName },
    },
  };
}
```

`createRequire` comes from the built-in `module` package. Because the daemon uses `"type": "module"`, `require.resolve` is not available directly — `createRequire(import.meta.url)` creates a CJS-compatible resolver that works from ESM context. Add this import to the top of `p4.provider.ts`:

```typescript
import { createRequire } from 'module';
```

`P4PORT`, `P4USER`, and `P4PASSWD` are inherited from `process.env` via the PTY spawn (they are not passed to the MCP server config — the MCP server inherits the daemon's process environment automatically).

If `require.resolve` throws (package not installed), the method logs a warning and returns `{}` so the session can still spawn without P4 tools.

### 4.3 Daemon Dependency and OS Field

`perforce-p4-mcp` must be added to the `dependencies` section of `apps/daemon/package.json`. The current format uses caret ranges; add:

```json
"perforce-p4-mcp": "^<version>"
```

where `<version>` is the package's current published version on npm.

### 4.3 Tools Available to Agents

Agents in P4 projects have access to:

| MCP Tool | Purpose | Typical User |
|----------|---------|--------------|
| `modify_files` (add/edit/sync/resolve) | Open files for edit, add new files, sync to head, resolve merges | Builder agent, sync-agent |
| `modify_changelists` (create/update) | Manage numbered changelists | Builder agent |
| `modify_shelves` (shelve/unshelve) | Save work-in-progress | Builder agent (checkpoint), shelve-agent (final) |
| `query_files` | Check file state, revision, have rev | Verify agents |
| `query_shelves` | Inspect shelved CLs | Shelve agent |
| `modify_workspaces` | Update client spec if needed | Sync-agent (edge case) |

Checkpoint shelving (mid-task saves) is done by the **builder agent** autonomously via `modify_shelves`. The daemon does not manage intermediate shelves.

### 4.4 P4 Auth Environment

`P4PORT`, `P4USER`, and `P4PASSWD` (or `P4TICKET`) must be set in the daemon's process environment before startup. The daemon passes `...process.env` to all PTY spawns, so all agent sessions inherit these. No separate auth storage is needed.

A startup warning (not error) is emitted if `P4PORT` is unset when any P4 project exists in the database.

---

## 5. Merge Conflict Strategy: Sync Agent

### 5.1 Placement in Worker Tree

The P4 workflow template adds a `sync-agent` worker as the first worker inside the `build-task-loop`, before the existing `build-ralph-loop`:

```
taskmaster-agent
build-task-loop (taskLoop)
  ├── sync-agent (agent)           ← NEW
  └── build-ralph-loop (ralphLoop)
        ├── builder-agent
        ├── verify-spec-agent
        └── verify-quality-agent
```

This means the sync-agent runs once per task before the builder starts. The builder inherits a clean, conflict-free workspace.

### 5.2 Sync Agent Behavior

`apps/daemon/templates/workflows/product-development-p4/agents/sync-agent.md`

The sync agent:

1. Runs `p4 sync //...@head` via `modify_files (action: sync)` to bring the workspace to latest.
2. Checks for conflicts: `modify_files (action: resolve, mode: preview)` — lists what needs resolving.
3. If conflicts exist, attempts auto-merge: `modify_files (action: resolve, mode: auto)`.
4. Checks again for remaining unresolved files.
5. If all resolved: exits cleanly. Builder proceeds.
6. If unresolvable conflicts remain (e.g. binary files, genuine overlapping edits):
   - Calls `chat_notify` with the list of conflicting files and stream-relative paths.
   - Exits with a non-zero status to trigger the existing "session failed" path, which surfaces the blocked ticket to the user.

**Binary files** are never auto-merged; they are escalated immediately.

### 5.3 Escalation Path

The sync-agent runs as a bare `agent` worker inside `taskLoop` (not inside a `ralphLoop`). On failure, the `onTicketBlocked` callback triggered via `processNestedCompletion` in `worker-executor.ts` blocks the ticket and emits an event — no new escalation machinery needed.

Consequences of sync-agent failure:

- (a) A non-zero exit from the sync-agent triggers `worker-executor.ts`'s session-failed path, which blocks the **entire ticket** (not just the current task) and moves it to the Blocked phase.
- (b) The user must resolve the conflict manually in P4V or via CLI, then restart the Build phase. Restarting the Build phase restarts the full `taskLoop` from scratch.
- (c) This is a known limitation: partial task completion is not preserved across a sync-conflict block. All previously completed tasks in the current Build phase will be re-executed after the restart.

---

## 6. Shelve and Review Phase

### 6.1 Template Difference

The `product-development-p4` template replaces the `Pull Requests` phase with a `Shelve` phase:

```json
{
  "id": "Shelve",
  "name": "Shelve",
  "description": "Shelve completed work and notify reviewer",
  "workers": [
    {
      "id": "shelve-agent",
      "type": "agent",
      "source": "agents/shelve-agent.md",
      "description": "Shelves CL and notifies user with review link or CL number"
    }
  ],
  "transitions": {
    "next": null
  },
  "requiresIsolation": true
}
```

### 6.2 Shelve Agent Steps

`apps/daemon/templates/workflows/product-development-p4/agents/shelve-agent.md`

1. Read all artifacts via `potato:list_artifacts` and `potato:get_artifact`.
2. Ensure all modified files are in a single numbered CL: use `modify_changelists` to create or update a CL with a description derived from the ticket title and refinement artifact.
3. Verify no files remain open outside the target CL.
4. Call `modify_shelves (action: shelve)` to shelve the CL.
5. Branch on Swarm configuration:
   - **Swarm configured** (`HELIX_SWARM_URL` environment variable is non-empty): Construct the review URL as `{HELIX_SWARM_URL}/reviews/{clNumber}` and call `chat_notify` with it.
   - **No Swarm**: Call `chat_notify` with: "CL {clNumber} shelved in workspace {workspaceName}. Submit manually via P4V or `p4 submit -c {clNumber}`."
6. Mark phase complete.

The `helixSwarmUrl` is injected as the `HELIX_SWARM_URL` environment variable in the PTY spawn env for P4 projects (see Section 11.1). The agent reads `process.env.HELIX_SWARM_URL` at runtime and branches accordingly.

---

## 7. Database Schema Changes

### 7.1 New Columns on `projects` Table

Migration V8 adds three nullable TEXT columns:

| Column | Type | Purpose |
|--------|------|---------|
| `p4_stream` | `TEXT` | Perforce stream path, e.g. `//MyDepot/Dev`. `NULL` means Git project. |
| `agent_workspace_root` | `TEXT` | Directory where P4 workspaces are created, e.g. `C:\AgentWorkspaces\MyProject\` |
| `helix_swarm_url` | `TEXT` | Optional Helix Swarm base URL, e.g. `https://swarm.example.com` |

### 7.2 Migration Function

In `apps/daemon/src/stores/migrations.ts`. Read `CURRENT_SCHEMA_VERSION` directly from the file and increment it by 1 for this migration — do not rely on documentation for the current value, as it may be out of sync with the code. Add the new migration block after the last existing `if (version < N)` block:

```typescript
// Increment CURRENT_SCHEMA_VERSION by 1 from its current value in the file.

// Inside runMigrations(), add after the last existing `if (version < N)` block:
if (version < N) {   // N = the new CURRENT_SCHEMA_VERSION
  migrateVN(db);
}

function migrateVN(db: Database.Database): void {
  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const names = new Set(columns.map((c) => c.name));

  if (!names.has('p4_stream')) {
    db.exec(`ALTER TABLE projects ADD COLUMN p4_stream TEXT`);
  }
  if (!names.has('agent_workspace_root')) {
    db.exec(`ALTER TABLE projects ADD COLUMN agent_workspace_root TEXT`);
  }
  if (!names.has('helix_swarm_url')) {
    db.exec(`ALTER TABLE projects ADD COLUMN helix_swarm_url TEXT`);
  }
}
```

### 7.3 Project Type Update

In `apps/daemon/src/types/config.types.ts` (the `Project` interface is defined there, as confirmed by the import `import type { Project } from "../types/config.types.js"` in `project.store.ts`), add to the `Project` interface:

```typescript
export interface Project {
  // ... existing fields ...
  p4Stream?: string;
  agentWorkspaceRoot?: string;
  helixSwarmUrl?: string;
}
```

### 7.4 Project Store Update

In `apps/daemon/src/stores/project.store.ts`:

**`rowToProject`** — add three lines after the existing `folderId` mapping (line 65):

```typescript
p4Stream: (row.p4_stream as string) || undefined,
agentWorkspaceRoot: (row.agent_workspace_root as string) || undefined,
helixSwarmUrl: (row.helix_swarm_url as string) || undefined,
```

**`updateProject`** — add three if-blocks following the existing pattern (after the `folderId` block at line 203–206):

```typescript
if (updates.p4Stream !== undefined) {
  fields.push("p4_stream = ?");
  values.push(updates.p4Stream || null);
}
if (updates.agentWorkspaceRoot !== undefined) {
  fields.push("agent_workspace_root = ?");
  values.push(updates.agentWorkspaceRoot || null);
}
if (updates.helixSwarmUrl !== undefined) {
  fields.push("helix_swarm_url = ?");
  values.push(updates.helixSwarmUrl || null);
}
```

**`createProject`** — update `CreateProjectInput` and the INSERT statement. The complete updated `CreateProjectInput` interface:

```typescript
export interface CreateProjectInput {
  displayName: string;
  path: string;
  icon?: string;
  color?: string;
  templateName?: string;
  templateVersion?: string;
  p4Stream?: string;             // NEW
  agentWorkspaceRoot?: string;   // NEW
  helixSwarmUrl?: string;        // NEW
}
```

The complete updated INSERT SQL statement:

```typescript
this.db.prepare(`
  INSERT INTO projects (
    id, slug, display_name, path, registered_at,
    icon, color, template_name, template_version,
    p4_stream, agent_workspace_root, helix_swarm_url
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  id,
  slug,
  input.displayName,
  input.path,
  registeredAt,
  input.icon || null,
  input.color || null,
  input.templateName || null,
  input.templateVersion || null,
  input.p4Stream || null,
  input.agentWorkspaceRoot || null,
  input.helixSwarmUrl || null,
);
```

The positional order of the `.run()` values must exactly match the column order in the INSERT column list. The original INSERT had 9 columns and 9 `?` placeholders; this updated version has 12 of each.

---

## 8. Workflow Template Changes

### 8.1 `requiresIsolation` Field

The schema field `requiresWorktree: boolean` is deprecated but not removed:

- In `template.types.ts`, the `Phase` interface adds `requiresIsolation?: boolean`.
- The existing `requiresWorktree?: boolean` field is kept as a deprecated alias.
- `phase-config.ts` `phaseRequiresWorktree()` is renamed to `phaseRequiresIsolation()` and checks both fields: `phase?.requiresIsolation ?? phase?.requiresWorktree ?? false`.

Existing `workflow.json` files using `"requiresWorktree": true` continue to work without changes.

**Import rename and call-site renames — implementer action required:**

The exported function name changes from `phaseRequiresWorktree` to `phaseRequiresIsolation` in `apps/daemon/src/services/session/phase-config.ts`.

Three things must change in `apps/daemon/src/services/session/session.service.ts`:

1. **The import statement** (line ~50) must be updated from:

```typescript
import { getPhaseConfig, phaseRequiresWorktree, getNextEnabledPhase } from "./phase-config.js";
```

to:

```typescript
import { getPhaseConfig, phaseRequiresIsolation, getNextEnabledPhase } from "./phase-config.js";
```

2. **The call site in `spawnAgentWorker`** (line ~907) must be renamed from:

```typescript
const needsWorktree = await phaseRequiresWorktree(projectId, phase);
```

to:

```typescript
const needsIsolation = await phaseRequiresIsolation(projectId, phase);
```

3. **The call site in `resumeSuspendedTicket`** (line ~1034) must be renamed from:

```typescript
const needsWorktree = await phaseRequiresWorktree(projectId, ticket.phase);
```

to:

```typescript
const needsIsolation = await phaseRequiresIsolation(projectId, ticket.phase);
```

After making these changes, search all files for any remaining usages of `phaseRequiresWorktree` — both imports and call sites — and update them:

```bash
grep -r "phaseRequiresWorktree" apps/
```

At the time of writing, only `session.service.ts` imports and calls it, but verify this grep during implementation in case other files were added.

### 8.2 New Template: `product-development-p4`

Directory: `apps/daemon/templates/workflows/product-development-p4/`

This template differs from `product-development` in two ways:

1. The `Build` phase's `build-task-loop` gains a `sync-agent` before `build-ralph-loop`.
2. The `Pull Requests` phase is replaced by a `Shelve` phase using `shelve-agent.md`.

**Template file strategy (follow-up implementation task required):** The `product-development-p4` template should ship **only** `sync-agent.md` and `shelve-agent.md` as unique files. The fallback mechanism lives in `apps/daemon/src/stores/template.store.ts:getAgentPromptForProject` (not in `agent-loader.ts`). That function currently implements a 3-level lookup: (1) project override, (2) project standard agent, (3) global catalog. A 4th fallback level must be added:

1. Add a `parentTemplate?: string` field to the `WorkflowTemplate` interface (in `template.types.ts`) and to `templates/workflows/workflow.schema.json`.
2. `product-development-p4/workflow.json` sets `"parentTemplate": "product-development"`.
3. `getAgentPromptForProject` adds a 4th level: if the agent file is not found in levels 1–3 under the project's assigned template, check if the template has a `parentTemplate` and retry the global catalog lookup with that parent template name.

Pseudocode for the 4-level lookup:

```typescript
// 1. Project override
if (await hasProjectAgentOverride(projectId, agentPath)) { return override; }

// 2. Project standard agent (local copy)
if (await hasProjectTemplate(projectId)) {
  try { return await getProjectAgentPrompt(projectId, agentPath); } catch {}
}

// 3. Global catalog — assigned template
// NOTE: The existing level 3 is a bare `return` statement, not a try/catch.
// It must be restructured: wrap the existing
//   return getAgentPrompt(project.template.name, agentPath);
// in a try/catch block so that if the agent file is not found (thrown error),
// execution falls through to level 4 rather than propagating the error.
const project = await getProjectById(projectId);
try { return await getAgentPrompt(project.template.name, agentPath); } catch {}

// 4. Global catalog — parent template (NEW)
const workflow = await getWorkflow(project.template.name);
if (workflow?.parentTemplate) {
  return await getAgentPrompt(workflow.parentTemplate, agentPath);
  // NOTE: `await` is required — getAgentPrompt is async (Promise<string>).
  // Omitting await would return Promise<Promise<string>> causing a TypeScript error.
}

throw new Error(`Agent ${agentPath} not found`);
```

This keeps the P4 template to 2 unique files and eliminates permanent maintenance drift from duplicating all ~10 agent files. This fallback extension is required alongside the main work — without it, a naive copy approach will cause all shared agents to diverge over time.

```
apps/daemon/templates/workflows/product-development-p4/
├── workflow.json                 ← sets "parentTemplate": "product-development"
└── agents/
    ├── sync-agent.md             ← UNIQUE to P4
    └── shelve-agent.md           ← UNIQUE to P4
    # All other agents (refinement.md, architect.md, builder.md, etc.)
    # fall back to product-development/ via the 4th lookup level in
    # getAgentPromptForProject
```

### 8.3 Schema Update

In `templates/workflows/workflow.schema.json`, add `requiresIsolation` as an optional boolean alongside the existing `requiresWorktree`. Both fields are accepted; either `true` activates isolation.

---

## 9. Windows / Cross-Platform Fixes

### 9.1 New Utility: `resolve-executable.ts`

New file: `apps/daemon/src/utils/resolve-executable.ts`

This utility extracts the existing `resolveClaudeExecutable` logic from `session.service.ts` into a shared module and generalises it.

```typescript
import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import os from "os";

/**
 * Resolve the path to a named executable, cross-platform.
 * Returns null if not found.
 */
export function resolveExecutable(name: string): string | null {
  if (process.platform === "win32") {
    // On native Windows, try 'where' first to avoid noisy 'which' errors
    try {
      const results = execSync(`where ${name}`, { encoding: "utf-8", stdio: "pipe" })
        .trim()
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean);
      const exePath = results.find((p) => /\.exe$/i.test(p));
      if (exePath && existsSync(exePath)) return exePath;
      if (results[0] && existsSync(results[0])) return results[0];
    } catch { /* continue */ }

    // Secondary fallback: 'which' works in Git Bash on Windows
    try {
      const found = execSync(`which ${name}`, { encoding: "utf-8", stdio: "pipe" }).trim();
      if (found && existsSync(found)) return found;
    } catch { /* continue */ }

    const candidates = [
      path.join(process.env.APPDATA || "", "npm", `${name}.cmd`),
      path.join(process.env.APPDATA || "", "npm", `${name}.exe`),
      `C:\\Program Files\\Perforce\\${name}.exe`,
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }

  // Unix common locations
  for (const c of [
    path.join(os.homedir(), ".local", "bin", name),
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ]) {
    if (existsSync(c)) return c;
  }

  return null;
}

/** Resolve node. Falls back to process.execPath (always valid). */
export function resolveNode(): string {
  return resolveExecutable("node") ?? process.execPath;
}

/**
 * Resolve Claude CLI path + prepend args (handles .cmd wrapper on Windows).
 * Extracted from session.service.ts resolveClaudeExecutable().
 */
export function resolveClaude(nodePath: string): {
  claudePath: string;
  claudePrependArgs: string[];
} {
  // ... existing resolveClaudeExecutable logic verbatim ...
}
```

### 9.2 `package.json` OS Restriction

`apps/daemon/package.json` currently has:

```json
"os": ["darwin", "linux"]
```

This must be updated to include `"win32"` (or the `os` field removed entirely) as part of Windows first-class support:

```json
"os": ["darwin", "linux", "win32"]
```

Without this change, `npm install` will refuse to install the daemon package on Windows.

### 9.3 Files to Update

| File | Current pattern | Fix |
|------|----------------|-----|
| `apps/daemon/src/marketplace/bootstrap.ts:23` | `execSync('which claude', ...)` | Replace with `resolveExecutable('claude')` |
| `apps/daemon/src/services/summarize.ts:43` | `execSync("which claude", ...)` | Replace with `resolveExecutable('claude') ?? 'claude'` |
| `apps/daemon/src/server/routes/artifact-chat.routes.ts:348` | `execSync("which claude", ...)` | Replace with `resolveExecutable('claude') ?? 'claude'` |
| `apps/daemon/src/system-agents/runner.ts:72` | `execSync("which claude", ...)` | Replace with `resolveExecutable('claude') ?? 'claude'` |
| `apps/daemon/src/services/session/session.service.ts:393` | `execSync("which node", ...)` | Replace with `resolveNode()` |
| `apps/daemon/src/services/session/session.service.ts:710` | `execSync("which node", ...)` inside `spawnForBrainstorm` | Replace with `resolveNode()` |
| `apps/daemon/src/services/session/session.service.ts:68-120` | `resolveClaudeExecutable()` local fn | Replace body with `resolveClaude()` from shared util |

Each file updated to use `resolveExecutable` or `resolveNode` must also add the appropriate import:
```typescript
import { resolveExecutable, resolveNode } from '../../utils/resolve-executable.js';
// (adjust the relative path based on the file's location)
```
`session.service.ts` gets this import via Section 11.1's required imports block.

---

## 10. Project Registration Flow

### 10.1 New API Fields

`PATCH /api/projects/:id` accepts three new optional fields. The current handler has a TypeScript cast for `req.body` (in `projects.routes.ts`, line ~291) that must be updated to include the new fields:

```typescript
const updates = req.body as {
  displayName?: string;
  icon?: string;
  color?: string;
  swimlaneColors?: Record<string, string>;
  folderId?: string | null;
  p4Stream?: string;            // NEW — e.g. "//MyDepot/Dev"
  agentWorkspaceRoot?: string;  // NEW — e.g. "C:\\AgentWorkspaces\\MyProject\\"
  helixSwarmUrl?: string;       // NEW — e.g. "https://swarm.example.com"
};
```

`GET /api/projects` also has an explicit field projection map (lines ~188–201 of `projects.routes.ts`) that must be updated to include the three new fields alongside the existing ones:

```typescript
const list = Array.from(projects.values()).map((p) => ({
  // ... existing fields ...
  p4Stream: p.p4Stream,
  agentWorkspaceRoot: p.agentWorkspaceRoot,
  helixSwarmUrl: p.helixSwarmUrl,
}));
```

Without this change, the new fields will be absent from the list response even if set correctly in the database.

### 10.2 P4 Info Detection on Registration

When registering a new project via `POST /api/projects`, after the existing `git remote get-url` detection attempt, add:

```typescript
try {
  const p4InfoRaw = execSync("p4 info", { cwd: projectPath, encoding: "utf-8", stdio: "pipe" });
  const streamMatch = p4InfoRaw.match(/^Client stream:\s+(.+)$/m);
  if (streamMatch) {
    suggestedP4Stream = streamMatch[1].trim();
  }
} catch {
  // Not a P4 workspace or p4 not on PATH — silently skip
}
```

**Breaking change note:** The current `POST /api/projects` handler returns a flat `Project` object directly (`res.json(refreshedProject)`). Changing the response to `{ project: Project, suggestedP4Stream?: string }` would be a breaking change to the existing contract. The correct approach is to keep the flat `Project` object as the top-level response but add `suggestedP4Stream` as an additional top-level field alongside the project's own fields:

```typescript
res.json({ ...refreshedProject, suggestedP4Stream });
```

This means `suggestedP4Stream` is an extra field on the response object, colocated with all `Project` fields. The frontend's project registration handler must be updated to read `response.suggestedP4Stream` from this response and pre-fill the stream field in the UI. The user must confirm before saving.

### 10.3 Frontend: Project Settings Panel

The project settings panel needs a new "Perforce" section with:

- **P4 Stream** (text input): `//Depot/Stream` — must start with `//` if provided
- **Agent Workspace Root** (text input): local directory path
- **Helix Swarm URL** (text input, optional): `https://swarm.example.com`

When `p4Stream` is set:
- Template selector defaults to `product-development-p4` (pre-filled in the UI, not auto-saved)
- Branch prefix field is hidden (not applicable for P4)

On the server side: `PATCH /api/projects/:id` with `p4Stream` set automatically updates `template` to `product-development-p4` unless another template is explicitly provided in the same request body.

Validation: `p4Stream` must start with `//` or be empty. `agentWorkspaceRoot` must be a non-empty string when `p4Stream` is set.

### 10.4 Pre-Build Validation

Before a ticket enters the Build phase on a P4 project, validate:

1. `project.p4Stream` is non-empty.
2. `project.agentWorkspaceRoot` is non-empty.
3. The `agentWorkspaceRoot` directory exists (or can be created).
4. `p4 info` succeeds (P4 CLI on PATH and server reachable).

These checks run in `worker-executor.ts` before `ensureWorkspace()` is called. Failure blocks the ticket with a human-readable error surfaced via the existing error handling path.

---

## 11. Session Service Integration

### 11.1 Changes to `session.service.ts`

**Required new imports for `session.service.ts`:**

Add the following imports to the import section of `session.service.ts` (alongside the existing imports, e.g. after the `./types.js` import block):

```typescript
import { resolveNode } from "../../utils/resolve-executable.js";
import { createVCSProvider } from "./vcs/factory.js";
import type { McpServerConfig } from "./vcs/types.js";
```

Note: the existing `import { ensureWorktree } from "./worktree.js"` (line ~49) is removed as part of this section's changes — it becomes unused after the provider abstraction, because `ensureWorktree` is now called exclusively from within `GitProvider.ensureWorkspace()`.

**`meta` object — `branchName` must be updated in `spawnAgentWorker`:**

In `spawnAgentWorker`, the `meta` object is currently constructed with a Git-specific hardcoded branch string (line ~943):

```typescript
// Before (Git-specific):
branchName: `${branchPrefix}/${ticketId}`,

// After (VCS-agnostic):
branchName: workspaceLabel,
```

`workspaceLabel` is set from `workspace.workspaceLabel` when isolation is required, or `""` when it is not, matching the same variable introduced by the `ensureWorkspace` call below.

The `spawnAgent` callback currently calls `ensureWorktree` conditionally. After this change:

```typescript
const project = getProjectById(projectId);
if (!project) throw new Error(`Project ${projectId} not found`); // null guard required — createVCSProvider takes Project, not Project | null
const provider = createVCSProvider(project);

let worktreePath: string;
let workspaceLabel: string;

if (await phaseRequiresIsolation(projectId, phase)) {
  const workspace = await provider.ensureWorkspace(ticketId);
  worktreePath = workspace.workspacePath;
  workspaceLabel = workspace.workspaceLabel;
} else {
  worktreePath = projectPath;
  workspaceLabel = "";
}

// nodePath is not available from spawnClaudeSession's internal scope here;
// resolve it explicitly at the top of spawnAgentWorker using the shared utility
// from apps/daemon/src/utils/resolve-executable.ts (see Section 9).
const nodePath = resolveNode();
const additionalMcpServers = provider.getMcpServers(nodePath, projectId, ticketId);
this.spawnClaudeSession(..., additionalMcpServers);
```

**`spawnClaudeSession` signature change:** Add ONE new optional parameter at the end. The complete updated signature (all 15 parameters):

```typescript
private spawnClaudeSession(
  sessionId: string,
  meta: SessionMeta,
  prompt: string,
  worktreePath: string,
  projectId: string,
  ticketId: string,
  brainstormId: string,
  agentType: string,
  phase: TicketPhase | undefined,
  projectPath: string,
  stage: number,
  additionalDisallowedTools?: string[],
  model?: string,
  claudeResumeSessionId?: string,
  additionalMcpServers?: Record<string, McpServerConfig>,  // NEW 15th param
): string
```

The complete updated `spawnAgentWorker` call site (all 15 positional args):

```typescript
return this.spawnClaudeSession(
  sessionId,
  meta,
  prompt,
  worktreePath,
  projectId,
  ticketId,
  "",              // brainstormId
  agentWorker.source,
  phase,
  projectPath,
  0,               // stage
  agentWorker.disallowTools,
  resolvedModel ?? undefined,
  undefined,       // claudeResumeSessionId (no resume for fresh agent)
  additionalMcpServers, // NEW 15th arg
);
```

The complete updated `resumeSuspendedTicket` call site (all 15 positional args):

```typescript
return this.spawnClaudeSession(
  storedSession.id,
  meta,
  prompt,
  worktreePath,
  projectId,
  ticketId,
  "",              // brainstormId
  "resume",
  ticket.phase,
  project.path,
  0,               // stage
  undefined,       // additionalDisallowedTools
  undefined,       // model
  claudeSessionId, // triggers --resume flag
  additionalMcpServers, // NEW 15th arg
);
```

Inside `spawnClaudeSession`, merge `additionalMcpServers` into `mcpConfig.mcpServers` via spread:

```typescript
const mcpConfig = {
  mcpServers: {
    "potato-cannon": { command: nodePath, args: [mcpProxyPath], env: { ... } },
    ...additionalMcpServers,
  },
};
```

For P4 projects, `spawnClaudeSession` also injects `HELIX_SWARM_URL` into the PTY spawn env. Call `getProjectById(projectId)` inside `spawnClaudeSession` — it is synchronous (returns `Project | null`, not a `Promise`) and `projectId` is already a parameter, so no additional parameter is needed. The exact updated PTY spawn block:

```typescript
const project = getProjectById(projectId);
const proc = pty.spawn(claudePath, [...claudePrependArgs, ...args], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: worktreePath,
  env: {
    ...process.env,
    POTATO_PROJECT_ID: projectId,
    POTATO_TICKET_ID: ticketId,
    POTATO_BRAINSTORM_ID: brainstormId,
    ...(project?.helixSwarmUrl ? { HELIX_SWARM_URL: project.helixSwarmUrl } : {}),
  },
});
```

`HELIX_SWARM_URL` is only added when `project.helixSwarmUrl` is non-empty. For Git projects and P4 projects without Swarm configured, the variable is absent from the environment (not set to an empty string), so agents can test `process.env.HELIX_SWARM_URL` with a simple truthiness check.

**Remove dead declarations after the provider refactor:**

After the provider abstraction is in place, two declarations in `spawnAgentWorker` become dead code and must be removed:

- Remove `const branchPrefix = project?.branchPrefix || 'potato'` (line ~905 of `session.service.ts`) — `branchPrefix` has no remaining usages inside `spawnAgentWorker` once `workspaceLabel` replaces it in the `meta` object and `ensureWorkspace` replaces `ensureWorktree`.
- Remove the import of `ensureWorktree` from line ~49 of `session.service.ts` — after the provider abstraction, `ensureWorktree` is no longer called directly from `session.service.ts`. It is called exclusively from within `GitProvider.ensureWorkspace()`.

```typescript
// DELETE this import from session.service.ts line ~49:
import { ensureWorktree } from "./worktree.js";
```

**Note on sync/async:** `getProjectById` is synchronous (returns `Project | null`, not a `Promise`) — no `await` is needed there. `phaseRequiresIsolation` is async (it calls `getPhaseConfig` which calls `getTemplateWithFullPhasesForProject`) and DOES require `await`.

### 11.2 Archive/Reset Integration

**Import changes required:**

For `apps/daemon/src/stores/ticket.store.ts`:
- Remove: `import { removeWorktreeAndBranch } from "../services/session/worktree.js"` (currently line 13)
- Add: `import { createVCSProvider } from "../services/session/vcs/factory.js"`

For `apps/daemon/src/services/ticket-restart.service.ts`:
- Remove: `import { removeWorktreeAndRenameBranch } from "./session/worktree.js"` (currently line 8)
- Add: `import { createVCSProvider } from "./session/vcs/factory.js"`

- `ticket-restart.service.ts` — replace direct `removeWorktreeAndRenameBranch` call (line ~89) with `provider.resetWorkspace(ticketId)`. The project record is already fetched via `getProjectById(projectId)` earlier in `restartToPhase`; pass it to `createVCSProvider(project)`.
- `apps/daemon/src/stores/ticket.store.ts:archiveTicket()` — replace the direct `removeWorktreeAndBranch(project.path, ticketId, project.branchPrefix)` call (line ~527) with `provider.archiveWorkspace(ticketId)`. The `project` object is already fetched inside `archiveTicket()` via `getProjectById(projectId)`; call `createVCSProvider(project)` there.

**Note on `RestartResult.cleanup.branchRenamed`:** The `RestartResult` type (in `ticket-restart.service.ts`) includes a `branchRenamed: string | null` field that is Git-specific. For P4 projects, `branchRenamed` will always be `null` because `resetWorkspace` does not rename branches. The frontend must handle `null` gracefully and must not display a "branch renamed" message when this field is null. This is an acceptable VCS-semantic leak in the current design.

### 11.3 `resumeSuspendedTicket` Integration

`session.service.ts:resumeSuspendedTicket()` (lines ~978–1072) is a second call site that calls `ensureWorktree` directly and is completely separate from `spawnAgentWorker`. It contains (lines ~1034–1037):

```typescript
const needsWorktree = await phaseRequiresWorktree(projectId, ticket.phase);
const worktreePath = needsWorktree
  ? await ensureWorktree(project.path, ticketId, branchPrefix)
  : project.path;
```

And then sets `SessionMeta.branchName` (line ~1045):

```typescript
branchName: `${branchPrefix}/${ticketId}`,
```

These must be updated to use the VCS provider:

```typescript
const provider = createVCSProvider(project);
const needsIsolation = await phaseRequiresIsolation(projectId, ticket.phase);
let worktreePath: string;
let workspaceLabel: string;
if (needsIsolation) {
  const workspace = await provider.ensureWorkspace(ticketId);
  worktreePath = workspace.workspacePath;
  workspaceLabel = workspace.workspaceLabel;
} else {
  worktreePath = project.path;
  workspaceLabel = "";
}
```

Replace `branchName: \`${branchPrefix}/${ticketId}\`` in the `meta` object with `branchName: workspaceLabel`.

The `provider` built here IS used to compute `additionalMcpServers` for `spawnClaudeSession`. Resumed P4 sessions need the P4 MCP tools just as much as fresh sessions: the `--resume` flag only restores Claude's conversation history; it does not persist MCP configuration across sessions. MCP config is declared fresh on every spawn. Therefore, resolve `nodePath` explicitly at the top of `resumeSuspendedTicket` (same pattern as `spawnAgentWorker`, Section 11.1) and compute `additionalMcpServers` before the `spawnClaudeSession` call:

```typescript
const nodePath = resolveNode(); // from apps/daemon/src/utils/resolve-executable.ts
const additionalMcpServers = provider.getMcpServers(nodePath, projectId, ticketId);
// Pass additionalMcpServers as the 15th argument to spawnClaudeSession (same as in spawnAgentWorker)
```

**Remove dead declaration after the provider refactor:**

Remove `const branchPrefix = project.branchPrefix || "potato"` (line ~1033 of `session.service.ts`) from `resumeSuspendedTicket` — `branchPrefix` has no remaining usages once `workspaceLabel` replaces it in the `meta` object and `ensureWorkspace` replaces `ensureWorktree`.

### 11.4 Session Meta Semantics

`SessionMeta.worktreePath` and `SessionMeta.branchName` keep their names for backward compatibility. Semantically:
- `worktreePath` → working directory path (worktree for Git, workspace root for P4)
- `branchName` → workspace label (branch name for Git, P4 workspace name for P4)

No schema change — these are in-memory and log-only fields.

---

## 12. Open Questions and Risks

### 12.1 P4 MCP Package Discovery

The `perforce-p4-mcp` package path needs to be resolved at runtime:
- **Recommended:** Use `createRequire(import.meta.url)` to create a CJS-compatible resolver and call `require.resolve('perforce-p4-mcp/dist/index.js')` (see Section 4.2 for the ESM-safe pattern). Fall back to a path in global `config.json`. Surface a clear error in the UI if not found when a P4 project is active.

### 12.2 P4 Environment Variables in Service Mode

If the daemon runs as a Windows Service or systemd unit, `P4PORT`/`P4USER`/`P4PASSWD` may not be set. Operators must configure these in the service environment. Add a startup log warning (not error) if `P4PORT` is unset when any P4 project exists.

### 12.3 Workspace Name Collisions

Using `potato-{projectSlug}-{ticketId}` (e.g. `potato-myproject-POT-1`) mitigates collisions when multiple Potato Cannon instances share a P4 server. Slugs are capped at 20 characters in workspace naming (see Section 3.1); the slug stored in the database is unaffected.

**Decision needed:** Confirm acceptable workspace naming convention with P4 admin.

### 12.4 WSL / Native Windows Mixed Environment

Design assumes daemon and Claude sessions run in the same environment. Mixed WSL/native is out of scope. Document as unsupported.

### 12.5 Sync Agent Escalation

The sync-agent runs as a bare `agent` inside `taskLoop`. On unresolvable conflicts it exits non-zero, which triggers the existing "session failed" path in `worker-executor.ts` and blocks the ticket. **Confirmed resolved.** `worker-executor.ts:processNestedCompletion` handles a non-zero exit from a bare `agent` inside a `taskLoop` via the `onTicketBlocked` callback (not a panic). Verified in `worker-executor.ts` lines 716–721: the task is marked `failed` and `onTicketBlocked` is called, moving the ticket to the Blocked phase.

### 12.6 `helixSwarmUrl` in Agent Context

The shelve-agent needs `helixSwarmUrl` at runtime. Mechanism: inject `HELIX_SWARM_URL: project.helixSwarmUrl ?? ''` in the PTY spawn env for P4 projects (see Section 11.1). The agent reads `process.env.HELIX_SWARM_URL` at runtime and branches accordingly (see Section 6.2). An empty string is treated as "no Swarm configured."

### 12.7 Backward Compatibility: `requiresWorktree`

Existing template copies at `~/.potato-cannon/project-data/{projectId}/template/workflow.json` use `requiresWorktree`. The `phaseRequiresIsolation()` function must check both fields. The schema must accept both.

### 12.8 P4VFS `vclient` Availability

P4VFS requires a licensed Windows kernel driver. The fallback (regular workspace + `sync -k`) is the expected common path. Log clearly which mode is active at workspace creation time.

### 12.9 Helix Swarm Review Creation

The design has the shelve-agent construct the Swarm review URL manually (`{helixSwarmUrl}/reviews/{clNumber}`). Swarm can also create reviews via its REST API. If automatic review creation (rather than just a link) is desired in the future, the shelve-agent would need to call the Swarm API. This is out of scope for this design but the `helixSwarmUrl` field supports it.
