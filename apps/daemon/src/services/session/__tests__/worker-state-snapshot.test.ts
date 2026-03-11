import { describe, it, mock } from "node:test";
import assert from "node:assert";

let storedState: unknown = null;

await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getWorkerState: () => storedState,
    setWorkerState: (_ticketId: string, state: unknown) => {
      storedState = state;
    },
    clearWorkerState: () => {
      storedState = null;
    },
    getTicket: () => ({
      executionGeneration: 9,
    }),
  },
});

await mock.module("../../../stores/task.store.js", {
  namedExports: {
    listTasks: () => [],
  },
});

const {
  createSpawnPendingWorkerState,
  consumeSpawnPendingContinuitySnapshot,
} = await import("../worker-state.js");

describe("consumeSpawnPendingContinuitySnapshot", () => {
  it("consumes snapshot exactly once and clears persisted snapshot fields", () => {
    storedState = createSpawnPendingWorkerState("Build", 9, {
      scope: "safe_user_context_only",
      reasonForRestart: "restart",
      conversationTurns: [{ role: "user", text: "carry this" }],
      sessionHighlights: [],
      unresolvedQuestions: [],
    });

    const first = consumeSpawnPendingContinuitySnapshot(
      "proj_1",
      "POT-1",
      "Build",
      9,
    );
    const second = consumeSpawnPendingContinuitySnapshot(
      "proj_1",
      "POT-1",
      "Build",
      9,
    );

    assert.ok(first);
    assert.strictEqual(first.scope, "safe_user_context_only");
    assert.strictEqual(second, null);
    assert.equal((storedState as any).continuitySnapshot, undefined);
    assert.equal((storedState as any).continuitySnapshotCreatedAt, undefined);
  });
});

