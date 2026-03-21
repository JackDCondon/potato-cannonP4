/**
 * Tests for pm-alerts.ts — detectAlerts()
 *
 * Covers:
 * - Stuck ticket detection
 * - Ralph failure detection
 * - Session crash detection
 * - Dependency unblock detection
 * - Cooldown filtering (alert flags off)
 * - Empty ticket list short-circuit
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import type { PmConfig } from "@potato-cannon/shared";
import { DEFAULT_PM_CONFIG } from "@potato-cannon/shared";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

let mockTickets: Array<{
  id: string;
  phase: string;
  archived: boolean;
}> = [];

let mockActiveSession: { id: string } | null = null;

// db.prepare().get() — returns ticket_history row for stuck check
let mockHistoryRow: { entered_at: string } | undefined = undefined;

// db.prepare().get() — returns most-recent ended session row (for grace-period check)
let mockRecentSessionRow: { ended_at: string } | undefined = undefined;

// db.prepare().all() — for ralph_feedback, sessions, ticket_dependencies
let mockQueryResults: unknown[] = [];

// Track which SQL queries were executed (substring match)
const executedQueries: string[] = [];

function makeMockDb() {
  return {
    prepare: (sql: string) => {
      executedQueries.push(sql);
      return {
        get: (_ticketId: unknown) => {
          // ticket_history query
          if (sql.includes("ticket_history")) return mockHistoryRow;
          // recent-session grace-period query (c2w.2)
          if (sql.includes("ended_at IS NOT NULL")) return mockRecentSessionRow;
          return undefined;
        },
        all: (..._args: unknown[]) => {
          return mockQueryResults;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Module mocks (must happen before importing the module under test)
// ---------------------------------------------------------------------------

await mock.module("../../../stores/db.js", {
  namedExports: {
    getDatabase: () => makeMockDb(),
  },
});

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicketsByBrainstormId: (_epicId: string) => mockTickets,
  },
});

await mock.module("../../../stores/session.store.js", {
  namedExports: {
    getActiveSessionForTicket: (_ticketId: string) => mockActiveSession,
  },
});

const { detectAlerts } = await import("../pm-alerts.js");

// ---------------------------------------------------------------------------
// Helper: build a full PmConfig with all alerts enabled
// ---------------------------------------------------------------------------

function fullConfig(overrides: Partial<PmConfig> = {}): PmConfig {
  return {
    ...DEFAULT_PM_CONFIG,
    mode: "watching",
    ...overrides,
    polling: { ...DEFAULT_PM_CONFIG.polling, ...overrides.polling },
    alerts: { ...DEFAULT_PM_CONFIG.alerts, ...overrides.alerts },
  };
}

const PROJECT_ID = "proj_test";
const EPIC_ID = "brain_epic_1";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectAlerts", () => {
  beforeEach(() => {
    mockTickets = [];
    mockActiveSession = null;
    mockHistoryRow = undefined;
    mockRecentSessionRow = undefined;
    mockQueryResults = [];
    executedQueries.length = 0;
  });

  // -------------------------------------------------------------------------
  // Short-circuit
  // -------------------------------------------------------------------------

  describe("empty ticket list", () => {
    it("returns no alerts when no tickets are linked to the epic", () => {
      mockTickets = [];
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.deepStrictEqual(alerts, []);
    });
  });

  // -------------------------------------------------------------------------
  // Stuck ticket detection
  // -------------------------------------------------------------------------

  describe("stuck ticket detection", () => {
    it("fires stuck_ticket alert when ticket is idle beyond threshold", () => {
      const ticket = { id: "TKT-1", phase: "Build", archived: false };
      mockTickets = [ticket];
      mockActiveSession = null; // no active session

      // Set entered_at to 2 hours ago (well beyond 30-minute default threshold)
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());

      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "stuck_ticket");
      assert.strictEqual(alerts[0].ticketId, "TKT-1");
      assert.strictEqual(alerts[0].projectId, PROJECT_ID);
      assert.ok(alerts[0].alertKey.startsWith("stuck_ticket:TKT-1"));
      assert.ok(alerts[0].message.includes("TKT-1"));
    });

    it("skips ticket if it has an active session", () => {
      mockTickets = [{ id: "TKT-2", phase: "Build", archived: false }];
      mockActiveSession = { id: "sess_active" };

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.strictEqual(alerts.length, 0);
    });

    it("skips terminal phases (Done, Blocked) — they require no PM action", () => {
      mockTickets = [
        { id: "TKT-D", phase: "Done", archived: false },
        { id: "TKT-B", phase: "Blocked", archived: false },
      ];
      mockActiveSession = null;

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.strictEqual(alerts.length, 0);
    });

    // c2w.6: Ideas phase must be included in the stuck-ticket scan
    it("fires stuck_ticket alert for a ticket in Ideas phase (c2w.6)", () => {
      mockTickets = [{ id: "TKT-I", phase: "Ideas", archived: false }];
      mockActiveSession = null;

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "stuck_ticket");
      assert.strictEqual(alerts[0].ticketId, "TKT-I");
    });

    // c2w.2: Ticket with a recently-completed session should not be flagged
    it("skips ticket whose last session completed within grace period (c2w.2)", () => {
      mockTickets = [{ id: "TKT-R", phase: "Build", archived: false }];
      mockActiveSession = null;

      // Ticket has been in phase for 2 hours (would normally be flagged)
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      // But the last session ended only 2 minutes ago — still in grace period
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      mockRecentSessionRow = { ended_at: twoMinutesAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.strictEqual(alerts.length, 0);
    });

    it("fires stuck_ticket when last session ended well outside grace period", () => {
      mockTickets = [{ id: "TKT-S", phase: "Build", archived: false }];
      mockActiveSession = null;

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      // Last session ended 30 minutes ago — outside the 5-minute grace period
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      mockRecentSessionRow = { ended_at: thirtyMinsAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, "stuck_ticket");
      assert.strictEqual(alerts[0].ticketId, "TKT-S");
    });

    // c2w.8: Stuck alerts sorted by phase priority — later phases first
    it("returns stuck alerts sorted by phase priority descending (c2w.8)", () => {
      mockTickets = [
        { id: "TKT-IDEAS", phase: "Ideas", archived: false },
        { id: "TKT-BUILD", phase: "Build", archived: false },
        { id: "TKT-REFINE", phase: "Refinement", archived: false },
      ];
      mockActiveSession = null;
      mockRecentSessionRow = undefined;

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      const stuckAlerts = alerts.filter((a) => a.kind === "stuck_ticket");

      assert.strictEqual(stuckAlerts.length, 3);
      // Build (priority 8) > Refinement (priority 2) > Ideas (priority 1)
      assert.strictEqual(stuckAlerts[0].ticketId, "TKT-BUILD");
      assert.strictEqual(stuckAlerts[1].ticketId, "TKT-REFINE");
      assert.strictEqual(stuckAlerts[2].ticketId, "TKT-IDEAS");
    });

    it("skips archived tickets", () => {
      mockTickets = [{ id: "TKT-A", phase: "Build", archived: true }];
      mockActiveSession = null;

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.strictEqual(alerts.length, 0);
    });

    it("skips ticket without history row", () => {
      mockTickets = [{ id: "TKT-NH", phase: "Build", archived: false }];
      mockActiveSession = null;
      mockHistoryRow = undefined; // no history row

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.strictEqual(alerts.length, 0);
    });

    it("does not fire when ticket entered phase recently (within threshold)", () => {
      mockTickets = [{ id: "TKT-R", phase: "Build", archived: false }];
      mockActiveSession = null;

      // 5 minutes ago — well within the 30-minute default threshold
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: fiveMinutesAgo };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      assert.strictEqual(alerts.length, 0);
    });

    it("does not fire when stuckTickets alert flag is disabled", () => {
      mockTickets = [{ id: "TKT-1", phase: "Build", archived: false }];
      mockActiveSession = null;

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };

      const config = fullConfig({ alerts: { stuckTickets: false, ralphFailures: false, dependencyUnblocks: false, sessionCrashes: false } });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);
      assert.strictEqual(alerts.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Ralph failure detection
  // -------------------------------------------------------------------------

  describe("ralph failure detection", () => {
    it("fires ralph_failure alert for max_attempts rows", () => {
      mockTickets = [{ id: "TKT-1", phase: "Review", archived: false }];

      // Stub the .all() call (used by ralph_feedback query)
      mockQueryResults = [
        { ticket_id: "TKT-1", phase_id: "review", ralph_loop_id: "loop_1" },
      ];

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());

      const ralphAlerts = alerts.filter((a) => a.kind === "ralph_failure");
      assert.strictEqual(ralphAlerts.length, 1);
      assert.strictEqual(ralphAlerts[0].ticketId, "TKT-1");
      assert.ok(ralphAlerts[0].alertKey.includes("ralph_failure:TKT-1"));
      assert.ok(ralphAlerts[0].message.includes("max attempts"));
    });

    it("does not fire when ralphFailures flag is disabled", () => {
      mockTickets = [{ id: "TKT-1", phase: "Review", archived: false }];
      mockQueryResults = [
        { ticket_id: "TKT-1", phase_id: "review", ralph_loop_id: "loop_1" },
      ];

      const config = fullConfig({ alerts: { stuckTickets: false, ralphFailures: false, dependencyUnblocks: false, sessionCrashes: false } });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);
      const ralphAlerts = alerts.filter((a) => a.kind === "ralph_failure");
      assert.strictEqual(ralphAlerts.length, 0);
    });

    it("fires multiple alerts for multiple max_attempts rows", () => {
      mockTickets = [
        { id: "TKT-1", phase: "Review", archived: false },
        { id: "TKT-2", phase: "Review", archived: false },
      ];
      mockQueryResults = [
        { ticket_id: "TKT-1", phase_id: "review", ralph_loop_id: "loop_a" },
        { ticket_id: "TKT-2", phase_id: "review", ralph_loop_id: "loop_b" },
      ];

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      const ralphAlerts = alerts.filter((a) => a.kind === "ralph_failure");
      assert.strictEqual(ralphAlerts.length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Session crash detection
  // -------------------------------------------------------------------------

  describe("session crash detection", () => {
    it("fires session_crash alert for non-zero exit code sessions", () => {
      mockTickets = [{ id: "TKT-1", phase: "Build", archived: false }];
      mockQueryResults = [
        {
          id: "sess_crashed",
          ticket_id: "TKT-1",
          exit_code: 1,
          ended_at: new Date().toISOString(),
        },
      ];

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, fullConfig());
      const crashAlerts = alerts.filter((a) => a.kind === "session_crash");
      assert.strictEqual(crashAlerts.length, 1);
      assert.strictEqual(crashAlerts[0].ticketId, "TKT-1");
      assert.ok(crashAlerts[0].alertKey.startsWith("session_crash:sess_crashed"));
      assert.ok(crashAlerts[0].message.includes("exit code"));
    });

    it("does not fire when sessionCrashes flag is disabled", () => {
      mockTickets = [{ id: "TKT-1", phase: "Build", archived: false }];
      mockQueryResults = [
        { id: "sess_crashed", ticket_id: "TKT-1", exit_code: 1, ended_at: new Date().toISOString() },
      ];

      const config = fullConfig({ alerts: { stuckTickets: false, ralphFailures: false, dependencyUnblocks: false, sessionCrashes: false } });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);
      const crashAlerts = alerts.filter((a) => a.kind === "session_crash");
      assert.strictEqual(crashAlerts.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Dependency unblock detection
  // -------------------------------------------------------------------------

  describe("dependency unblock detection", () => {
    it("fires dependency_unblock when blocked ticket has all deps Done (watching mode)", () => {
      mockTickets = [{ id: "TKT-B", phase: "Blocked", archived: false }];
      // All dependencies are Done
      mockQueryResults = [
        { depends_on: "TKT-0", phase: "Done" },
      ];

      const config = fullConfig({ mode: "watching" });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);

      const unblockAlerts = alerts.filter((a) => a.kind === "dependency_unblock");
      assert.strictEqual(unblockAlerts.length, 1);
      assert.strictEqual(unblockAlerts[0].ticketId, "TKT-B");
      assert.ok(unblockAlerts[0].alertKey.startsWith("dependency_unblock:TKT-B"));
    });

    it("fires dependency_unblock in executing mode too", () => {
      mockTickets = [{ id: "TKT-B", phase: "Blocked", archived: false }];
      mockQueryResults = [{ depends_on: "TKT-0", phase: "Done" }];

      const config = fullConfig({ mode: "executing" });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);

      const unblockAlerts = alerts.filter((a) => a.kind === "dependency_unblock");
      assert.strictEqual(unblockAlerts.length, 1);
    });

    it("does NOT fire dependency_unblock in passive mode", () => {
      mockTickets = [{ id: "TKT-B", phase: "Blocked", archived: false }];
      mockQueryResults = [{ depends_on: "TKT-0", phase: "Done" }];

      const config = fullConfig({ mode: "passive" });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);

      const unblockAlerts = alerts.filter((a) => a.kind === "dependency_unblock");
      assert.strictEqual(unblockAlerts.length, 0);
    });

    it("does not fire when some dependencies are not Done", () => {
      mockTickets = [{ id: "TKT-B", phase: "Blocked", archived: false }];
      mockQueryResults = [
        { depends_on: "TKT-0", phase: "Done" },
        { depends_on: "TKT-1", phase: "Build" }, // still in progress
      ];

      const config = fullConfig({ mode: "watching" });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);

      const unblockAlerts = alerts.filter((a) => a.kind === "dependency_unblock");
      assert.strictEqual(unblockAlerts.length, 0);
    });

    it("does not fire when blocked ticket has no dependencies", () => {
      mockTickets = [{ id: "TKT-B", phase: "Blocked", archived: false }];
      mockQueryResults = []; // no deps

      const config = fullConfig({ mode: "watching" });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);

      const unblockAlerts = alerts.filter((a) => a.kind === "dependency_unblock");
      assert.strictEqual(unblockAlerts.length, 0);
    });

    it("skips archived blocked tickets", () => {
      mockTickets = [{ id: "TKT-B", phase: "Blocked", archived: true }];
      mockQueryResults = [{ depends_on: "TKT-0", phase: "Done" }];

      const config = fullConfig({ mode: "watching" });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);

      const unblockAlerts = alerts.filter((a) => a.kind === "dependency_unblock");
      assert.strictEqual(unblockAlerts.length, 0);
    });

    it("does not fire when dependencyUnblocks flag is disabled", () => {
      mockTickets = [{ id: "TKT-B", phase: "Blocked", archived: false }];
      mockQueryResults = [{ depends_on: "TKT-0", phase: "Done" }];

      const config = fullConfig({
        mode: "watching",
        alerts: { stuckTickets: true, ralphFailures: true, dependencyUnblocks: false, sessionCrashes: true },
      });
      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);

      const unblockAlerts = alerts.filter((a) => a.kind === "dependency_unblock");
      assert.strictEqual(unblockAlerts.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Combined: all alerts disabled
  // -------------------------------------------------------------------------

  describe("all alert flags disabled", () => {
    it("returns no alerts when all flags are false", () => {
      mockTickets = [{ id: "TKT-1", phase: "Build", archived: false }];
      mockActiveSession = null;

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      mockHistoryRow = { entered_at: twoHoursAgo };
      mockQueryResults = [
        { ticket_id: "TKT-1", phase_id: "review", ralph_loop_id: "loop_1" },
      ];

      const config: PmConfig = {
        mode: "watching",
        polling: DEFAULT_PM_CONFIG.polling,
        alerts: {
          stuckTickets: false,
          ralphFailures: false,
          dependencyUnblocks: false,
          sessionCrashes: false,
        },
      };

      const alerts = detectAlerts(EPIC_ID, PROJECT_ID, config);
      assert.deepStrictEqual(alerts, []);
    });
  });
});
