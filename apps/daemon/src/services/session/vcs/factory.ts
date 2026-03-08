/**
 * VCS provider factory.
 * Selects and instantiates the correct IVCSProvider for a project.
 */

import type { Project } from "../../../types/config.types.js";
import { GitProvider } from "./git.provider.js";
import { P4Provider } from "./p4.provider.js";
import type { IVCSProvider } from "./types.js";

/**
 * Instantiate the appropriate VCS provider for the given project.
 *
 * - If `project.p4Stream` is set, returns a `P4Provider` configured for that stream.
 *   Throws if `project.agentWorkspaceRoot` is not present, as it is required for P4.
 * - Otherwise, returns a `GitProvider` wrapping the project's git worktree logic.
 */
export function createVCSProvider(project: Project): IVCSProvider {
  if (project.p4Stream) {
    if (!project.agentWorkspaceRoot) {
      throw new Error(
        `Project "${project.slug}" has p4Stream set but agentWorkspaceRoot is missing. ` +
          "agentWorkspaceRoot must be configured for Perforce projects."
      );
    }
    return new P4Provider({
      p4Stream: project.p4Stream,
      agentWorkspaceRoot: project.agentWorkspaceRoot,
      helixSwarmUrl: project.helixSwarmUrl,
      projectSlug: project.slug,
    });
  }

  return new GitProvider(project.path, project.branchPrefix ?? "potato");
}
