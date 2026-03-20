import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RalphLoopState } from "../../../types/orchestration.types.js";
import type { AgentWorker, RalphLoopWorker } from "../../../types/template.types.js";
import {
  captureDoerSessionIdIfNeeded,
  handleAgentCompletion,
  getCurrentWorkerIndex,
} from "../loops/ralph-loop.js";

describe("captureDoerSessionIdIfNeeded", () => {
  it("sets lastDoerClaudeSessionId when agent has resumeOnRalphRetry", () => {
    const ralphState: RalphLoopState = {
      id: "test-ralph",
      type: "ralphLoop",
      iteration: 1,
      workerIndex: 0,
      activeWorker: null,
    };
    const agentWorker: AgentWorker = {
      id: "builder-agent",
      type: "agent",
      source: "agents/builder.md",
      resumeOnRalphRetry: true,
    };
    captureDoerSessionIdIfNeeded(ralphState, agentWorker, "claude-session-abc123");
    assert.equal(ralphState.lastDoerClaudeSessionId, "claude-session-abc123");
  });

  it("does nothing when agent lacks resumeOnRalphRetry", () => {
    const ralphState: RalphLoopState = {
      id: "test-ralph",
      type: "ralphLoop",
      iteration: 1,
      workerIndex: 0,
      activeWorker: null,
    };
    const agentWorker: AgentWorker = {
      id: "verify-spec-agent",
      type: "agent",
      source: "agents/verify-spec.md",
    };
    captureDoerSessionIdIfNeeded(ralphState, agentWorker, "claude-session-xyz");
    assert.equal(ralphState.lastDoerClaudeSessionId, undefined);
  });

  it("overwrites existing lastDoerClaudeSessionId on subsequent iterations", () => {
    const ralphState: RalphLoopState = {
      id: "test-ralph",
      type: "ralphLoop",
      iteration: 2,
      workerIndex: 0,
      activeWorker: null,
      lastDoerClaudeSessionId: "claude-session-old",
    };
    const agentWorker: AgentWorker = {
      id: "builder-agent",
      type: "agent",
      source: "agents/builder.md",
      resumeOnRalphRetry: true,
    };
    captureDoerSessionIdIfNeeded(ralphState, agentWorker, "claude-session-new");
    assert.equal(ralphState.lastDoerClaudeSessionId, "claude-session-new");
  });
});

describe("getCurrentWorkerIndex", () => {
  const worker: RalphLoopWorker = {
    id: "qa-loop",
    type: "ralphLoop",
    maxAttempts: 3,
    workers: [
      {
        id: "qa-fixer-agent",
        type: "agent",
        source: "agents/qa-fixer.md",
        skipOnFirstIteration: true,
      },
      {
        id: "qa-agent",
        type: "agent",
        source: "agents/qa.md",
      },
    ],
  };

  it("skips the flagged agent on iteration 1", () => {
    const ralphState: RalphLoopState = {
      id: "qa-loop",
      type: "ralphLoop",
      iteration: 1,
      workerIndex: 0,
      activeWorker: null,
    };

    assert.equal(getCurrentWorkerIndex(worker, ralphState), 1);
  });

  it("does not skip the flagged agent after recovery into iteration 2", () => {
    const ralphState: RalphLoopState = {
      id: "qa-loop",
      type: "ralphLoop",
      iteration: 2,
      workerIndex: 0,
      activeWorker: null,
    };

    assert.equal(getCurrentWorkerIndex(worker, ralphState), 0);
  });
});

describe("handleAgentCompletion", () => {
  const multiReviewerLoop: RalphLoopWorker = {
    id: "qa-loop",
    type: "ralphLoop",
    maxAttempts: 3,
    workers: [
      {
        id: "verify-spec",
        type: "agent",
        source: "agents/verify-spec.md",
      },
      {
        id: "verify-quality",
        type: "agent",
        source: "agents/verify-quality.md",
      },
    ],
  };

  it("restarts the iteration when an earlier reviewer rejected even if the final reviewer approved", () => {
    const afterFirstReviewer = handleAgentCompletion(
      multiReviewerLoop,
      {
        id: "qa-loop",
        type: "ralphLoop",
        iteration: 1,
        workerIndex: 0,
        activeWorker: null,
      },
      0,
      { approved: false, feedback: "spec failed" },
    );

    assert.deepStrictEqual(afterFirstReviewer.result, {
      status: "continue",
      nextWorkerIndex: 1,
    });
    assert.equal(afterFirstReviewer.nextState.workerIndex, 1);
    assert.equal(afterFirstReviewer.nextState.iterationRejected, true);

    const afterFinalReviewer = handleAgentCompletion(
      multiReviewerLoop,
      afterFirstReviewer.nextState,
      0,
      { approved: true, feedback: "quality passed" },
    );

    assert.deepStrictEqual(afterFinalReviewer.result, {
      status: "continue",
      nextWorkerIndex: 0,
      nextIteration: 2,
    });
    assert.equal(afterFinalReviewer.nextState.iteration, 2);
    assert.equal(afterFinalReviewer.nextState.workerIndex, 0);
    assert.equal(afterFinalReviewer.nextState.iterationRejected, false);
  });

  it("still approves a single-reviewer loop on approval", () => {
    const singleReviewerLoop: RalphLoopWorker = {
      id: "single-review",
      type: "ralphLoop",
      maxAttempts: 2,
      workers: [
        {
          id: "reviewer",
          type: "agent",
          source: "agents/reviewer.md",
        },
      ],
    };

    const result = handleAgentCompletion(
      singleReviewerLoop,
      {
        id: "single-review",
        type: "ralphLoop",
        iteration: 1,
        workerIndex: 0,
        activeWorker: null,
      },
      0,
      { approved: true, feedback: "looks good" },
    );

    assert.deepStrictEqual(result.result, { status: "approved" });
  });
});
