import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import { createProjectStore } from "../project.store.js";
import { createTicketStore, TicketStore } from "../ticket.store.js";
import { createBrainstormStore, BrainstormStore } from "../brainstorm.store.js";
import { createSessionStore, SessionStore } from "../session.store.js";

describe("SessionStore", () => {
  let db: Database.Database;
  let sessionStore: SessionStore;
  let ticketStore: TicketStore;
  let brainstormStore: BrainstormStore;
  let testDbPath: string;
  let projectId: string;

  before(() => {
    testDbPath = path.join(os.tmpdir(), `potato-session-test-${Date.now()}.db`);
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Test Project",
      path: "/test/project",
    });
    projectId = project.id;

    sessionStore = createSessionStore(db);
    ticketStore = createTicketStore(db);
    brainstormStore = createBrainstormStore(db);
  });

  after(() => {
    db.close();
    try {
      fs.unlinkSync(testDbPath);
      fs.unlinkSync(testDbPath + "-wal");
      fs.unlinkSync(testDbPath + "-shm");
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    // Order matters due to foreign key constraints
    db.prepare("DELETE FROM sessions").run();
    db.prepare("DELETE FROM conversation_messages").run();
    db.prepare("DELETE FROM brainstorms").run();
    db.prepare("DELETE FROM ticket_history").run();
    db.prepare("DELETE FROM tickets").run();
    db.prepare("DELETE FROM conversations").run();
    db.prepare("DELETE FROM ticket_counters").run();
  });

  describe("createSession", () => {
    it("should create a session with generated ID", () => {
      const session = sessionStore.createSession({ projectId });

      assert.ok(session.id);
      assert.ok(session.id.startsWith("sess_"));
      assert.strictEqual(session.projectId, projectId);
      assert.ok(session.startedAt);
      assert.strictEqual(session.endedAt, undefined);
    });

    it("should create session with ticketId", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test Ticket" });

      const session = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        executionGeneration: 0,
      });

      assert.strictEqual(session.ticketId, ticket.id);
      assert.strictEqual((session as unknown as { executionGeneration?: number | null }).executionGeneration, 0);
      assert.strictEqual(session.brainstormId, undefined);
    });

    it("should create session with brainstormId", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);

      const session = sessionStore.createSession({
        projectId,
        brainstormId: brainstorm.id,
      });

      assert.strictEqual(session.brainstormId, brainstorm.id);
      assert.strictEqual(session.ticketId, undefined);
      assert.strictEqual((session as unknown as { executionGeneration?: number | null }).executionGeneration, null);
    });

    it("should store optional fields", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test" });

      const session = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        claudeSessionId: "claude_abc123",
        agentSource: "test-agent.md",
        phase: "Refinement",
        metadata: { custom: "data" },
      });

      assert.strictEqual(session.claudeSessionId, "claude_abc123");
      assert.strictEqual(session.agentSource, "test-agent.md");
      assert.strictEqual(session.phase, "Refinement");
      assert.deepStrictEqual(session.metadata, { custom: "data" });
    });

    it("should persist continuity compatibility metadata", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Compatibility ticket" });

      const session = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        phase: "Build",
        metadata: {
          continuityCompatibility: {
            ticketId: ticket.id,
            phase: "Build",
            agentSource: "agents/build.md",
            executionGeneration: 2,
            workflowId: "wf_1",
            worktreePath: "D:/tmp/worktree",
            branchName: "potato/POT-1",
            agentDefinitionPromptHash: "abc123",
            mcpServerNames: ["potato-cannon", "p4"],
            model: "sonnet",
            disallowedTools: ["Skill(superpowers:*)"],
          },
        },
      });

      assert.deepStrictEqual((session.metadata as any)?.continuityCompatibility, {
        ticketId: ticket.id,
        phase: "Build",
        agentSource: "agents/build.md",
        executionGeneration: 2,
        workflowId: "wf_1",
        worktreePath: "D:/tmp/worktree",
        branchName: "potato/POT-1",
        agentDefinitionPromptHash: "abc123",
        mcpServerNames: ["potato-cannon", "p4"],
        model: "sonnet",
        disallowedTools: ["Skill(superpowers:*)"],
      });
    });

    it("should persist continuity decision metadata fields", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Decision metadata ticket" });

      const session = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        phase: "Build",
        metadata: {
          continuityMode: "handoff",
          continuityReason: "packet_available",
          continuityScope: "same_lifecycle",
          continuitySummary: "handoff(same_lifecycle): turns=1, highlights=1, questions=1",
          continuitySourceSessionId: "claude_prev_1",
        },
      });

      assert.strictEqual((session.metadata as any)?.continuityMode, "handoff");
      assert.strictEqual((session.metadata as any)?.continuityReason, "packet_available");
      assert.strictEqual((session.metadata as any)?.continuityScope, "same_lifecycle");
      assert.strictEqual(
        (session.metadata as any)?.continuitySummary,
        "handoff(same_lifecycle): turns=1, highlights=1, questions=1"
      );
      assert.strictEqual((session.metadata as any)?.continuitySourceSessionId, "claude_prev_1");
    });
  });

  describe("getSession", () => {
    it("should return null for non-existent session", () => {
      const session = sessionStore.getSession("non-existent");
      assert.strictEqual(session, null);
    });

    it("should return session by ID", () => {
      const created = sessionStore.createSession({ projectId });
      const session = sessionStore.getSession(created.id);

      assert.ok(session);
      assert.strictEqual(session.id, created.id);
    });
  });

  describe("endSession", () => {
    it("should mark session as ended", () => {
      const created = sessionStore.createSession({ projectId });

      const result = sessionStore.endSession(created.id);

      assert.strictEqual(result, true);

      const session = sessionStore.getSession(created.id)!;
      assert.ok(session.endedAt);
    });

    it("should store exit code", () => {
      const created = sessionStore.createSession({ projectId });

      sessionStore.endSession(created.id, 0);

      const session = sessionStore.getSession(created.id)!;
      assert.strictEqual(session.exitCode, 0);
    });

    it("should return false for non-existent session", () => {
      const result = sessionStore.endSession("non-existent");
      assert.strictEqual(result, false);
    });
  });

  describe("updateClaudeSessionId", () => {
    it("should update claude session ID", () => {
      const created = sessionStore.createSession({ projectId });

      const result = sessionStore.updateClaudeSessionId(created.id, "new_claude_id");

      assert.strictEqual(result, true);

      const session = sessionStore.getSession(created.id)!;
      assert.strictEqual(session.claudeSessionId, "new_claude_id");
    });

    it("should return false for non-existent session", () => {
      const result = sessionStore.updateClaudeSessionId("non-existent", "claude_id");
      assert.strictEqual(result, false);
    });
  });

  describe("getSessionsByTicket", () => {
    it("should return empty array when no sessions", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test" });
      const sessions = sessionStore.getSessionsByTicket(ticket.id);
      assert.deepStrictEqual(sessions, []);
    });

    it("should return sessions for ticket in order", () => {
      const ticket1 = ticketStore.createTicket(projectId, { title: "Ticket 1" });
      const ticket2 = ticketStore.createTicket(projectId, { title: "Ticket 2" });

      const first = sessionStore.createSession({ projectId, ticketId: ticket1.id });
      sessionStore.endSession(first.id);
      sessionStore.createSession({ projectId, ticketId: ticket1.id });
      sessionStore.createSession({ projectId, ticketId: ticket2.id }); // different ticket

      const sessions = sessionStore.getSessionsByTicket(ticket1.id);

      assert.strictEqual(sessions.length, 2);
      assert.ok(sessions[0].startedAt <= sessions[1].startedAt);
    });
  });

  describe("getSessionsByBrainstorm", () => {
    it("should return empty array when no sessions", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);
      const sessions = sessionStore.getSessionsByBrainstorm(brainstorm.id);
      assert.deepStrictEqual(sessions, []);
    });

    it("should return sessions for brainstorm", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);

      sessionStore.createSession({ projectId, brainstormId: brainstorm.id });
      sessionStore.createSession({ projectId, brainstormId: brainstorm.id });

      const sessions = sessionStore.getSessionsByBrainstorm(brainstorm.id);

      assert.strictEqual(sessions.length, 2);
    });
  });

  describe("getActiveSessionForTicket", () => {
    it("should return null when no active sessions", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test" });
      const session = sessionStore.getActiveSessionForTicket(ticket.id);
      assert.strictEqual(session, null);
    });

    it("should return active session", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test" });
      const created = sessionStore.createSession({ projectId, ticketId: ticket.id });

      const active = sessionStore.getActiveSessionForTicket(ticket.id);

      assert.ok(active);
      assert.strictEqual(active.id, created.id);
    });

    it("should not return ended session", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test" });
      const created = sessionStore.createSession({ projectId, ticketId: ticket.id });
      sessionStore.endSession(created.id);

      const active = sessionStore.getActiveSessionForTicket(ticket.id);

      assert.strictEqual(active, null);
    });

    it("should return most recent active session", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test" });

      const first = sessionStore.createSession({ projectId, ticketId: ticket.id });
      sessionStore.endSession(first.id);
      const second = sessionStore.createSession({ projectId, ticketId: ticket.id });

      const active = sessionStore.getActiveSessionForTicket(ticket.id);

      assert.ok(active);
      assert.strictEqual(active.id, second.id);
    });
  });

  describe("getActiveSessionForBrainstorm", () => {
    it("should return null when no active sessions", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);
      const session = sessionStore.getActiveSessionForBrainstorm(brainstorm.id);
      assert.strictEqual(session, null);
    });

    it("should return active session", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);
      const created = sessionStore.createSession({ projectId, brainstormId: brainstorm.id });

      const active = sessionStore.getActiveSessionForBrainstorm(brainstorm.id);

      assert.ok(active);
      assert.strictEqual(active.id, created.id);
    });
  });

  describe("hasActiveSession", () => {
    it("should return false when no ticket or brainstorm", () => {
      const result = sessionStore.hasActiveSession();
      assert.strictEqual(result, false);
    });

    it("should return true when ticket has active session", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test" });
      sessionStore.createSession({ projectId, ticketId: ticket.id });

      const result = sessionStore.hasActiveSession(ticket.id);

      assert.strictEqual(result, true);
    });

    it("should return false when ticket has no active session", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test" });
      const session = sessionStore.createSession({ projectId, ticketId: ticket.id });
      sessionStore.endSession(session.id);

      const result = sessionStore.hasActiveSession(ticket.id);

      assert.strictEqual(result, false);
    });

    it("should return true when brainstorm has active session", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);
      sessionStore.createSession({ projectId, brainstormId: brainstorm.id });

      const result = sessionStore.hasActiveSession(undefined, brainstorm.id);

      assert.strictEqual(result, true);
    });
  });

  describe("getLatestClaudeSessionId", () => {
    it("should return null when no sessions", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);
      const result = sessionStore.getLatestClaudeSessionId(brainstorm.id);
      assert.strictEqual(result, null);
    });

    it("should return null when no claude session ID set", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);
      sessionStore.createSession({ projectId, brainstormId: brainstorm.id });

      const result = sessionStore.getLatestClaudeSessionId(brainstorm.id);

      assert.strictEqual(result, null);
    });

    it("should return latest claude session ID", () => {
      const brainstorm = brainstormStore.createBrainstorm(projectId);

      sessionStore.createSession({
        projectId,
        brainstormId: brainstorm.id,
        claudeSessionId: "claude_first",
      });
      sessionStore.createSession({
        projectId,
        brainstormId: brainstorm.id,
        claudeSessionId: "claude_second",
      });

      const result = sessionStore.getLatestClaudeSessionId(brainstorm.id);

      assert.strictEqual(result, "claude_second");
    });
  });

  describe("endAllOpenSessions", () => {
    it("endAllOpenSessions marks open sessions as ended", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "T-stale" });
      sessionStore.createSession({ ticketId: ticket.id, projectId });
      assert.notEqual(sessionStore.getActiveSessionForTicket(ticket.id), null);
      const count = sessionStore.endAllOpenSessions();
      assert.ok(count >= 1);
      assert.equal(sessionStore.getActiveSessionForTicket(ticket.id), null);
    });
  });

  describe("getLatestClaudeSessionIdForTicket", () => {
    it("should return null when no sessions exist for ticket", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test Ticket" });
      const result = sessionStore.getLatestClaudeSessionIdForTicket(ticket.id);
      assert.strictEqual(result, null);
    });

    it("should return the claude session id from the latest session", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test Ticket 2" });
      const session = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        claudeSessionId: "claude_sess_abc",
        agentSource: "test",
      });
      const result = sessionStore.getLatestClaudeSessionIdForTicket(ticket.id);
      assert.strictEqual(result, "claude_sess_abc");
    });

    it("should return the most recent claude session id", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Test Ticket 3" });
      const oldSession = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        claudeSessionId: "claude_sess_old",
        agentSource: "test",
      });
      sessionStore.endSession(oldSession.id);
      sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        claudeSessionId: "claude_sess_new",
        agentSource: "test",
      });
      const result = sessionStore.getLatestClaudeSessionIdForTicket(ticket.id);
      assert.strictEqual(result, "claude_sess_new");
    });
  });

  describe("getRecentSessionsForContinuity", () => {
    it("filters by ticket, phase, agent source, and execution generation", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Continuity ticket" });
      const otherTicket = ticketStore.createTicket(projectId, { title: "Other ticket" });

      const first = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        phase: "Build",
        agentSource: "agents/build.md",
        executionGeneration: 5,
      });
      sessionStore.endSession(first.id);
      const second = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        phase: "Build",
        agentSource: "agents/review.md",
        executionGeneration: 5,
      });
      sessionStore.endSession(second.id);
      const third = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        phase: "Refinement",
        agentSource: "agents/build.md",
        executionGeneration: 5,
      });
      sessionStore.endSession(third.id);
      sessionStore.createSession({
        projectId,
        ticketId: otherTicket.id,
        phase: "Build",
        agentSource: "agents/build.md",
        executionGeneration: 5,
      });

      const sessions = sessionStore.getRecentSessionsForContinuity(
        ticket.id,
        {
          phase: "Build",
          agentSource: "agents/build.md",
          executionGeneration: 5,
        },
        10
      );

      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].ticketId, ticket.id);
      assert.strictEqual(sessions[0].phase, "Build");
      assert.strictEqual(sessions[0].agentSource, "agents/build.md");
      assert.strictEqual(sessions[0].executionGeneration, 5);
    });

    it("returns most-recent sessions first with bounded limit", () => {
      const ticket = ticketStore.createTicket(projectId, { title: "Ordering ticket" });
      const first = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        phase: "Build",
      });
      sessionStore.endSession(first.id);
      const second = sessionStore.createSession({
        projectId,
        ticketId: ticket.id,
        phase: "Build",
      });

      db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(
        "2026-03-11T00:00:01.000Z",
        first.id
      );
      db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(
        "2026-03-11T00:00:02.000Z",
        second.id
      );

      const sessions = sessionStore.getRecentSessionsForContinuity(
        ticket.id,
        { phase: "Build" },
        1
      );

      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].id, second.id);
    });
  });

  describe("updateSessionTokens", () => {
    it("should update input and output tokens", () => {
      const created = sessionStore.createSession({ projectId });

      const result = sessionStore.updateSessionTokens(created.id, 1000, 500);

      assert.strictEqual(result, true);

      const session = sessionStore.getSession(created.id)!;
      assert.strictEqual(session.inputTokens, 1000);
      assert.strictEqual(session.outputTokens, 500);
    });

    it("should return false for non-existent session", () => {
      const result = sessionStore.updateSessionTokens("non-existent", 1000, 500);
      assert.strictEqual(result, false);
    });

    it("should preserve zero token counts", () => {
      const created = sessionStore.createSession({ projectId });
      sessionStore.updateSessionTokens(created.id, 0, 0);
      const session = sessionStore.getSession(created.id)!;
      assert.strictEqual(session.inputTokens, 0);
      assert.strictEqual(session.outputTokens, 0);
    });
  });

  describe("sessions table has input_tokens and output_tokens columns", () => {
    it("should have input_tokens column", () => {
      const info = db.prepare("PRAGMA table_info(sessions)").all() as Array<{name: string}>;
      const columns = info.map(r => r.name);
      assert.ok(columns.includes("input_tokens"), "missing input_tokens");
    });

    it("should have output_tokens column", () => {
      const info = db.prepare("PRAGMA table_info(sessions)").all() as Array<{name: string}>;
      const columns = info.map(r => r.name);
      assert.ok(columns.includes("output_tokens"), "missing output_tokens");
    });
  });
});
