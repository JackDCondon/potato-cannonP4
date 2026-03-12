import { beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import {
  createTicketThreadCommandHandler,
  parseTicketThreadCommand,
} from "../chat-thread-commands.js";

let sendReplyCalls: Array<{ providerId: string; message: string }> = [];
let emitCalls: Array<{ event: string; payload: unknown }> = [];
let invalidateCalls: Array<{
  projectId: string;
  ticketId: string;
  options: { targetPhase: string; expectedPhase?: string; expectedGeneration?: number };
}> = [];
let spawnCalls: Array<{ projectId: string; ticketId: string; phase: string; projectPath: string }> = [];
let pendingQuestion: unknown = null;
let activeSession:
  | { startedAt: string; endedAt?: string; agentSource?: string }
  | null = null;
let messages: Array<{ timestamp: string }> = [];
let sessions: Array<{ startedAt: string; endedAt?: string }> = [];
let workerState: unknown = null;
let ticketRow: {
  id: string;
  title: string;
  phase: string;
  executionGeneration?: number;
  workflowId?: string;
  conversationId?: string;
  archived?: boolean;
} = {
  id: "POT-1",
  title: "Test ticket",
  phase: "Ideas",
  executionGeneration: 3,
  workflowId: "wf-1",
  conversationId: "conv-1",
  archived: false,
};
let fullTemplate: {
  phases: Array<{ id: string; name: string; workers: Array<{ id: string; type: string }> }>;
} = {
  phases: [
    { id: "Ideas", name: "Ideas", workers: [] },
    { id: "Build", name: "Build", workers: [{ id: "builder", type: "agent" }] },
    { id: "Blocked", name: "Blocked", workers: [] },
    { id: "Done", name: "Done", workers: [] },
  ],
};
let phaseConfigWorkers: Array<{ id: string; type: string }> = [];
let phaseConfigByPhase: Record<string, Array<{ id: string; type: string }>> = {};

function createHandler() {
  return createTicketThreadCommandHandler({
    getTicket: async () => ticketRow,
    isTerminalPhase: (phase: string) => phase === "Done",
    getTemplateWithFullPhasesForContext: async () => fullTemplate,
    getPhaseConfig: async (_projectId: string, phaseName: string) => ({
      workers: phaseConfigByPhase[phaseName] ?? phaseConfigWorkers,
    }),
    readQuestion: async () => pendingQuestion,
    getActiveSessionForTicket: () => activeSession,
    getSessionsByTicket: () => sessions,
    getMessages: () => messages,
    getWorkerState: () => workerState,
    isActiveWorkerStateRoot: (state: unknown) =>
      !!state && typeof state === "object" && (state as { kind?: string }).kind === "active",
    sendReply: async (providerId: string, _context: unknown, message: string) => {
      sendReplyCalls.push({ providerId, message });
    },
    invalidateTicketLifecycle: async (
      projectId: string,
      ticketId: string,
      options: { targetPhase: string; expectedPhase?: string; expectedGeneration?: number },
    ) => {
      invalidateCalls.push({ projectId, ticketId, options });
      return {
        ticket: { id: ticketId, phase: options.targetPhase },
        executionGeneration: 4,
      };
    },
    spawnForTicket: async (projectId: string, ticketId: string, phase: string, projectPath: string) => {
      spawnCalls.push({ projectId, ticketId, phase, projectPath });
    },
    getProjects: () => new Map([["proj-1", { path: "D:/repo" }]]),
    emitEvent: (event: string, payload: unknown) => {
      emitCalls.push({ event, payload });
    },
  });
}

describe("chat thread commands", () => {
  beforeEach(() => {
    sendReplyCalls = [];
    emitCalls = [];
    invalidateCalls = [];
    spawnCalls = [];
    pendingQuestion = null;
    activeSession = null;
    messages = [];
    sessions = [];
    workerState = null;
    ticketRow = {
      id: "POT-1",
      title: "Test ticket",
      phase: "Ideas",
      executionGeneration: 3,
      workflowId: "wf-1",
      conversationId: "conv-1",
      archived: false,
    };
    fullTemplate = {
      phases: [
        { id: "Ideas", name: "Ideas", workers: [] },
        { id: "Build", name: "Build", workers: [{ id: "builder", type: "agent" }] },
        { id: "Blocked", name: "Blocked", workers: [] },
        { id: "Done", name: "Done", workers: [] },
      ],
    };
    phaseConfigWorkers = [];
    phaseConfigByPhase = {
      Ideas: [],
      Build: [{ id: "builder", type: "agent" }],
      Blocked: [],
      Done: [],
    };
  });

  it("parses supported commands", () => {
    assert.strictEqual(parseTicketThreadCommand("status"), "status");
    assert.strictEqual(parseTicketThreadCommand("  PUSH "), "push");
    assert.strictEqual(parseTicketThreadCommand("push!"), "push_force");
    assert.strictEqual(parseTicketThreadCommand("hello"), null);
  });

  it("status reports lane, worker, active session, and last activity", async () => {
    activeSession = {
      startedAt: "2026-03-12T01:09:00.000Z",
      agentSource: "builder",
    };
    messages = [{ timestamp: "2026-03-12T01:10:00.000Z" }];

    const handled = await createHandler()(
      "slack",
      { projectId: "proj-1", ticketId: "POT-1" },
      "status",
    );

    assert.strictEqual(handled, true);
    assert.strictEqual(sendReplyCalls.length, 1);
    assert.match(sendReplyCalls[0].message, /Lane:\s*Ideas/);
    assert.match(sendReplyCalls[0].message, /Assigned worker:\s*builder/);
    assert.match(sendReplyCalls[0].message, /Active session:\s*yes/);
    assert.match(sendReplyCalls[0].message, /Last activity:\s*2026-03-12T01:10:00.000Z/);
  });

  it("push blocks when pending question exists", async () => {
    pendingQuestion = { questionId: "q-1" };

    const handled = await createHandler()(
      "slack",
      { projectId: "proj-1", ticketId: "POT-1" },
      "push",
    );

    assert.strictEqual(handled, true);
    assert.strictEqual(invalidateCalls.length, 0);
    assert.match(sendReplyCalls[0].message, /pending question/i);
  });

  it("push moves right by one lane when current lane is holding", async () => {
    ticketRow.phase = "Ideas";
    phaseConfigWorkers = [];

    const handled = await createHandler()(
      "telegram",
      { projectId: "proj-1", ticketId: "POT-1" },
      "push",
    );

    assert.strictEqual(handled, true);
    assert.strictEqual(invalidateCalls.length, 1);
    assert.strictEqual(invalidateCalls[0].options.targetPhase, "Build");
    assert.strictEqual(emitCalls.some((e) => e.event === "ticket:moved"), true);
    assert.strictEqual(spawnCalls.length, 1);
    assert.match(sendReplyCalls[0].message, /Ideas\s*->\s*Build/);
  });

  it("push blocks in non-holding lane but push! allows override", async () => {
    ticketRow.phase = "Build";
    phaseConfigWorkers = [{ id: "builder", type: "agent" }];
    phaseConfigByPhase.Build = [{ id: "builder", type: "agent" }];
    fullTemplate = {
      phases: [
        { id: "Ideas", name: "Ideas", workers: [] },
        { id: "Build", name: "Build", workers: [{ id: "builder", type: "agent" }] },
        { id: "Blocked", name: "Blocked", workers: [] },
      ],
    };

    const handledPush = await createHandler()(
      "slack",
      { projectId: "proj-1", ticketId: "POT-1" },
      "push",
    );
    assert.strictEqual(handledPush, true);
    assert.strictEqual(invalidateCalls.length, 0);
    assert.match(sendReplyCalls[0].message, /holding swimlane/i);

    const handledForce = await createHandler()(
      "slack",
      { projectId: "proj-1", ticketId: "POT-1" },
      "push!",
    );
    assert.strictEqual(handledForce, true);
    assert.strictEqual(invalidateCalls.length, 1);
  });
});
