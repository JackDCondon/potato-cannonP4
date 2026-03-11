import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import {
  SessionService,
  TicketLifecycleConflictError,
  StaleTicketInputError,
} from "../session.service.js";
import { evaluateResumeEligibility } from "../continuity-policy.js";

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
});

describe("SessionService model resolution", () => {
  it("should pass resolved model to spawnClaudeSession args", async () => {
    // This test verifies the resolveModel function is correctly integrated
    // We test the resolver directly since spawnClaudeSession is private

    // Import the resolver
    const { resolveModel } = await import("../model-resolver.js");

    // Test that shortcuts resolve correctly
    assert.strictEqual(resolveModel("haiku"), "haiku");
    assert.strictEqual(resolveModel("sonnet"), "sonnet");
    assert.strictEqual(resolveModel("opus"), "opus");

    // Test that explicit IDs pass through
    assert.strictEqual(
      resolveModel("claude-sonnet-4-20250514"),
      "claude-sonnet-4-20250514"
    );

    // Test that undefined returns null (no --model flag)
    assert.strictEqual(resolveModel(undefined), null);

    // Test object format
    assert.strictEqual(
      resolveModel({ id: "claude-opus-4-20250514", provider: "anthropic" }),
      "claude-opus-4-20250514"
    );
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
