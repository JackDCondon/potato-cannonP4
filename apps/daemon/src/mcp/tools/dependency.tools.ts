import fs from "fs/promises";
import path from "path";
import { TASKS_DIR } from "../../config/paths.js";
import {
  ticketDependencyGetForTicket,
} from "../../stores/ticket-dependency.store.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";
import type { ArtifactManifest } from "../../types/index.js";
import type { BlockedByEntry } from "@potato-cannon/shared";

// =============================================================================
// Tool Definition
// =============================================================================

export const dependencyTools: ToolDefinition[] = [
  {
    name: "get_dependencies",
    description:
      "Get the dependency artifacts for a ticket. Returns each dependency with its satisfaction status, artifact filenames, and whether it has further dependencies. Defaults to the current ticket; pass a different ticketId only if the current ticket depends on it (directly or transitively).",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description:
            "Optional ticket ID to query. Must be reachable from the current ticket via dependency edges. Defaults to the current ticket.",
        },
      },
      required: [],
    },
  },
  {
    name: "delete_dependency",
    description: "Delete a dependency edge between two tickets.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "The ticket that has the dependency edge.",
        },
        dependsOnId: {
          type: "string",
          description: "The ticket that the source ticket depends on.",
        },
      },
      required: ["ticketId", "dependsOnId"],
    },
  },
];

// =============================================================================
// Helpers
// =============================================================================

/** Build the artifacts directory path for a given project+ticket. */
function getArtifactsDir(projectId: string, ticketId: string): string {
  const safeProject = projectId.replace(/\//g, "__");
  return path.join(TASKS_DIR, safeProject, ticketId, "artifacts");
}

/** Read manifest.json and return artifact filenames, or empty array on missing. */
async function readArtifactFilenames(
  projectId: string,
  ticketId: string,
): Promise<string[]> {
  const manifestPath = path.join(
    getArtifactsDir(projectId, ticketId),
    "manifest.json",
  );
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const manifest: ArtifactManifest = JSON.parse(raw);
    return Object.keys(manifest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * BFS reachability check: walk dependency edges from `sourceTicketId` and
 * return true if `targetTicketId` is reachable (i.e. source depends on target
 * directly or transitively).
 */
function isReachableViaDependencies(
  sourceTicketId: string,
  targetTicketId: string,
): boolean {
  const visited = new Set<string>();
  const queue: string[] = [sourceTicketId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetTicketId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const deps = ticketDependencyGetForTicket(current);
    for (const dep of deps) {
      if (!visited.has(dep.ticketId)) {
        queue.push(dep.ticketId);
      }
    }
  }

  return false;
}

// =============================================================================
// Result Shape
// =============================================================================

interface DependencyResult {
  ticketId: string;
  title: string;
  currentPhase: string;
  tier: string;
  satisfied: boolean;
  artifactFilenames: string[];
  hasFurtherDependencies: boolean;
}

// =============================================================================
// Handler
// =============================================================================

async function getDependencies(
  ctx: McpContext,
  targetTicketId: string,
): Promise<DependencyResult[]> {
  // Fetch dependencies from the REST endpoint
  const url = `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${targetTicketId}/dependencies`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch dependencies for ${targetTicketId}: ${response.statusText}`,
    );
  }
  const deps = (await response.json()) as BlockedByEntry[];

  // Enrich each dependency with artifact filenames and further-dependency flag
  const results: DependencyResult[] = await Promise.all(
    deps.map(async (dep) => {
      const [artifactFilenames, furtherDeps] = await Promise.all([
        readArtifactFilenames(ctx.projectId, dep.ticketId),
        Promise.resolve(ticketDependencyGetForTicket(dep.ticketId)),
      ]);

      return {
        ticketId: dep.ticketId,
        title: dep.title,
        currentPhase: dep.currentPhase,
        tier: dep.tier,
        satisfied: dep.satisfied,
        artifactFilenames,
        hasFurtherDependencies: furtherDeps.length > 0,
      };
    }),
  );

  return results;
}

async function deleteDependency(
  ctx: McpContext,
  ticketId: string,
  dependsOnId: string,
): Promise<void> {
  const url =
    `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${encodeURIComponent(ticketId)}/dependencies` +
    `?dependsOn=${encodeURIComponent(dependsOnId)}`;
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(
      `Failed to delete dependency ${ticketId} -> ${dependsOnId}: ${response.statusText}`,
    );
  }
}

// =============================================================================
// Handlers Export
// =============================================================================

export const dependencyHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  get_dependencies: async (ctx, args) => {
    const requestedTicketId = (args.ticketId as string) || ctx.ticketId;

    // If a different ticket was requested, verify reachability via dependency edges
    if (requestedTicketId !== ctx.ticketId) {
      const reachable = isReachableViaDependencies(
        ctx.ticketId,
        requestedTicketId,
      );
      if (!reachable) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ticket ${requestedTicketId} is not reachable from ${ctx.ticketId} via dependency edges.`,
            },
          ],
        };
      }
    }

    const dependencies = await getDependencies(ctx, requestedTicketId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ dependencies }, null, 2),
        },
      ],
    };
  },
  delete_dependency: async (ctx, args) => {
    const ticketId = args.ticketId as string;
    const dependsOnId = args.dependsOnId as string;

    await deleteDependency(ctx, ticketId, dependsOnId);

    return {
      content: [
        {
          type: "text",
          text: `Dependency deleted: ${ticketId} no longer depends on ${dependsOnId}`,
        },
      ],
    };
  },
};
