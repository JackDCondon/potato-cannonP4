import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getDatabase } from "./db.js";
import type { TicketDependency, DependencyTier, BlockedByEntry, TemplatePhase } from "@potato-cannon/shared";

// =============================================================================
// Row Types
// =============================================================================

interface DependencyRow {
  id: string;
  ticket_id: string;
  depends_on: string;
  tier: string;
  created_at: string;
}

interface DependencyJoinedRow {
  ticket_id: string;
  depends_on: string;
  tier: string;
  title: string;
  phase: string;
}

interface TicketWorkflowRow {
  id: string;
  workflow_id: string | null;
}

// =============================================================================
// TicketDependencyStore Class
// =============================================================================

export class TicketDependencyStore {
  constructor(private db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // Create Dependency
  // ---------------------------------------------------------------------------

  /**
   * Create a dependency: ticketId depends on dependsOn.
   *
   * Uses BEGIN IMMEDIATE for concurrent safety. Validates:
   * 1. Both tickets exist
   * 2. Both have non-null workflow_id
   * 3. Both share the same workflow_id
   * 4. No cycle would be created (BFS from dependsOn following depends_on edges)
   */
  createDependency(
    ticketId: string,
    dependsOn: string,
    tier: DependencyTier
  ): TicketDependency {
    this.db.prepare("BEGIN IMMEDIATE").run();
    try {
      // 1. Validate both tickets exist and get their workflow_ids
      const ticket = this.db
        .prepare("SELECT id, workflow_id FROM tickets WHERE id = ?")
        .get(ticketId) as TicketWorkflowRow | undefined;

      if (!ticket) {
        throw new Error(`Ticket '${ticketId}' not found`);
      }

      const dependsOnTicket = this.db
        .prepare("SELECT id, workflow_id FROM tickets WHERE id = ?")
        .get(dependsOn) as TicketWorkflowRow | undefined;

      if (!dependsOnTicket) {
        throw new Error(`Ticket '${dependsOn}' not found`);
      }

      // 2. Both must have non-null workflow_id
      if (!ticket.workflow_id) {
        throw new Error(
          `Ticket '${ticketId}' has no workflow_id assigned`
        );
      }
      if (!dependsOnTicket.workflow_id) {
        throw new Error(
          `Ticket '${dependsOn}' has no workflow_id assigned`
        );
      }

      // 3. Same workflow
      if (ticket.workflow_id !== dependsOnTicket.workflow_id) {
        throw new Error(
          `Tickets must belong to the same workflow. '${ticketId}' is in workflow '${ticket.workflow_id}', '${dependsOn}' is in workflow '${dependsOnTicket.workflow_id}'`
        );
      }

      // 4. Cycle detection via BFS from dependsOn following depends_on edges
      // If ticketId is reachable from dependsOn, adding this edge would create a cycle
      this.detectCycle(ticketId, dependsOn);

      // 5. Insert
      const id = randomUUID();
      const createdAt = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO ticket_dependencies (id, ticket_id, depends_on, tier, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, ticketId, dependsOn, tier, createdAt);

      this.db.prepare("COMMIT").run();

      return {
        id,
        ticketId,
        dependsOn,
        tier,
        createdAt,
      };
    } catch (err) {
      // Rollback if still in a transaction
      try {
        this.db.prepare("ROLLBACK").run();
      } catch {
        // Already rolled back or committed
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Delete Dependency
  // ---------------------------------------------------------------------------

  /**
   * Delete a dependency: ticketId no longer depends on dependsOnId.
   * Returns true if a row was deleted, false if no matching row existed.
   */
  deleteDependency(ticketId: string, dependsOnId: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM ticket_dependencies WHERE ticket_id = ? AND depends_on = ?"
      )
      .run(ticketId, dependsOnId);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Get Dependencies For Ticket
  // ---------------------------------------------------------------------------

  /**
   * Get all tickets that `ticketId` depends on, joined with ticket title and phase.
   */
  getDependenciesForTicket(ticketId: string): BlockedByEntry[] {
    const rows = this.db
      .prepare(
        `SELECT td.ticket_id, td.depends_on, td.tier, t.title, t.phase
         FROM ticket_dependencies td
         JOIN tickets t ON t.id = td.depends_on
         WHERE td.ticket_id = ?`
      )
      .all(ticketId) as DependencyJoinedRow[];

    return rows.map((row) => ({
      ticketId: row.depends_on,
      title: row.title,
      currentPhase: row.phase,
      tier: row.tier as DependencyTier,
      satisfied: false, // Evaluation handled by iqk.10
    }));
  }

  // ---------------------------------------------------------------------------
  // Get Dependents Of Ticket
  // ---------------------------------------------------------------------------

  /**
   * Get all tickets that depend on `ticketId`, joined with ticket title and phase.
   */
  getDependentsOfTicket(ticketId: string): BlockedByEntry[] {
    const rows = this.db
      .prepare(
        `SELECT td.ticket_id, td.depends_on, td.tier, t.title, t.phase
         FROM ticket_dependencies td
         JOIN tickets t ON t.id = td.ticket_id
         WHERE td.depends_on = ?`
      )
      .all(ticketId) as DependencyJoinedRow[];

    return rows.map((row) => ({
      ticketId: row.ticket_id,
      title: row.title,
      currentPhase: row.phase,
      tier: row.tier as DependencyTier,
      satisfied: false, // Evaluation handled by iqk.10
    }));
  }

  // ---------------------------------------------------------------------------
  // Satisfaction Evaluation
  // ---------------------------------------------------------------------------

  /**
   * Check if a dependency is satisfied based on the dependent ticket's current
   * phase, the required tier, and the template phase ordering.
   *
   * For a given tier, finds the first phase in `templatePhases` with a matching
   * `unblocksTier`, then checks if the dependent ticket's phase index is >= that
   * phase's index.
   *
   * Fallback: if no phase has the tier marker and tier is `artifact-ready`,
   * returns `true` (permissive) with a warning log. `code-ready` always has
   * Done (synthetic), so a missing marker should not occur.
   */
  isSatisfied(
    depTicketPhase: string,
    tier: DependencyTier,
    templatePhases: TemplatePhase[]
  ): boolean {
    const tierPhaseIndex = templatePhases.findIndex(
      (p) => p.unblocksTier === tier
    );

    if (tierPhaseIndex === -1) {
      if (tier === "artifact-ready") {
        console.warn(
          `[ticket-dependency] No phase with unblocksTier="${tier}" found in template; defaulting to satisfied (permissive fallback)`
        );
        return true;
      }
      // code-ready should always have Done phase with the marker
      return false;
    }

    const depPhaseIndex = templatePhases.findIndex(
      (p) => p.id === depTicketPhase
    );

    // If the dependent ticket's phase is not found in the template, not satisfied
    if (depPhaseIndex === -1) {
      return false;
    }

    return depPhaseIndex >= tierPhaseIndex;
  }

  /**
   * Get all dependencies for a ticket with satisfaction evaluation.
   * Calls getDependenciesForTicket, maps each through isSatisfied.
   */
  getDependenciesWithSatisfaction(
    ticketId: string,
    templatePhases: TemplatePhase[]
  ): BlockedByEntry[] {
    const deps = this.getDependenciesForTicket(ticketId);
    return deps.map((dep) => ({
      ...dep,
      satisfied: this.isSatisfied(dep.currentPhase, dep.tier, templatePhases),
    }));
  }

  // ---------------------------------------------------------------------------
  // Cycle Detection (BFS)
  // ---------------------------------------------------------------------------

  /**
   * BFS from `dependsOn` following existing depends_on edges.
   * If `ticketId` is reachable, adding ticketId -> dependsOn would create a cycle.
   */
  private detectCycle(ticketId: string, dependsOn: string): void {
    const visited = new Set<string>();
    const queue: string[] = [dependsOn];

    const stmt = this.db.prepare(
      "SELECT depends_on FROM ticket_dependencies WHERE ticket_id = ?"
    );

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === ticketId) {
        throw new Error(
          `Adding dependency would create a cycle: '${ticketId}' -> '${dependsOn}' creates a circular dependency`
        );
      }
      if (visited.has(current)) continue;
      visited.add(current);

      const rows = stmt.all(current) as { depends_on: string }[];
      for (const row of rows) {
        if (!visited.has(row.depends_on)) {
          queue.push(row.depends_on);
        }
      }
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createTicketDependencyStore(
  db: Database.Database
): TicketDependencyStore {
  return new TicketDependencyStore(db);
}

// =============================================================================
// Singleton Convenience
// =============================================================================

export function ticketDependencyCreate(
  ticketId: string,
  dependsOn: string,
  tier: DependencyTier
): TicketDependency {
  return new TicketDependencyStore(getDatabase()).createDependency(
    ticketId,
    dependsOn,
    tier
  );
}

export function ticketDependencyDelete(
  ticketId: string,
  dependsOnId: string
): boolean {
  return new TicketDependencyStore(getDatabase()).deleteDependency(
    ticketId,
    dependsOnId
  );
}

export function ticketDependencyGetForTicket(
  ticketId: string
): BlockedByEntry[] {
  return new TicketDependencyStore(getDatabase()).getDependenciesForTicket(
    ticketId
  );
}

export function ticketDependencyGetDependents(
  ticketId: string
): BlockedByEntry[] {
  return new TicketDependencyStore(getDatabase()).getDependentsOfTicket(
    ticketId
  );
}

export function ticketDependencyGetWithSatisfaction(
  ticketId: string,
  templatePhases: TemplatePhase[]
): BlockedByEntry[] {
  return new TicketDependencyStore(getDatabase()).getDependenciesWithSatisfaction(
    ticketId,
    templatePhases
  );
}
