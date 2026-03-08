/**
 * Git VCS provider implementation.
 * Manages workspace lifecycle using git worktrees for ticket isolation.
 */

import {
  ensureWorktree,
  removeWorktreeAndBranch,
  removeWorktreeAndRenameBranch,
} from "../worktree.js";
import type {
  IVCSProvider,
  McpServerConfig,
  WorkspaceCleanupResult,
  WorkspaceInfo,
} from "./types.js";

/**
 * GitProvider implements IVCSProvider using git worktrees.
 * Each ticket gets an isolated worktree at {projectPath}/.potato/worktrees/{ticketId}
 * on a branch named {branchPrefix}/{ticketId}.
 *
 * No additional MCP servers are required for git-based projects.
 */
export class GitProvider implements IVCSProvider {
  private readonly projectPath: string;
  private readonly branchPrefix: string;

  constructor(projectPath: string, branchPrefix: string) {
    this.projectPath = projectPath;
    this.branchPrefix = branchPrefix;
  }

  /**
   * Ensure a git worktree exists for the given ticket.
   * Creates the worktree and associated branch if they do not already exist.
   */
  async ensureWorkspace(ticketId: string): Promise<WorkspaceInfo> {
    const worktreePath = await ensureWorktree(
      this.projectPath,
      ticketId,
      this.branchPrefix,
    );

    if (worktreePath === this.projectPath) {
      throw new Error(
        `Failed to create git worktree for ticket ${ticketId}: worktree creation returned project root`,
      );
    }

    return {
      workspacePath: worktreePath,
      workspaceLabel: `${this.branchPrefix}/${ticketId}`,
    };
  }

  /**
   * Reset the workspace for a ticket restart.
   * Removes the worktree and renames the branch to a reset archive branch,
   * preserving commits for reference.
   */
  async resetWorkspace(ticketId: string): Promise<WorkspaceCleanupResult> {
    const result = await removeWorktreeAndRenameBranch(
      this.projectPath,
      ticketId,
      this.branchPrefix,
    );

    return { errors: result.errors, newBranchName: result.newBranchName };
  }

  /**
   * Archive (permanently clean up) the workspace for a ticket.
   * Removes the worktree and deletes the local branch entirely.
   */
  async archiveWorkspace(ticketId: string): Promise<WorkspaceCleanupResult> {
    const result = await removeWorktreeAndBranch(
      this.projectPath,
      ticketId,
      this.branchPrefix,
    );

    return { errors: result.errors };
  }

  /**
   * Git projects require no additional MCP servers.
   * Returns an empty object.
   */
  getMcpServers(
    _nodePath: string,
    _projectId: string,
    _ticketId: string,
  ): Record<string, McpServerConfig> {
    return {};
  }
}
