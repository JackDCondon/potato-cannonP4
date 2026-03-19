/**
 * Tests for PmPoller
 *
 * Covers:
 * - start / stop lifecycle
 * - passive mode epics are skipped (no alerts spawned)
 * - alerts trigger session spawns when conditions are met
 * - cooldown prevents repeated spawns for the same alertKey
 * - rate limiting (MAX_SPAWNS_PER_HOUR)
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import type { PmConfig } from "@potato-cannon/shared";
import { DEFAULT_PM_CONFIG } from "@potato-cannon/shared";
import type { Project } from "../../../types/config.types.js";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

/** Active epic rows returned by getActiveEpics (brainstorms WHERE status='epic') */
let mockEpicRows: Array<{ id: string; project_id: string; workflow_id: string | null }> = [];

/** config returned by getBoardPmConfig per workflow_id */
let mockBoardConfig: PmConfig = { ...DEFAULT_PM_CONFIG, mode: "watching" };

/** alerts returned by detectAlerts */
let mockAlerts: Array<{
  kind: string;
  alertKey: string;
  ticketId: string;
  projectId: string;
  message: string;
}> = [];

/** Track spawns */
const spawnForBrainstormCalls: Array<{ projectId: string; epicId: string; path: string; message: string }> = [];
const spawnForTicketCalls: Array<{ projectId: string; ticketId: string; phase: string; path: string }> = [];

/** Ticket returned by getTicket */
let mockTicket: { phase: string } | null = { phase: "Build" };

// ---------------------------------------------------------------------------
// Module mocks (before importing the module under test)
// ---------------------------------------------------------------------------

await mock.module("../../../stores/db.js", {
  namedExports: {
    getDatabase: () => ({
      prepare: (_sql: string) => ({
        all: () => mockEpicRows,
      }),
    }),
  },
});

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicket: (_projectId: string, _ticketId: string) => mockTicket,
  },
});

await mock.module("../../../stores/board-settings.store.js", {
  namedExports: {
    getBoardPmConfig: (_workflowId: string) => mockBoardConfig,
  },
});

await mock.module("../pm-alerts.js", {
  namedExports: {
    detectAlerts: (_epicId: string, _projectId: string, _config: PmConfig) => mockAlerts,
  },
});

const { PmPoller } = await import("../pm-poller.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionService() {
  return {
    spawnForBrainstorm: async (
      projectId: string,
      epicId: string,
      path: string,
      message: string,
    ) => {
      spawnForBrainstormCalls.push({ projectId, epicId, path, message });
    },
    spawnForTicket: async (
      projectId: string,
      ticketId: string,
      phase: string,
      path: string,
    ) => {
      spawnForTicketCalls.push({ projectId, ticketId, phase, path });
    },
  } as any;
}

function makeProjects(entries: Record<string, { path: string }> = {}): () => Map<string, Project> {
  return () => {
    const m = new Map<string, Project>();
    for (const [id, proj] of Object.entries(entries)) {
      m.set(id, { id, slug: id, displayName: id, registeredAt: "", ...proj } as Project);
    }
    return m;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PmPoller", () => {
  beforeEach(() => {
    mockEpicRows = [];
    mockBoardConfig = { ...DEFAULT_PM_CONFIG, mode: "watching" };
    mockAlerts = [];
    mockTicket = { phase: "Build" };
    spawnForBrainstormCalls.length = 0;
    spawnForTicketCalls.length = 0;
  });

  // -------------------------------------------------------------------------
  // Lifecycle: start / stop
  // -------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("start() sets up an interval (intervalId is non-null after start)", () => {
      const poller = new PmPoller(makeSessionService(), makeProjects());

      // Access private field via any cast — tests the public contract indirectly
      poller.start();
      const hasInterval = (poller as any).intervalId !== null;
      assert.strictEqual(hasInterval, true);

      poller.stop();
    });

    it("stop() clears the interval (intervalId is null after stop)", () => {
      const poller = new PmPoller(makeSessionService(), makeProjects());
      poller.start();
      poller.stop();

      const hasInterval = (poller as any).intervalId !== null;
      assert.strictEqual(hasInterval, false);
    });

    it("start() is idempotent — calling twice does not create two intervals", () => {
      const poller = new PmPoller(makeSessionService(), makeProjects());
      poller.start();
      const firstInterval = (poller as any).intervalId;

      poller.start(); // second call — should be a no-op
      const secondInterval = (poller as any).intervalId;

      assert.strictEqual(firstInterval, secondInterval);

      poller.stop();
    });

    it("stop() clears cooldown state", () => {
      const poller = new PmPoller(makeSessionService(), makeProjects());

      // Manually insert a cooldown entry
      (poller as any).cooldowns.set("some_key", Date.now());
      assert.strictEqual((poller as any).cooldowns.size, 1);

      poller.stop();

      assert.strictEqual((poller as any).cooldowns.size, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Tick: passive mode skips
  // -------------------------------------------------------------------------

  describe("passive mode epics are skipped", () => {
    it("does not spawn any session when board config is passive", async () => {
      mockEpicRows = [
        { id: "brain_1", project_id: "proj_1", workflow_id: "wf_1" },
      ];
      mockBoardConfig = { ...DEFAULT_PM_CONFIG, mode: "passive" };
      mockAlerts = [
        {
          kind: "stuck_ticket",
          alertKey: "stuck_ticket:TKT-1",
          ticketId: "TKT-1",
          projectId: "proj_1",
          message: "Ticket TKT-1 is stuck",
        },
      ];

      const poller = new PmPoller(
        makeSessionService(),
        makeProjects({ proj_1: { path: "/repo" } }),
      );

      // Call tick directly (private — cast to any)
      await (poller as any).tick();

      assert.strictEqual(spawnForBrainstormCalls.length, 0);
      assert.strictEqual(spawnForTicketCalls.length, 0);
    });

    it("skips epic when project is not in the projects map", async () => {
      mockEpicRows = [
        { id: "brain_1", project_id: "proj_unknown", workflow_id: "wf_1" },
      ];
      mockBoardConfig = { ...DEFAULT_PM_CONFIG, mode: "watching" };
      mockAlerts = [
        {
          kind: "stuck_ticket",
          alertKey: "stuck_ticket:TKT-1",
          ticketId: "TKT-1",
          projectId: "proj_unknown",
          message: "Ticket TKT-1 is stuck",
        },
      ];

      const poller = new PmPoller(
        makeSessionService(),
        makeProjects({}), // empty — proj_unknown not registered
      );

      await (poller as any).tick();

      assert.strictEqual(spawnForBrainstormCalls.length, 0);
    });

    it("skips epic with null workflow_id (no config resolvable)", async () => {
      mockEpicRows = [
        { id: "brain_1", project_id: "proj_1", workflow_id: null },
      ];
      mockAlerts = [
        {
          kind: "stuck_ticket",
          alertKey: "stuck_ticket:TKT-1",
          ticketId: "TKT-1",
          projectId: "proj_1",
          message: "Ticket TKT-1 is stuck",
        },
      ];

      const poller = new PmPoller(
        makeSessionService(),
        makeProjects({ proj_1: { path: "/repo" } }),
      );

      await (poller as any).tick();

      assert.strictEqual(spawnForBrainstormCalls.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Tick: alerts trigger session spawns
  // -------------------------------------------------------------------------

  describe("alerts trigger sessions", () => {
    it("spawns a brainstorm session for stuck_ticket alert in watching mode", async () => {
      mockEpicRows = [
        { id: "brain_1", project_id: "proj_1", workflow_id: "wf_1" },
      ];
      mockBoardConfig = { ...DEFAULT_PM_CONFIG, mode: "watching" };
      mockAlerts = [
        {
          kind: "stuck_ticket",
          alertKey: "stuck_ticket:TKT-1",
          ticketId: "TKT-1",
          projectId: "proj_1",
          message: "Ticket TKT-1 stuck in Build for 60m",
        },
      ];

      const poller = new PmPoller(
        makeSessionService(),
        makeProjects({ proj_1: { path: "/repo" } }),
      );

      await (poller as any).tick();

      assert.strictEqual(spawnForBrainstormCalls.length, 1);
      assert.strictEqual(spawnForBrainstormCalls[0].projectId, "proj_1");
      assert.strictEqual(spawnForBrainstormCalls[0].epicId, "brain_1");
      assert.ok(spawnForBrainstormCalls[0].message.includes("PM Alert"));
    });

    it("spawns a ticket session for dependency_unblock in executing mode", async () => {
      mockEpicRows = [
        { id: "brain_1", project_id: "proj_1", workflow_id: "wf_1" },
      ];
      mockBoardConfig = { ...DEFAULT_PM_CONFIG, mode: "executing" };
      mockAlerts = [
        {
          kind: "dependency_unblock",
          alertKey: "dependency_unblock:TKT-B",
          ticketId: "TKT-B",
          projectId: "proj_1",
          message: "TKT-B is now unblocked",
        },
      ];
      mockTicket = { phase: "Build" };

      const poller = new PmPoller(
        makeSessionService(),
        makeProjects({ proj_1: { path: "/repo" } }),
      );

      await (poller as any).tick();

      assert.strictEqual(spawnForTicketCalls.length, 1);
      assert.strictEqual(spawnForTicketCalls[0].ticketId, "TKT-B");
      assert.strictEqual(spawnForTicketCalls[0].phase, "Build");
    });

    it("spawns a brainstorm session for dependency_unblock in watching mode (not executing)", async () => {
      mockEpicRows = [
        { id: "brain_1", project_id: "proj_1", workflow_id: "wf_1" },
      ];
      mockBoardConfig = { ...DEFAULT_PM_CONFIG, mode: "watching" };
      mockAlerts = [
        {
          kind: "dependency_unblock",
          alertKey: "dependency_unblock:TKT-B",
          ticketId: "TKT-B",
          projectId: "proj_1",
          message: "TKT-B is now unblocked",
        },
      ];

      const poller = new PmPoller(
        makeSessionService(),
        makeProjects({ proj_1: { path: "/repo" } }),
      );

      await (poller as any).tick();

      // watching mode: notify the PM brainstorm, not execute the ticket
      assert.strictEqual(spawnForBrainstormCalls.length, 1);
      assert.strictEqual(spawnForTicketCalls.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown
  // -------------------------------------------------------------------------

  describe("cooldown filtering", () => {
    it("does not spawn again for the same alertKey within cooldown window", async () => {
      mockEpicRows = [
        { id: "brain_1", project_id: "proj_1", workflow_id: "wf_1" },
      ];
      mockBoardConfig = { ...DEFAULT_PM_CONFIG, mode: "watching" };
      mockAlerts = [
        {
          kind: "stuck_ticket",
          alertKey: "stuck_ticket:TKT-1",
          ticketId: "TKT-1",
          projectId: "proj_1",
          message: "TKT-1 is stuck",
        },
      ];

      const poller = new PmPoller(
        makeSessionService(),
        makeProjects({ proj_1: { path: "/repo" } }),
      );

      // First tick — should spawn
      await (poller as any).tick();
      assert.strictEqual(spawnForBrainstormCalls.length, 1);

      // Second tick — same alertKey, still within cooldown
      await (poller as any).tick();
      assert.strictEqual(spawnForBrainstormCalls.length, 1); // no additional spawns
    });

    it("spawns again after cooldown expires", async () => {
      mockEpicRows = [
        { id: "brain_1", project_id: "proj_1", workflow_id: "wf_1" },
      ];
      mockBoardConfig = {
        ...DEFAULT_PM_CONFIG,
        mode: "watching",
        polling: { ...DEFAULT_PM_CONFIG.polling, alertCooldownMinutes: 15 },
      };
      mockAlerts = [
        {
          kind: "stuck_ticket",
          alertKey: "stuck_ticket:TKT-2",
          ticketId: "TKT-2",
          projectId: "proj_1",
          message: "TKT-2 is stuck",
        },
      ];

      const poller = new PmPoller(
        makeSessionService(),
        makeProjects({ proj_1: { path: "/repo" } }),
      );

      // First tick
      await (poller as any).tick();
      assert.strictEqual(spawnForBrainstormCalls.length, 1);

      // Manually expire the cooldown entry (set to 20 minutes ago)
      const twentyMinsAgo = Date.now() - 20 * 60 * 1000;
      (poller as any).cooldowns.set("stuck_ticket:TKT-2", twentyMinsAgo);

      // Second tick — cooldown has expired, should spawn again
      await (poller as any).tick();
      assert.strictEqual(spawnForBrainstormCalls.length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe("canSpawn rate limiting", () => {
    it("allows spawn when under limit", () => {
      const poller = new PmPoller(makeSessionService(), makeProjects());
      assert.strictEqual((poller as any).canSpawn(), true);
    });

    it("blocks spawn at MAX_SPAWNS_PER_HOUR (10)", () => {
      const poller = new PmPoller(makeSessionService(), makeProjects());

      // Exhaust the spawn limit
      for (let i = 0; i < 10; i++) {
        (poller as any).recordSpawn();
      }

      assert.strictEqual((poller as any).canSpawn(), false);
    });

    it("resets spawn count after 1-hour window slides", () => {
      const poller = new PmPoller(makeSessionService(), makeProjects());

      // Record 10 spawns in the current window
      for (let i = 0; i < 10; i++) {
        (poller as any).recordSpawn();
      }
      assert.strictEqual((poller as any).canSpawn(), false);

      // Slide the window back by 61 minutes
      const sixtyOneMinsAgo = Date.now() - 61 * 60 * 1000;
      (poller as any).spawnWindow = [sixtyOneMinsAgo, 10];

      // Now canSpawn should reset the window and return true
      assert.strictEqual((poller as any).canSpawn(), true);
    });
  });
});
