/**
 * P4Provider — Perforce workspace lifecycle management.
 *
 * Manages per-ticket Perforce client workspaces using the P4 CLI (spawnSync/execSync).
 * Supports P4VFS (virtual client) detection for near-zero disk-usage workspaces.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import { createRequire } from "module";
import * as path from "path";

import type {
  IVCSProvider,
  McpServerConfig,
  WorkspaceCleanupResult,
  WorkspaceInfo,
} from "./types.js";

/**
 * Configuration for a P4Provider instance.
 */
export interface P4ProviderConfig {
  /** Perforce stream path, e.g. //MyDepot/Dev */
  p4Stream: string;
  /** Root directory under which per-ticket workspaces are created */
  agentWorkspaceRoot: string;
  /** Optional Helix Swarm URL for code-review links */
  helixSwarmUrl?: string;
  /** Project slug used in workspace naming (will be truncated to 20 chars) */
  projectSlug: string;
  /** Optional per-project P4PORT override */
  p4Port?: string;
  /** Optional per-project P4USER override */
  p4User?: string;
}

/**
 * Detect whether P4VFS (Perforce Virtual File System) is available on PATH.
 *
 * Synchronous — uses execSync internally.
 *
 * @returns true if `p4vfs` is available; false otherwise.
 */
function detectP4VFS(): boolean {
  try {
    execSync("p4vfs help", { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize P4 stream paths for client specs.
 *
 * Perforce rejects stream values ending in "/" with:
 * "Null directory (//) not allowed".
 */
export function normalizeP4Stream(p4Stream: string): string {
  const trimmed = p4Stream.trim();
  if (trimmed.length <= 2) return trimmed;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Build the client spec string to pipe to `p4 client -i`.
 */
function buildClientSpec(
  workspaceName: string,
  workspaceRootPath: string,
  p4Stream: string,
  useVClient: boolean,
  ticketId: string
): string {
  const normalizedStream = normalizeP4Stream(p4Stream);
  const lines: string[] = [
    `Client: ${workspaceName}`,
    `Root: ${workspaceRootPath}`,
    `Stream: ${normalizedStream}`,
  ];

  if (useVClient) {
    lines.push("Type: vclient");
  }

  lines.push(
    "Options: noallwrite noclobber nocompress unlocked nomodtime normdir",
    "SubmitOptions: submitunchanged",
    "LineEnd: local",
    `Description: Potato Cannon workspace for ticket ${ticketId}`
  );

  return lines.join("\n") + "\n";
}

/**
 * P4Provider manages Perforce client workspaces for per-ticket isolation.
 *
 * Workspace naming: `potato-{projectSlug(20)}-{ticketId}`
 */
export class P4Provider implements IVCSProvider {
  constructor(private readonly config: P4ProviderConfig) {}

  private p4Args(cmd: string[]): string[] {
    return [
      ...(this.config.p4Port ? ["-p", this.config.p4Port] : []),
      ...(this.config.p4User ? ["-u", this.config.p4User] : []),
      ...cmd,
    ];
  }

  /**
   * Sync a workspace to latest depot state before agent execution.
   */
  private async syncWorkspace(workspaceName: string, workspaceRootPath: string): Promise<void> {
    await fs.mkdir(workspaceRootPath, { recursive: true });
    const syncResult = spawnSync("p4", this.p4Args(["-c", workspaceName, "sync"]), {
      cwd: workspaceRootPath,
      encoding: "utf-8",
    });
    if (syncResult.status !== 0 || syncResult.error) {
      const stderr = syncResult.stderr || syncResult.error?.message || `(exit ${syncResult.status})`;
      throw new Error(`Failed to sync P4 workspace ${workspaceName}: ${stderr}`);
    }
  }

  /**
   * Derive the workspace name for a given ticket.
   */
  private workspaceName(ticketId: string): string {
    const slug = this.config.projectSlug.slice(0, 20);
    return `potato-${slug}-${ticketId}`;
  }

  /**
   * Derive the local workspace root path for a given ticket.
   */
  private workspaceRootPath(ticketId: string): string {
    return path.join(this.config.agentWorkspaceRoot, this.workspaceName(ticketId));
  }

  /**
   * Ensure the P4 client workspace exists for the given ticket.
   *
   * If the workspace already exists (non-empty output from `p4 clients -e`),
   * syncs it and returns existing WorkspaceInfo without re-creating.
   *
   * If new: detects P4VFS availability, creates the local root directory,
   * then pipes a client spec to `p4 client -i`.
   */
  async ensureWorkspace(ticketId: string): Promise<WorkspaceInfo> {
    const workspaceName = this.workspaceName(ticketId);
    const workspaceRootPath = this.workspaceRootPath(ticketId);

    // Check for existing workspace using `p4 clients -e <name>`.
    // Non-empty stdout means the workspace exists.
    // Do NOT use `p4 client -o <name>` — it always emits a template for any name.
    const existsResult = spawnSync("p4", this.p4Args(["clients", "-e", workspaceName]), {
      encoding: "utf-8",
    });

    if (existsResult.error) {
      throw new Error(`p4 binary not found or failed to spawn: ${existsResult.error.message}`);
    }

    if (existsResult.status !== 0 && !existsResult.stdout?.trim()) {
      throw new Error(`Failed to check P4 workspace existence: ${existsResult.stderr || '(no error detail)'}`);
    }

    if (existsResult.stdout && existsResult.stdout.trim().length > 0) {
      console.log(`[P4Provider] Workspace ${workspaceName} already exists; reusing.`);
      await this.syncWorkspace(workspaceName, workspaceRootPath);
      return {
        workspacePath: workspaceRootPath,
        workspaceLabel: workspaceName,
        metadata: { p4Client: workspaceName },
      };
    }

    // Detect P4VFS for virtual client support
    const hasVFS = detectP4VFS();
    console.log(
      `[P4Provider] Creating workspace ${workspaceName} (P4VFS: ${hasVFS ? "enabled" : "disabled"})`
    );

    // Build client spec
    const specString = buildClientSpec(
      workspaceName,
      workspaceRootPath,
      this.config.p4Stream,
      hasVFS,
      ticketId
    );

    // Create the local root directory before `p4 client -i`
    // (p4 client -i creates the spec on the server but not the local dir)
    await fs.mkdir(workspaceRootPath, { recursive: true });

    // Pipe spec to `p4 client -i` using spawnSync (handles stdin safely)
    const createResult = spawnSync("p4", this.p4Args(["client", "-i"]), {
      input: specString,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (createResult.status !== 0) {
      // Clean up the directory created by fs.mkdir to avoid orphaned state
      await fs.rm(workspaceRootPath, { recursive: true, force: true }).catch(() => {});
      const stderr = createResult.stderr || createResult.error?.message || '(no error detail)';
      throw new Error(`Failed to create P4 workspace ${workspaceName}: ${stderr}`);
    }

    console.log(`[P4Provider] Workspace ${workspaceName} created successfully.`);
    await this.syncWorkspace(workspaceName, workspaceRootPath);

    return {
      workspacePath: workspaceRootPath,
      workspaceLabel: workspaceName,
      metadata: { p4Client: workspaceName },
    };
  }

  /**
   * Archive (permanently clean up) the workspace when a ticket is archived.
   *
   * Steps (errors collected non-fatally):
   * 1. Revert all open files (keep-worktree flag: -k)
   * 2. Delete the client spec from the server
   * 3. Remove the local workspace root directory
   */
  async archiveWorkspace(ticketId: string): Promise<WorkspaceCleanupResult> {
    return this._destroyWorkspace(ticketId, "archive");
  }

  /**
   * Reset the workspace for a ticket restart.
   *
   * Performs the same three steps as archiveWorkspace so the caller can invoke
   * ensureWorkspace afterwards to start fresh (mirrors Git worktree reset behaviour).
   */
  async resetWorkspace(ticketId: string): Promise<WorkspaceCleanupResult> {
    return this._destroyWorkspace(ticketId, "reset");
  }

  /**
   * Shared implementation for archiveWorkspace and resetWorkspace.
   * Collects errors non-fatally across all three destruction steps.
   */
  private async _destroyWorkspace(
    ticketId: string,
    operation: "archive" | "reset"
  ): Promise<WorkspaceCleanupResult> {
    const workspaceName = this.workspaceName(ticketId);
    const workspaceRootPath = this.workspaceRootPath(ticketId);
    const errors: string[] = [];

    // Step 1: Revert all open files (keep local files on disk; dir deletion handles removal)
    const revertResult = spawnSync(
      "p4",
      this.p4Args(["-c", workspaceName, "revert", "-k", "//..."]),
      { encoding: "utf-8" }
    );
    if (revertResult.status !== 0 || revertResult.error) {
      const msg = `[P4Provider] ${operation}: revert failed for ${workspaceName}: ${revertResult.stderr || revertResult.error?.message || `exit ${revertResult.status}`}`;
      console.warn(msg);
      errors.push(msg);
    }

    // Step 2: Delete the client spec from the Perforce server
    const deleteResult = spawnSync("p4", this.p4Args(["client", "-d", "-f", workspaceName]), {
      encoding: "utf-8",
    });
    if (deleteResult.status !== 0 || deleteResult.error) {
      const msg = `[P4Provider] ${operation}: client delete failed for ${workspaceName}: ${deleteResult.stderr || deleteResult.error?.message || `exit ${deleteResult.status}`}`;
      console.warn(msg);
      errors.push(msg);
    }

    // Step 3: Remove the local workspace root directory
    try {
      await fs.rm(workspaceRootPath, { recursive: true, force: true });
    } catch (err) {
      const msg = `[P4Provider] ${operation}: directory removal failed for ${workspaceRootPath}: ${String(err)}`;
      console.warn(msg);
      errors.push(msg);
    }

    return { errors };
  }

  /**
   * Return additional MCP servers to inject for P4 sessions.
   *
   * Resolution order:
   * 1) POTATO_P4_MCP_SERVER_PATH runtime override
   * 2) Installed package `perforce-p4-mcp/dist/index.js`
   *
   * Resolves the `perforce-p4-mcp` package via `createRequire`.
   * If the package is not installed, logs a warning and returns {}.
   */
  getMcpServers(
    nodePath: string,
    _projectId: string,
    ticketId: string
  ): Record<string, McpServerConfig> {
    const workspaceName = this.workspaceName(ticketId);

    let p4McpPath: string | null = null;

    const configuredPath = process.env.POTATO_P4_MCP_SERVER_PATH?.trim();
    if (configuredPath) {
      if (existsSync(configuredPath)) {
        p4McpPath = configuredPath;
      } else {
        console.warn(
          `[P4Provider] POTATO_P4_MCP_SERVER_PATH does not exist: ${configuredPath}`
        );
      }
    }

    const require = createRequire(import.meta.url);
    try {
      if (!p4McpPath) {
        p4McpPath = require.resolve("perforce-p4-mcp/dist/index.js");
      }
    } catch {
      if (!p4McpPath) {
        p4McpPath = null;
      }
    }

    if (!p4McpPath) {
      console.warn(
        "[P4Provider] perforce-p4-mcp not found and no global path configured; P4 MCP tools unavailable for session"
      );
      return {};
    }

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
  }
}
