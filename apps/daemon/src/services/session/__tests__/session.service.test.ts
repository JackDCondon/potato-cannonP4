import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import fs from "fs/promises";
import {
  SessionService,
  TicketLifecycleConflictError,
  StaleTicketInputError,
  resolveWorkerModelForSpawn,
  resolveStoredContinuityContext,
} from "../session.service.js";
import { decideContinuityMode, evaluateResumeEligibility } from "../continuity-policy.js";
import { SESSIONS_DIR } from "../../../config/paths.js";

/**
 * Tests for SessionService.terminateExistingSession
 *
 * Note: We test the internal behavior by directly manipulating the
 * sessions Map and observing the effects. Database operations are
 * tested indirectly through the session lifecycle.
 */
describe("SessionService.terminateExistingSession", () => {
  let service: SessionService;
  let eventEmitter: EventEmitter;

  beforeEach(() => {
    eventEmitter = new EventEmitter();
    service = new SessionService(eventEmitter);
  });

  it("should call stopSession when session is in memory", async () => {
    // Access the private sessions Map
    const sessions = (service as any).sessions as Map<string, any>;

    // Mock process that tracks kill calls
    const killCalls: string[] = [];
    const mockProcess = {
      kill: (signal: string) => killCalls.push(signal),
    };

    // Add a mock session to the sessions map
    const sessionId = "sess_test123";
    sessions.set(sessionId, {
      process: mockProcess,
      meta: { projectId: "test", ticketId: "POT-1" },
      logStream: { end: mock.fn() },
    });

    // Verify the session is in the map
    assert.strictEqual(sessions.has(sessionId), true);

    // Call stopSession directly (public method)
    const result = service.stopSession(sessionId);

    // Verify kill was called with SIGTERM
    assert.strictEqual(result, true);
    assert.deepStrictEqual(killCalls, ["SIGTERM"]);
  });

  it("should return false when stopping non-existent session", () => {
    const result = service.stopSession("sess_nonexistent");
    assert.strictEqual(result, false);
  });

  it("should track sessions in internal map correctly", () => {
    const sessions = (service as any).sessions as Map<string, any>;

    // Initially empty
    assert.strictEqual(sessions.size, 0);

    // Add a session
    sessions.set("sess_1", { process: {}, meta: {}, logStream: {} });
    assert.strictEqual(sessions.size, 1);
    assert.strictEqual(service.isActive("sess_1"), true);
    assert.strictEqual(service.isActive("sess_2"), false);
  });

  it("terminateTicketSession delegates to ticket termination flow", async () => {
    const calls: Array<{ contextType: string; contextId: string }> = [];
    (service as any).terminateExistingSession = async (contextType: string, contextId: string) => {
      calls.push({ contextType, contextId });
    };

    await service.terminateTicketSession("POT-123");
    assert.deepStrictEqual(calls, [{ contextType: "ticket", contextId: "POT-123" }]);
  });
});

describe("SessionService model tier routing integration", () => {
  const baseConfig = {
    daemon: { port: 8443 },
    ai: {
      defaultProvider: "anthropic",
      providers: [
        {
          id: "anthropic",
          models: { low: "haiku", mid: "sonnet", high: "opus" },
        },
        {
          id: "openai",
          models: { low: "gpt-4.1-mini", mid: "gpt-4.1", high: "o3" },
        },
      ],
    },
  };

  it("resolves concrete model from modelTier and project provider override", () => {
    const resolvedModel = resolveWorkerModelForSpawn({
      worker: {
        id: "implementer",
        source: "agents/builder.md",
        modelTier: { simple: "low", standard: "mid", complex: "high" },
      },
      complexity: "complex",
      project: { providerOverride: "openai" },
      config: baseConfig,
    });

    assert.strictEqual(resolvedModel, "o3");
  });

  it("throws before spawn when legacy model field is still present", () => {
    assert.throws(
      () =>
        resolveWorkerModelForSpawn({
          worker: {
            id: "legacy-worker",
            source: "agents/legacy.md",
            model: "opus",
          },
          complexity: "standard",
          project: {},
          config: baseConfig,
        }),
      /deprecated field "model"/,
    );
  });
});

describe("resolveStoredContinuityContext", () => {
  const compatibilityA = {
    ticketId: "POT-1",
    phase: "Build",
    agentSource: "agents/taskmaster.md",
    executionGeneration: 18,
    workflowId: "wf-1",
    worktreePath: "D:/AgentWorkspaces/potato-POT-1",
    branchName: "potato-POT-1",
    agentDefinitionPromptHash: "a".repeat(64),
    mcpServerNames: ["p4", "potato-cannon"],
    model: "opus",
    disallowedTools: ["Skill(superpowers:*)"],
  };
  const compatibilityB = {
    ...compatibilityA,
    phase: "Specification",
    agentSource: "agents/specification.md",
    executionGeneration: 17,
  };

  it("returns null when only stale Claude IDs from other compatibility chains exist", () => {
    const result = resolveStoredContinuityContext([
      {
        claudeSessionId: undefined,
        metadata: { continuityCompatibility: compatibilityA },
      },
      {
        claudeSessionId: "stale-session-id",
        metadata: { continuityCompatibility: compatibilityB },
      },
    ]);

    assert.deepStrictEqual(result, {
      storedCompatibility: compatibilityA,
      claudeSessionId: null,
    });
  });

  it("returns the newest Claude ID that matches the latest compatibility chain", () => {
    const result = resolveStoredContinuityContext([
      {
        claudeSessionId: undefined,
        metadata: { continuityCompatibility: compatibilityA },
      },
      {
        claudeSessionId: "valid-resume-id",
        metadata: { continuityCompatibility: compatibilityA },
      },
      {
        claudeSessionId: "stale-session-id",
        metadata: { continuityCompatibility: compatibilityB },
      },
    ]);

    assert.deepStrictEqual(result, {
      storedCompatibility: compatibilityA,
      claudeSessionId: "valid-resume-id",
    });
  });
});

describe("SessionService.getProcessingByProject", () => {
  it("should return both ticket and brainstorm IDs grouped by project", () => {
    const eventEmitter = new EventEmitter();
    const sessionService = new SessionService(eventEmitter);

    // Mock internal sessions map with both ticket and brainstorm sessions
    const mockSessions = new Map([
      [
        "session-1",
        {
          meta: { projectId: "proj-1", ticketId: "ticket-1", brainstormId: "" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
      [
        "session-2",
        {
          meta: { projectId: "proj-1", ticketId: "", brainstormId: "brainstorm-1" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
      [
        "session-3",
        {
          meta: { projectId: "proj-2", ticketId: "ticket-2", brainstormId: "" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
    ]);

    // @ts-ignore - accessing private property for testing
    sessionService.sessions = mockSessions;

    const result = sessionService.getProcessingByProject();

    assert.deepEqual(result.get("proj-1"), {
      ticketIds: ["ticket-1"],
      brainstormIds: ["brainstorm-1"],
    });
    assert.deepEqual(result.get("proj-2"), {
      ticketIds: ["ticket-2"],
      brainstormIds: [],
    });
  });

  it("should handle multiple tickets and brainstorms in same project", () => {
    const eventEmitter = new EventEmitter();
    const sessionService = new SessionService(eventEmitter);

    const mockSessions = new Map([
      [
        "session-1",
        {
          meta: { projectId: "proj-1", ticketId: "ticket-1", brainstormId: "" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
      [
        "session-2",
        {
          meta: { projectId: "proj-1", ticketId: "ticket-2", brainstormId: "" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
      [
        "session-3",
        {
          meta: { projectId: "proj-1", ticketId: "", brainstormId: "brainstorm-1" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
      [
        "session-4",
        {
          meta: { projectId: "proj-1", ticketId: "", brainstormId: "brainstorm-2" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
    ]);

    // @ts-ignore - accessing private property for testing
    sessionService.sessions = mockSessions;

    const result = sessionService.getProcessingByProject();

    assert.deepEqual(result.get("proj-1"), {
      ticketIds: ["ticket-1", "ticket-2"],
      brainstormIds: ["brainstorm-1", "brainstorm-2"],
    });
  });

  it("should exclude duplicate IDs", () => {
    const eventEmitter = new EventEmitter();
    const sessionService = new SessionService(eventEmitter);

    const mockSessions = new Map([
      [
        "session-1",
        {
          meta: { projectId: "proj-1", ticketId: "ticket-1", brainstormId: "" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
      [
        "session-2",
        {
          meta: { projectId: "proj-1", ticketId: "ticket-1", brainstormId: "" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
    ]);

    // @ts-ignore - accessing private property for testing
    sessionService.sessions = mockSessions;

    const result = sessionService.getProcessingByProject();

    assert.deepEqual(result.get("proj-1"), {
      ticketIds: ["ticket-1"],
      brainstormIds: [],
    });
  });

  it("should return empty map when no sessions", () => {
    const eventEmitter = new EventEmitter();
    const sessionService = new SessionService(eventEmitter);

    const result = sessionService.getProcessingByProject();
    assert.strictEqual(result.size, 0);
  });

  it("should skip sessions with missing projectId", () => {
    const eventEmitter = new EventEmitter();
    const sessionService = new SessionService(eventEmitter);

    const mockSessions = new Map([
      [
        "session-1",
        {
          meta: { projectId: "", ticketId: "ticket-1", brainstormId: "" },
          process: null,
          logStream: null,
          exitPromise: Promise.resolve(),
          exitResolver: () => {},
        },
      ],
    ]);

    // @ts-ignore - accessing private property for testing
    sessionService.sessions = mockSessions;

    const result = sessionService.getProcessingByProject();
    assert.strictEqual(result.size, 0);
  });
});

describe("SessionService.startRemoteControl", () => {
  let service: SessionService;
  let eventEmitter: EventEmitter;

  beforeEach(() => {
    eventEmitter = new EventEmitter();
    service = new SessionService(eventEmitter);
  });

  it("returns null for getRemoteControlState when no RC has been started", () => {
    const result = service.getRemoteControlState("sess_nonexistent");
    assert.strictEqual(result, null);
  });

  it("returns false when starting RC for a non-existent session", () => {
    const result = service.startRemoteControl("sess_nonexistent", "My Ticket");
    assert.strictEqual(result, false);
  });

  it("sets pending state and returns true when session exists", () => {
    const sessions = (service as any).sessions as Map<string, any>;
    const writtenData: string[] = [];
    const mockProcess = {
      kill: () => {},
      write: (data: string) => writtenData.push(data),
    };

    const sessionId = "sess_rc_test";
    sessions.set(sessionId, {
      process: mockProcess,
      meta: { projectId: "proj-1", ticketId: "ticket-1" },
      logStream: { end: () => {} },
      exitPromise: Promise.resolve(),
      exitResolver: () => {},
    });

    const result = service.startRemoteControl(sessionId, "My Ticket Title");

    assert.strictEqual(result, true);
    const state = service.getRemoteControlState(sessionId);
    assert.ok(state !== null);
    assert.strictEqual(state!.pending, true);
    assert.strictEqual(state!.url, undefined);
  });

  it("writes the correct /remote-control command to the PTY", () => {
    const sessions = (service as any).sessions as Map<string, any>;
    const writtenData: string[] = [];
    const mockProcess = {
      kill: () => {},
      write: (data: string) => writtenData.push(data),
    };

    const sessionId = "sess_rc_write";
    sessions.set(sessionId, {
      process: mockProcess,
      meta: { projectId: "proj-1", ticketId: "ticket-1" },
      logStream: { end: () => {} },
      exitPromise: Promise.resolve(),
      exitResolver: () => {},
    });

    service.startRemoteControl(sessionId, 'Ticket "With Quotes"');

    assert.strictEqual(writtenData.length, 1);
    assert.strictEqual(writtenData[0], '/remote-control "Ticket  With Quotes "\r');
  });

  it("truncates ticket title to 50 characters", () => {
    const sessions = (service as any).sessions as Map<string, any>;
    const writtenData: string[] = [];
    const mockProcess = {
      kill: () => {},
      write: (data: string) => writtenData.push(data),
    };

    const sessionId = "sess_rc_truncate";
    sessions.set(sessionId, {
      process: mockProcess,
      meta: { projectId: "proj-1", ticketId: "ticket-1" },
      logStream: { end: () => {} },
      exitPromise: Promise.resolve(),
      exitResolver: () => {},
    });

    const longTitle = "A".repeat(100);
    service.startRemoteControl(sessionId, longTitle);

    assert.strictEqual(writtenData.length, 1);
    const command = writtenData[0];
    // Extract the title from between quotes: /remote-control "TITLE"\r
    const match = command.match(/^\/remote-control "(.*)"\r$/);
    assert.ok(match, "Command should match expected format");
    assert.strictEqual(match![1].length, 50);
  });

  it("returns false (double-click guard) when RC is already pending", () => {
    const sessions = (service as any).sessions as Map<string, any>;
    const writtenData: string[] = [];
    const mockProcess = {
      kill: () => {},
      write: (data: string) => writtenData.push(data),
    };

    const sessionId = "sess_rc_guard";
    sessions.set(sessionId, {
      process: mockProcess,
      meta: { projectId: "proj-1", ticketId: "ticket-1" },
      logStream: { end: () => {} },
      exitPromise: Promise.resolve(),
      exitResolver: () => {},
    });

    const first = service.startRemoteControl(sessionId, "My Ticket");
    const second = service.startRemoteControl(sessionId, "My Ticket");

    assert.strictEqual(first, true);
    assert.strictEqual(second, false);
    assert.strictEqual(writtenData.length, 1); // Only written once
  });

  it("returns false (double-click guard) when RC URL is already set", () => {
    const sessions = (service as any).sessions as Map<string, any>;
    const mockProcess = {
      kill: () => {},
      write: () => {},
    };

    const sessionId = "sess_rc_url_guard";
    sessions.set(sessionId, {
      process: mockProcess,
      meta: { projectId: "proj-1", ticketId: "ticket-1" },
      logStream: { end: () => {} },
      exitPromise: Promise.resolve(),
      exitResolver: () => {},
    });

    // Manually set state as if URL was already captured
    const remoteControlState = (service as any).remoteControlState as Map<string, any>;
    remoteControlState.set(sessionId, { pending: false, url: "https://claude.ai/code/abc123" });

    const result = service.startRemoteControl(sessionId, "My Ticket");
    assert.strictEqual(result, false);
  });

  it("cleans up remoteControlState when session exits via onExit handler", () => {
    const sessions = (service as any).sessions as Map<string, any>;

    const mockProcess = {
      kill: () => {},
      write: () => {},
    };

    const sessionId = "sess_rc_cleanup";

    // Register the session so startRemoteControl can find it
    sessions.set(sessionId, {
      process: mockProcess,
      meta: { projectId: "proj-1", ticketId: "ticket-1" },
      logStream: { write: () => {}, end: () => {} },
      exitPromise: Promise.resolve(),
      exitResolver: () => {},
      forceKilled: false,
    });

    // Call startRemoteControl to set pending state
    service.startRemoteControl(sessionId, "My Ticket");
    assert.deepStrictEqual(service.getRemoteControlState(sessionId), { pending: true });

    // Invoke the cleanup that proc.onExit performs (via test helper that mirrors production logic)
    (service as any)._testSimulateSessionExit(sessionId);

    // Assert cleanup happened
    assert.strictEqual(service.getRemoteControlState(sessionId), null);
    assert.strictEqual(sessions.has(sessionId), false);
  });

  it("transitions remoteControlState from pending to url when PTY data contains a claude.ai URL", async () => {
    const { eventBus } = await import("../../../utils/event-bus.js");
    const sessions = (service as any).sessions as Map<string, any>;

    // Capture eventBus.emit calls
    const emittedEvents: Array<{ event: string; payload: unknown }> = [];
    const originalEmit = eventBus.emit.bind(eventBus);
    (eventBus as any).emit = (event: string, payload?: unknown) => {
      emittedEvents.push({ event, payload });
      return originalEmit(event, payload);
    };

    const mockProcess = {
      kill: () => {},
      write: () => {},
    };

    const sessionId = "sess_rc_url_scan";
    const meta = { projectId: "proj-1", ticketId: "ticket-1" };

    sessions.set(sessionId, {
      process: mockProcess,
      meta,
      logStream: { write: () => {}, end: () => {} },
      exitPromise: Promise.resolve(),
      exitResolver: () => {},
      forceKilled: false,
    });

    // Call startRemoteControl to set pending state
    service.startRemoteControl(sessionId, "My Ticket");
    assert.deepStrictEqual(service.getRemoteControlState(sessionId), { pending: true });

    // Drive ANSI-escaped PTY data containing a claude.ai URL through the onData handler
    const ansiData = "\x1B[32mhttps://claude.ai/code/abc123\x1B[0m";
    (service as any)._testSimulateOnData(sessionId, ansiData);

    // Assert state transitioned correctly
    const state = service.getRemoteControlState(sessionId);
    assert.ok(state !== null);
    assert.strictEqual(state!.pending, false);
    assert.strictEqual(state!.url, "https://claude.ai/code/abc123");

    // Assert eventBus.emit was called with the correct event and payload
    const urlEvent = emittedEvents.find((e) => e.event === "session:remote-control-url");
    assert.ok(urlEvent !== undefined, "session:remote-control-url event should have been emitted");
    assert.deepStrictEqual(urlEvent!.payload, {
      sessionId,
      ticketId: "ticket-1",
      projectId: "proj-1",
      url: "https://claude.ai/code/abc123",
    });

    // Restore
    (eventBus as any).emit = originalEmit;
  });
});

describe("TicketLifecycleConflictError", () => {
  it("exposes the lifecycle conflict contract fields", () => {
    const error = new TicketLifecycleConflictError("Backlog", 11);
    assert.strictEqual(error.code, "TICKET_LIFECYCLE_CONFLICT");
    assert.strictEqual(error.retryable, true);
    assert.strictEqual(error.currentPhase, "Backlog");
    assert.strictEqual(error.currentGeneration, 11);
    assert.strictEqual(error.name, "TicketLifecycleConflictError");
  });
});

describe("StaleTicketInputError", () => {
  it("exposes the stale input contract fields", () => {
    const error = new StaleTicketInputError(
      "Ticket input no longer matches the active lifecycle",
      9,
      7,
      "q-1",
      "q-2",
    );
    assert.strictEqual(error.code, "STALE_TICKET_INPUT");
    assert.strictEqual(error.retryable, false);
    assert.strictEqual(error.currentGeneration, 9);
    assert.strictEqual(error.providedGeneration, 7);
    assert.strictEqual(error.expectedQuestionId, "q-1");
    assert.strictEqual(error.providedQuestionId, "q-2");
    assert.strictEqual(error.name, "StaleTicketInputError");
  });
});

describe("SessionService continuity compatibility key", () => {
  it("normalizes list fields and hashes prompt text", () => {
    const service = new SessionService(new EventEmitter());
    const compatibility = (service as any).buildContinuityCompatibilityKey({
      ticketId: "POT-22",
      phase: "Build",
      agentSource: "agents/build.md",
      executionGeneration: 7,
      workflowId: "wf_main",
      worktreePath: "/tmp/worktree",
      branchName: "potato/POT-22",
      agentPrompt: "never persist this prompt raw",
      mcpServerNames: ["zeta", "alpha", "potato-cannon"],
      model: "sonnet",
      disallowedTools: ["B", "A"],
    });

    assert.deepStrictEqual(compatibility.mcpServerNames, ["alpha", "potato-cannon", "zeta"]);
    assert.deepStrictEqual(compatibility.disallowedTools, ["A", "B"]);
    assert.notStrictEqual(
      compatibility.agentDefinitionPromptHash,
      "never persist this prompt raw",
    );
    assert.strictEqual(compatibility.agentDefinitionPromptHash.length, 64);
  });
});

describe("SessionService continuity metadata persistence helpers", () => {
  it("builds continuity metadata for session start from the selected decision", () => {
    const service = new SessionService(new EventEmitter());
    const compatibility = (service as any).buildContinuityCompatibilityKey({
      ticketId: "POT-22",
      phase: "Build",
      agentSource: "agents/build.md",
      executionGeneration: 3,
      workflowId: "wf-main",
      worktreePath: "/tmp/wt",
      branchName: "potato/POT-22",
      agentPrompt: "Build implementation",
      mcpServerNames: ["potato-cannon"],
      model: "sonnet",
      disallowedTools: ["Skill(superpowers:*)"],
    });

    const metadata = (service as any).buildStoredSessionContinuityMetadata(
      {
        mode: "handoff",
        reason: "packet_available",
        scope: "same_lifecycle",
        packet: {
          scope: "same_lifecycle",
          conversationTurns: [{ role: "user", text: "continue" }],
          sessionHighlights: [{ summary: "added API skeleton" }],
          unresolvedQuestions: ["confirm route naming"],
        },
      },
      compatibility,
    );

    assert.strictEqual(metadata.continuityMode, "handoff");
    assert.strictEqual(metadata.continuityReason, "packet_available");
    assert.strictEqual(metadata.continuityScope, "same_lifecycle");
    assert.ok(typeof metadata.continuitySummary === "string");
    assert.strictEqual(metadata.continuitySourceSessionId, undefined);
    assert.deepStrictEqual(metadata.continuityCompatibility, compatibility);
  });

  it("preserves continuity fields when deriving session_end meta from session_start meta", () => {
    const startMeta = {
      projectId: "proj-1",
      ticketId: "POT-1",
      startedAt: new Date().toISOString(),
      status: "running" as const,
      continuityMode: "handoff" as const,
      continuityReason: "packet_available" as const,
      continuityScope: "same_lifecycle" as const,
      continuitySummary: "handoff(same_lifecycle): turns=1, highlights=1, questions=1",
      continuitySourceSessionId: "claude_prev_1",
    };

    const endMeta = {
      ...startMeta,
      status: "completed" as const,
      exitCode: 0,
      endedAt: new Date().toISOString(),
    };

    assert.strictEqual(endMeta.continuityMode, startMeta.continuityMode);
    assert.strictEqual(endMeta.continuityReason, startMeta.continuityReason);
    assert.strictEqual(endMeta.continuityScope, startMeta.continuityScope);
    assert.strictEqual(endMeta.continuitySummary, startMeta.continuitySummary);
    assert.strictEqual(
      endMeta.continuitySourceSessionId,
      startMeta.continuitySourceSessionId,
    );
  });
});

describe("evaluateResumeEligibility", () => {
  const baseKey = {
    ticketId: "POT-1",
    phase: "Build",
    agentSource: "agents/build.md",
    executionGeneration: 4,
    workflowId: "wf-main",
    worktreePath: "/tmp/wt",
    branchName: "potato/POT-1",
    agentDefinitionPromptHash: "a".repeat(64),
    mcpServerNames: ["potato-cannon", "p4"],
    model: "sonnet",
    disallowedTools: ["Skill(superpowers:*)"],
  };

  it("returns eligible only when all compatibility fields match", () => {
    const result = evaluateResumeEligibility({
      stored: baseKey,
      current: { ...baseKey },
      claudeSessionId: "claude_123",
      lifecycleInvalidated: false,
    });

    assert.deepStrictEqual(result, { eligible: true, reason: "eligible" });
  });

  it("rejects resume when any compatibility field mismatches", () => {
    const mismatchCases = [
      { ticketId: "POT-2" },
      { phase: "Refinement" },
      { agentSource: "agents/review.md" },
      { executionGeneration: 5 },
      { workflowId: "wf-2" },
      { worktreePath: "/tmp/wt2" },
      { branchName: "potato/POT-2" },
      { agentDefinitionPromptHash: "b".repeat(64) },
      { mcpServerNames: ["potato-cannon"] },
      { model: "haiku" },
      { disallowedTools: [] as string[] },
    ];

    for (const mismatch of mismatchCases) {
      const result = evaluateResumeEligibility({
        stored: baseKey,
        current: { ...baseKey, ...mismatch },
        claudeSessionId: "claude_123",
        lifecycleInvalidated: false,
      });
      assert.deepStrictEqual(result, {
        eligible: false,
        reason: "compatibility_mismatch",
      });
    }
  });

  it("rejects resume when compatibility key is incomplete", () => {
    const result = evaluateResumeEligibility({
      stored: { ...baseKey, workflowId: "" },
      current: { ...baseKey },
      claudeSessionId: "claude_123",
      lifecycleInvalidated: false,
    });

    assert.deepStrictEqual(result, {
      eligible: false,
      reason: "missing_compatibility_key",
    });
  });

  it("rejects resume without a stored Claude session id", () => {
    const result = evaluateResumeEligibility({
      stored: baseKey,
      current: { ...baseKey },
      claudeSessionId: "",
      lifecycleInvalidated: false,
    });

    assert.deepStrictEqual(result, {
      eligible: false,
      reason: "missing_claude_session_id",
    });
  });

  it("rejects resume after lifecycle invalidation", () => {
    const result = evaluateResumeEligibility({
      stored: baseKey,
      current: { ...baseKey },
      claudeSessionId: "claude_123",
      lifecycleInvalidated: true,
    });

    assert.deepStrictEqual(result, {
      eligible: false,
      reason: "lifecycle_invalidated",
    });
  });
});

describe("decideContinuityMode", () => {
  const baseKey = {
    ticketId: "POT-1",
    phase: "Build",
    agentSource: "agents/build.md",
    executionGeneration: 4,
    workflowId: "wf-main",
    worktreePath: "/tmp/wt",
    branchName: "potato/POT-1",
    agentDefinitionPromptHash: "a".repeat(64),
    mcpServerNames: ["potato-cannon", "p4"],
    model: "sonnet",
    disallowedTools: ["Skill(superpowers:*)"],
  };

  it("prioritizes suspended resume over all other continuity options", () => {
    const decision = decideContinuityMode({
      suspendedResumeSessionId: "claude_suspended_1",
      restartSnapshot: {
        scope: "safe_user_context_only",
        conversationTurns: [],
        sessionHighlights: [],
        unresolvedQuestions: [],
      },
      resumeEligibility: {
        stored: baseKey,
        current: baseKey,
        claudeSessionId: "claude_resume_1",
      },
      sameLifecyclePacket: {
        scope: "same_lifecycle",
        conversationTurns: [{ role: "user", text: "context" }],
        sessionHighlights: [],
        unresolvedQuestions: [],
      },
    });

    assert.deepStrictEqual(decision, {
      mode: "resume",
      reason: "suspended_session_resume",
      sourceSessionId: "claude_suspended_1",
    });
  });

  it("chooses restart snapshot handoff before same-lifecycle resume checks", () => {
    const decision = decideContinuityMode({
      restartSnapshot: {
        scope: "safe_user_context_only",
        conversationTurns: [{ role: "user", text: "restart context" }],
        sessionHighlights: [],
        unresolvedQuestions: [],
      },
      resumeEligibility: {
        stored: baseKey,
        current: baseKey,
        claudeSessionId: "claude_resume_1",
      },
      sameLifecyclePacket: null,
    });

    assert.strictEqual(decision.mode, "handoff");
    assert.strictEqual(decision.reason, "restart_snapshot");
    assert.strictEqual(decision.scope, "safe_user_context_only");
  });

  it("chooses same-lifecycle handoff when resume is unsafe but packet exists", () => {
    const decision = decideContinuityMode({
      resumeEligibility: {
        stored: baseKey,
        current: { ...baseKey, phase: "Refinement" },
        claudeSessionId: "claude_resume_1",
      },
      sameLifecyclePacket: {
        scope: "same_lifecycle",
        conversationTurns: [{ role: "user", text: "handoff context" }],
        sessionHighlights: [],
        unresolvedQuestions: [],
      },
    });

    assert.strictEqual(decision.mode, "handoff");
    assert.strictEqual(decision.reason, "packet_available");
  });

  it("falls back to fresh when resume is stale and no packet is available", () => {
    const decision = decideContinuityMode({
      resumeEligibility: {
        stored: baseKey,
        current: baseKey,
        claudeSessionId: "claude_resume_1",
        lifecycleInvalidated: true,
      },
      sameLifecyclePacket: null,
    });

    assert.deepStrictEqual(decision, {
      mode: "fresh",
      reason: "resume_not_allowed",
    });
  });
});

describe("SessionService transcript highlights", () => {
  it("parses structured assistant/tool entries and excludes raw lines", async () => {
    const service = new SessionService(new EventEmitter());
    const sessionId = `sess_highlight_${Date.now()}`;
    const logPath = service.getSessionLogPath(sessionId);
    await fs.mkdir(SESSIONS_DIR, { recursive: true });

    await fs.writeFile(
      logPath,
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-11T00:00:00.000Z",
          message: { content: [{ type: "text", text: "assistant summary" }] },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-11T00:00:01.000Z",
          message: {
            content: [{ type: "tool_use", name: "chat_ask" }],
          },
        }),
        JSON.stringify({
          type: "output",
          timestamp: "2026-03-11T00:00:02.000Z",
          tool_name: "chat_ask",
          tool_result: "ok",
        }),
        JSON.stringify({
          type: "raw",
          timestamp: "2026-03-11T00:00:03.000Z",
          content: "raw PTY bytes",
        }),
      ].join("\n"),
      "utf-8",
    );

    const highlights = await service.getTranscriptHighlightsForContinuity(sessionId, 10);

    assert.strictEqual(highlights.length, 3);
    assert.deepStrictEqual(
      highlights.map((h) => h.kind),
      ["assistant", "assistant", "tool"],
    );
    assert.ok(highlights.every((h) => !h.summary.includes("raw PTY")));

    await fs.unlink(logPath);
  });
});

describe("SessionService restart snapshot cache", () => {
  it("takeRestartSnapshotForTicket returns snapshot once and clears it", () => {
    const service = new SessionService(new EventEmitter());
    const cache = (service as any).consumedRestartSnapshots as Map<string, unknown>;
    cache.set("POT-1", {
      scope: "safe_user_context_only",
      conversationTurns: [],
      sessionHighlights: [],
      unresolvedQuestions: [],
    });

    const first = service.takeRestartSnapshotForTicket("POT-1");
    const second = service.takeRestartSnapshotForTicket("POT-1");

    assert.ok(first);
    assert.strictEqual((first as any).scope, "safe_user_context_only");
    assert.strictEqual(second, null);
  });
});

describe("SessionService decideContinuityForTicket", () => {
  const baseKey = {
    ticketId: "POT-1",
    phase: "Build",
    agentSource: "agents/build.md",
    executionGeneration: 4,
    workflowId: "wf-main",
    worktreePath: "/tmp/wt",
    branchName: "potato/POT-1",
    agentDefinitionPromptHash: "a".repeat(64),
    mcpServerNames: ["potato-cannon", "p4"],
    model: "sonnet",
    disallowedTools: ["Skill(superpowers:*)"],
  };

  it("prefers consumed restart snapshots over same-lifecycle packets", async () => {
    const service = new SessionService(new EventEmitter());
    const cache = (service as any).consumedRestartSnapshots as Map<string, unknown>;
    cache.set("POT-1", {
      scope: "safe_user_context_only",
      conversationTurns: [{ role: "user", text: "restart snapshot" }],
      sessionHighlights: [],
      unresolvedQuestions: [],
    });
    (service as any).buildContinuityPacketForTicket = async () => ({
      scope: "same_lifecycle",
      conversationTurns: [{ role: "user", text: "same lifecycle" }],
      sessionHighlights: [],
      unresolvedQuestions: [],
    });

    const decision = await service.decideContinuityForTicket({
      ticketId: "POT-1",
      filter: { phase: "Build", agentSource: "agents/build.md", executionGeneration: 4 },
      limits: {
        maxConversationTurns: 12,
        maxSessionEvents: 12,
        maxCharsPerItem: 800,
        maxPromptChars: 16000,
      },
      resumeEligibility: {
        stored: baseKey,
        current: baseKey,
        claudeSessionId: "claude_resume_1",
      },
    });

    assert.strictEqual(decision.mode, "handoff");
    assert.strictEqual(decision.reason, "restart_snapshot");
  });

  it("prefers suspended resume over restart snapshots and packet handoff", async () => {
    const service = new SessionService(new EventEmitter());
    const cache = (service as any).consumedRestartSnapshots as Map<string, unknown>;
    cache.set("POT-1", {
      scope: "safe_user_context_only",
      conversationTurns: [{ role: "user", text: "restart snapshot" }],
      sessionHighlights: [],
      unresolvedQuestions: [],
    });
    (service as any).buildContinuityPacketForTicket = async () => ({
      scope: "same_lifecycle",
      conversationTurns: [{ role: "user", text: "same lifecycle" }],
      sessionHighlights: [],
      unresolvedQuestions: [],
    });

    const decision = await service.decideContinuityForTicket({
      ticketId: "POT-1",
      filter: { phase: "Build", agentSource: "agents/build.md", executionGeneration: 4 },
      limits: {
        maxConversationTurns: 12,
        maxSessionEvents: 12,
        maxCharsPerItem: 800,
        maxPromptChars: 16000,
      },
      resumeEligibility: {
        stored: baseKey,
        current: baseKey,
        claudeSessionId: "claude_resume_1",
      },
      suspendedResumeSessionId: "claude_suspended_1",
    });

    assert.strictEqual(decision.mode, "resume");
    assert.strictEqual(decision.reason, "suspended_session_resume");
    assert.strictEqual(decision.sourceSessionId, "claude_suspended_1");
  });

  it("returns handoff decision details for same-lifecycle packets", async () => {
    const service = new SessionService(new EventEmitter());
    (service as any).buildContinuityPacketForTicket = async () => ({
      scope: "same_lifecycle",
      conversationTurns: [{ role: "user", text: "handoff context" }],
      sessionHighlights: [{ summary: "completed scaffolding" }],
      unresolvedQuestions: ["confirm endpoint naming"],
    });

    const decision = await service.decideContinuityForTicket({
      ticketId: "POT-1",
      filter: { phase: "Build", agentSource: "agents/build.md", executionGeneration: 4 },
      limits: {
        maxConversationTurns: 12,
        maxSessionEvents: 12,
        maxCharsPerItem: 800,
        maxPromptChars: 16000,
      },
      resumeEligibility: {
        stored: baseKey,
        current: { ...baseKey, phase: "Refinement" },
        claudeSessionId: "claude_resume_1",
      },
    });

    assert.strictEqual(decision.mode, "handoff");
    assert.strictEqual(decision.reason, "packet_available");
    assert.strictEqual(decision.scope, "same_lifecycle");
    assert.strictEqual(decision.packet?.conversationTurns.length, 1);
  });

  it("falls back to fresh disabled mode when lifecycle continuity is turned off", async () => {
    const service = new SessionService(new EventEmitter());
    (service as any).isLifecycleContinuityEnabled = () => false;
    (service as any).buildContinuityPacketForTicket = async () => {
      throw new Error("should not build packet when continuity is disabled");
    };
    const decision = await service.decideContinuityForTicket({
      ticketId: "POT-1",
      filter: { phase: "Build", agentSource: "agents/build.md", executionGeneration: 4 },
      limits: {
        maxConversationTurns: 12,
        maxSessionEvents: 12,
        maxCharsPerItem: 800,
        maxPromptChars: 16000,
      },
      resumeEligibility: {
        stored: baseKey,
        current: baseKey,
        claudeSessionId: "claude_resume_1",
      },
    });

    assert.deepStrictEqual(decision, {
      mode: "fresh",
      reason: "disabled",
    });
  });
});

import { extractTokensFromResultEvent } from "../session.service.js";

describe("extractTokensFromResultEvent", () => {
  it("parses usage from result event", () => {
    const event = {
      type: "result",
      subtype: "success",
      result: "done",
      usage: { input_tokens: 1500, output_tokens: 300 },
    };
    const tokens = extractTokensFromResultEvent(event);
    assert.deepStrictEqual(tokens, { inputTokens: 1500, outputTokens: 300 });
  });

  it("returns null when no usage", () => {
    const event = { type: "result", subtype: "error", result: "failed" };
    const tokens = extractTokensFromResultEvent(event);
    assert.strictEqual(tokens, null);
  });

  it("returns null when usage has zero values (== null guard, not falsy)", () => {
    const event = { type: "result", usage: { input_tokens: 0, output_tokens: 0 } };
    const tokens = extractTokensFromResultEvent(event);
    assert.deepStrictEqual(tokens, { inputTokens: 0, outputTokens: 0 });
  });
});
