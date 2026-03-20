import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RalphLoopState } from "../../../types/orchestration.types.js";
import type { AgentWorker, RalphLoopWorker } from "../../../types/template.types.js";
import {
  captureDoerSessionIdIfNeeded,
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
