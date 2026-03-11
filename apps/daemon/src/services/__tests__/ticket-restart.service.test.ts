import { describe, it, mock } from "node:test";
import assert from "node:assert";

const callOrder: string[] = [];
let capturedLifecycleOptions: Record<string, unknown> | null = null;

const ticketState = {
  id: "POT-1",
  phase: "Build",
  archived: false,
  executionGeneration: 9,
  conversationId: "conv_1",
  workflowId: "wf_1",
};

await mock.module("../../stores/ticket.store.js", {
  namedExports: {
    getTicket: () => ticketState,
    getPhaseHistoryEntries: () => [
      { id: "h1", phase: "Refinement" },
      { id: "h2", phase: "Build" },
    ],
    deleteHistoryEntries: () => {
      callOrder.push("deleteHistory");
      return 1;
    },
    deleteArtifactsForPhases: async () => {
      callOrder.push("deleteArtifacts");
      return 1;
    },
  },
});

await mock.module("../../stores/session.store.js", {
  namedExports: {
    getActiveSessionForTicket: () => ({ id: "sess_active" }),
    deleteSessionsForPhases: () => {
      callOrder.push("deleteSessions");
      return 1;
    },
  },
});

await mock.module("../../stores/task.store.js", {
  namedExports: {
    deleteTasksForPhases: () => {
      callOrder.push("deleteTasks");
      return 1;
    },
  },
});

await mock.module("../../stores/ralph-feedback.store.js", {
  namedExports: {
    deleteRalphFeedbackForPhases: () => {
      callOrder.push("deleteFeedback");
      return 1;
    },
  },
});

await mock.module("../../stores/project.store.js", {
  namedExports: {
    getProjectById: () => ({ id: "proj_1", path: "/tmp/proj" }),
  },
});

await mock.module("../session/phase-config.js", {
  namedExports: {
    getPhaseConfig: async () => ({ workers: [] }),
  },
});

await mock.module("../session/vcs/factory.js", {
  namedExports: {
    createVCSProvider: () => ({
      resetWorkspace: async () => ({
        errors: [],
        newBranchName: "potato-resets/POT-1-123",
      }),
    }),
  },
});

const { restartToPhase } = await import("../ticket-restart.service.js");

describe("restartToPhase continuity snapshot ordering", () => {
  it("builds snapshot and writes lifecycle spawn_pending before destructive cleanup", async () => {
    callOrder.length = 0;
    capturedLifecycleOptions = null;

    const sessionService = {
      isActive: () => true,
      buildRestartSnapshotForLifecycleRestart: async () => {
        callOrder.push("buildSnapshot");
        return {
          scope: "safe_user_context_only",
          reasonForRestart: "test",
          conversationTurns: [],
          sessionHighlights: [],
          unresolvedQuestions: ["q1"],
        };
      },
      invalidateTicketLifecycle: async (
        _projectId: string,
        _ticketId: string,
        options: Record<string, unknown>,
      ) => {
        callOrder.push("invalidateLifecycle");
        capturedLifecycleOptions = options;
        return {
          ticket: {
            ...ticketState,
            phase: "Refinement",
            executionGeneration: 10,
          },
          executionGeneration: 10,
        };
      },
      spawnForTicket: async () => {
        callOrder.push("spawn");
      },
    } as any;

    const result = await restartToPhase(
      "proj_1",
      "POT-1",
      "Refinement",
      sessionService,
    );

    assert.strictEqual(result.success, true);
    assert.ok(capturedLifecycleOptions);
    assert.deepStrictEqual(
      (capturedLifecycleOptions as any).restartSnapshot.scope,
      "safe_user_context_only",
    );

    const snapshotIndex = callOrder.indexOf("buildSnapshot");
    const lifecycleIndex = callOrder.indexOf("invalidateLifecycle");
    const deleteSessionsIndex = callOrder.indexOf("deleteSessions");
    assert.ok(snapshotIndex >= 0);
    assert.ok(lifecycleIndex > snapshotIndex);
    assert.ok(deleteSessionsIndex > lifecycleIndex);
  });
});

