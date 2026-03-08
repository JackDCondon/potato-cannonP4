/**
 * VCS Provider abstraction types.
 * Defines the interface for workspace lifecycle management across different VCS systems.
 */

/**
 * Information about a provisioned workspace.
 */
export interface WorkspaceInfo {
  /** Absolute path to the workspace directory */
  workspacePath: string;
  /** Human-readable label (e.g. branch name or P4 client name) */
  workspaceLabel: string;
  /** Optional provider-specific metadata */
  metadata?: Record<string, string>;
}

/**
 * Result from workspace cleanup operations (archive/reset).
 */
export interface WorkspaceCleanupResult {
  /** Non-empty if any errors occurred during cleanup */
  errors: string[];
  /** The new branch name after renaming (Git only; null/undefined for P4 or archive operations) */
  newBranchName?: string | null;
}

/**
 * MCP server configuration to inject into a Claude session.
 */
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Abstract interface for VCS workspace lifecycle management.
 * Implementations: GitProvider (wraps worktree.ts), P4Provider (manages P4 client workspaces).
 */
export interface IVCSProvider {
  /**
   * Ensure the workspace exists for the given ticket.
   * Creates the workspace if it does not already exist.
   * Returns workspace path and label for session injection.
   */
  ensureWorkspace(ticketId: string): Promise<WorkspaceInfo>;

  /**
   * Reset the workspace for a ticket restart.
   * For Git: removes worktree and renames branch.
   * For P4: reverts and deletes the client workspace, allowing re-creation.
   */
  resetWorkspace(ticketId: string): Promise<WorkspaceCleanupResult>;

  /**
   * Archive (permanently clean up) the workspace when a ticket is archived.
   * For Git: removes worktree and branch.
   * For P4: reverts, deletes client workspace, and removes local root directory.
   */
  archiveWorkspace(ticketId: string): Promise<WorkspaceCleanupResult>;

  /**
   * Return additional MCP servers to inject into Claude sessions for this provider.
   * Git projects return an empty object; P4 projects inject perforce-p4-mcp.
   */
  getMcpServers(
    nodePath: string,
    projectId: string,
    ticketId: string
  ): Record<string, McpServerConfig>;
}
