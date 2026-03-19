/**
 * Tests for pm-transition.ts
 *
 * Covers:
 * - transitionToEpicPm: sets pm_enabled = true via updateBrainstorm, emits event
 * - shouldUsePmSkill: returns true only when status = 'epic' AND pmEnabled = true
 * - Idempotency: calling transitionToEpicPm twice leaves the brainstorm in the
 *   same state (pm_enabled stays true, update is called each time but result is stable)
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import type { Brainstorm } from "@potato-cannon/shared";

// ---------------------------------------------------------------------------
// Module-level mock state (set up before any import of the module under test)
// ---------------------------------------------------------------------------

let updateCallCount = 0;
let lastUpdateArgs: { projectId: string; brainstormId: string; updates: Record<string, unknown> } | null = null;
const emittedEvents: Array<{ event: string; data: unknown }> = [];

const mockBrainstorm: Brainstorm = {
  id: "brain_test_1",
  projectId: "proj_1",
  name: "Test Epic",
  status: "epic",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  pmEnabled: true,
};

await mock.module("../../../stores/brainstorm.store.js", {
  namedExports: {
    updateBrainstorm: async (
      projectId: string,
      brainstormId: string,
      updates: Record<string, unknown>,
    ) => {
      updateCallCount++;
      lastUpdateArgs = { projectId, brainstormId, updates };
      return { ...mockBrainstorm, pmEnabled: true };
    },
  },
});

await mock.module("../../../utils/event-bus.js", {
  namedExports: {
    eventBus: {
      emit: (event: string, data: unknown) => {
        emittedEvents.push({ event, data });
      },
    },
  },
});

const { transitionToEpicPm, shouldUsePmSkill } = await import(
  "../pm-transition.js"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pm-transition", () => {
  beforeEach(() => {
    updateCallCount = 0;
    lastUpdateArgs = null;
    emittedEvents.length = 0;
  });

  // -------------------------------------------------------------------------
  // transitionToEpicPm
  // -------------------------------------------------------------------------

  describe("transitionToEpicPm", () => {
    it("calls updateBrainstorm with pmEnabled: true", async () => {
      await transitionToEpicPm("proj_1", "brain_test_1");

      assert.strictEqual(updateCallCount, 1);
      assert.ok(lastUpdateArgs);
      assert.strictEqual(lastUpdateArgs.projectId, "proj_1");
      assert.strictEqual(lastUpdateArgs.brainstormId, "brain_test_1");
      assert.deepStrictEqual(lastUpdateArgs.updates, { pmEnabled: true });
    });

    it("emits brainstorm:updated event with projectId and brainstorm", async () => {
      await transitionToEpicPm("proj_1", "brain_test_1");

      assert.strictEqual(emittedEvents.length, 1);
      const evt = emittedEvents[0];
      assert.strictEqual(evt.event, "brainstorm:updated");
      const payload = evt.data as { projectId: string; brainstorm: Brainstorm };
      assert.strictEqual(payload.projectId, "proj_1");
      assert.ok(payload.brainstorm);
    });

    it("is idempotent: calling twice produces two updateBrainstorm calls both with pmEnabled: true", async () => {
      await transitionToEpicPm("proj_1", "brain_test_1");
      await transitionToEpicPm("proj_1", "brain_test_1");

      // Both calls should use pmEnabled: true (no harm in calling twice)
      assert.strictEqual(updateCallCount, 2);
      assert.ok(lastUpdateArgs);
      assert.deepStrictEqual(lastUpdateArgs.updates, { pmEnabled: true });
    });

    it("passes through arbitrary projectId and brainstormId", async () => {
      await transitionToEpicPm("other_project", "brain_other");

      assert.ok(lastUpdateArgs);
      assert.strictEqual(lastUpdateArgs.projectId, "other_project");
      assert.strictEqual(lastUpdateArgs.brainstormId, "brain_other");
    });
  });

  // -------------------------------------------------------------------------
  // shouldUsePmSkill
  // -------------------------------------------------------------------------

  describe("shouldUsePmSkill", () => {
    it("returns true when status is 'epic' and pmEnabled is true", () => {
      const brainstorm: Brainstorm = {
        ...mockBrainstorm,
        status: "epic",
        pmEnabled: true,
      };
      assert.strictEqual(shouldUsePmSkill(brainstorm), true);
    });

    it("returns false when status is 'active' even with pmEnabled true", () => {
      const brainstorm: Brainstorm = {
        ...mockBrainstorm,
        status: "active",
        pmEnabled: true,
      };
      assert.strictEqual(shouldUsePmSkill(brainstorm), false);
    });

    it("returns false when status is 'completed' even with pmEnabled true", () => {
      const brainstorm: Brainstorm = {
        ...mockBrainstorm,
        status: "completed",
        pmEnabled: true,
      };
      assert.strictEqual(shouldUsePmSkill(brainstorm), false);
    });

    it("returns false when status is 'epic' but pmEnabled is false", () => {
      const brainstorm: Brainstorm = {
        ...mockBrainstorm,
        status: "epic",
        pmEnabled: false,
      };
      assert.strictEqual(shouldUsePmSkill(brainstorm), false);
    });

    it("returns false when status is 'epic' but pmEnabled is undefined", () => {
      const brainstorm: Brainstorm = {
        ...mockBrainstorm,
        status: "epic",
        pmEnabled: undefined,
      };
      assert.strictEqual(shouldUsePmSkill(brainstorm), false);
    });

    it("returns false when both status is non-epic and pmEnabled is false", () => {
      const brainstorm: Brainstorm = {
        ...mockBrainstorm,
        status: "active",
        pmEnabled: false,
      };
      assert.strictEqual(shouldUsePmSkill(brainstorm), false);
    });
  });
});
