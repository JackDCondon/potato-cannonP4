import { describe, it } from "node:test";
import assert from "node:assert";
import type { TicketHistoryEntry } from "@potato-cannon/shared";

// =============================================================================
// Unit tests for stuckSince logic extracted from buildTicketSnapshot
// =============================================================================

/**
 * Mirrors the stuckSince resolution logic from epic.tools.ts:
 * Find the most recent open history entry for the current phase.
 */
function resolveStuckSince(
  history: TicketHistoryEntry[],
  currentPhase: string
): string | null {
  const entry = history
    .slice()
    .reverse()
    .find((h) => h.phase === currentPhase && !h.endedAt);
  return entry?.at ?? null;
}

describe("resolveStuckSince", () => {
  it("returns entered_at when ticket is in phase with no endedAt", () => {
    const history: TicketHistoryEntry[] = [
      { phase: "Ideas", at: "2025-01-01T00:00:00Z", endedAt: "2025-01-02T00:00:00Z" },
      { phase: "Build", at: "2025-01-02T00:00:00Z" },
    ];
    const result = resolveStuckSince(history, "Build");
    assert.strictEqual(result, "2025-01-02T00:00:00Z");
  });

  it("returns null when no open entry exists for phase", () => {
    const history: TicketHistoryEntry[] = [
      { phase: "Ideas", at: "2025-01-01T00:00:00Z", endedAt: "2025-01-02T00:00:00Z" },
      { phase: "Build", at: "2025-01-02T00:00:00Z", endedAt: "2025-01-03T00:00:00Z" },
    ];
    // Ticket is in Build but all entries are closed
    const result = resolveStuckSince(history, "Build");
    assert.strictEqual(result, null);
  });

  it("returns null when history is empty", () => {
    const result = resolveStuckSince([], "Build");
    assert.strictEqual(result, null);
  });

  it("returns null when no history entry matches current phase", () => {
    const history: TicketHistoryEntry[] = [
      { phase: "Ideas", at: "2025-01-01T00:00:00Z" },
    ];
    const result = resolveStuckSince(history, "Build");
    assert.strictEqual(result, null);
  });

  it("returns the most recent open entry when phase appears multiple times", () => {
    // Ticket went back to Ideas (re-work scenario)
    const history: TicketHistoryEntry[] = [
      { phase: "Ideas", at: "2025-01-01T00:00:00Z", endedAt: "2025-01-02T00:00:00Z" },
      { phase: "Build", at: "2025-01-02T00:00:00Z", endedAt: "2025-01-03T00:00:00Z" },
      { phase: "Ideas", at: "2025-01-03T00:00:00Z" }, // back to Ideas, open
    ];
    const result = resolveStuckSince(history, "Ideas");
    assert.strictEqual(result, "2025-01-03T00:00:00Z");
  });
});

// =============================================================================
// Unit tests for summary count logic
// =============================================================================

interface MinimalTicketSnapshot {
  phase: string;
  blockedBy: Array<{ satisfied: boolean }>;
}

function summarize(snapshots: MinimalTicketSnapshot[]): {
  total: number;
  done: number;
  active: number;
  blocked: number;
} {
  const doneCount = snapshots.filter((t) => t.phase === "Done").length;
  const blockedCount = snapshots.filter(
    (t) => t.blockedBy.some((b) => !b.satisfied)
  ).length;
  return {
    total: snapshots.length,
    done: doneCount,
    active: snapshots.length - doneCount,
    blocked: blockedCount,
  };
}

describe("summarize epic tickets", () => {
  it("counts done tickets correctly", () => {
    const snapshots: MinimalTicketSnapshot[] = [
      { phase: "Done", blockedBy: [] },
      { phase: "Done", blockedBy: [] },
      { phase: "Build", blockedBy: [] },
    ];
    const result = summarize(snapshots);
    assert.strictEqual(result.done, 2);
    assert.strictEqual(result.active, 1);
    assert.strictEqual(result.total, 3);
  });

  it("counts blocked tickets as those with unsatisfied dependencies", () => {
    const snapshots: MinimalTicketSnapshot[] = [
      { phase: "Build", blockedBy: [{ satisfied: false }] },
      { phase: "Build", blockedBy: [{ satisfied: true }] },
      { phase: "Ideas", blockedBy: [] },
    ];
    const result = summarize(snapshots);
    assert.strictEqual(result.blocked, 1);
  });

  it("returns zero counts for empty epic", () => {
    const result = summarize([]);
    assert.deepStrictEqual(result, { total: 0, done: 0, active: 0, blocked: 0 });
  });

  it("a ticket with mixed deps is blocked if any is unsatisfied", () => {
    const snapshots: MinimalTicketSnapshot[] = [
      { phase: "Build", blockedBy: [{ satisfied: true }, { satisfied: false }] },
    ];
    const result = summarize(snapshots);
    assert.strictEqual(result.blocked, 1);
  });
});
