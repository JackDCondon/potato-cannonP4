import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../../stores/migrations.js";
import { createSessionStore } from "../../stores/session.store.js";
import { createProjectStore } from "../../stores/project.store.js";
import { createTicketStore } from "../../stores/ticket.store.js";
import { SESSIONS_DIR } from "../../config/paths.js";
import {
  continuityFromMetadata,
  continuityFromSessionLog,
} from "./sessions.routes.js";

describe("GET /api/projects/:projectId/tickets/:ticketId/sessions — store-level integration", () => {
  let db: Database.Database;
  let testDbPath: string;
  let projectId: string;
  let ticketId: string;

  before(() => {
    testDbPath = path.join(
      os.tmpdir(),
      `potato-test-sessions-routes-${Date.now()}.db`
    );
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Test Project",
      path: "/test/project",
    });
    projectId = project.id;

    const ticketStore = createTicketStore(db);
    const ticket = ticketStore.createTicket(projectId, {
      title: "Test Ticket",
      description: "A test ticket for sessions",
    });
    ticketId = ticket.id;
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
    db.prepare("DELETE FROM sessions").run();
  });

  describe("getSessionsByTicket — the store query backing the route", () => {
    it("returns empty array when no sessions exist for the ticket", () => {
      const sessionStore = createSessionStore(db);
      const sessions = sessionStore.getSessionsByTicket(ticketId);
      assert.deepStrictEqual(sessions, []);
    });

    it("returns sessions ordered by startedAt ascending", () => {
      const sessionStore = createSessionStore(db);

      // Insert two sessions with explicit started_at via raw SQL to control ordering
      const id1 = "session-early-" + Date.now();
      const id2 = "session-late-" + Date.now();
      db.prepare(`
        INSERT INTO sessions (id, project_id, ticket_id, started_at)
        VALUES (?, ?, ?, ?)
      `).run(id1, projectId, ticketId, "2026-01-01T10:00:00.000Z");
      db.prepare(`
        INSERT INTO sessions (id, project_id, ticket_id, started_at)
        VALUES (?, ?, ?, ?)
      `).run(id2, projectId, ticketId, "2026-01-01T11:00:00.000Z");

      const sessions = sessionStore.getSessionsByTicket(ticketId);
      assert.strictEqual(sessions.length, 2);
      assert.strictEqual(sessions[0].id, id1);
      assert.strictEqual(sessions[1].id, id2);
    });

    it("does not return sessions belonging to a different ticket", () => {
      const sessionStore = createSessionStore(db);

      // Create a second ticket
      const ticketStore = createTicketStore(db);
      const otherTicket = ticketStore.createTicket(projectId, {
        title: "Other Ticket",
        description: "Another ticket",
      });

      // Create session for our ticket
      const mySession = sessionStore.createSession({
        projectId,
        ticketId,
        agentSource: "agents/refinement.md",
      });

      // Create session for the other ticket
      sessionStore.createSession({
        projectId,
        ticketId: otherTicket.id,
        agentSource: "agents/build.md",
      });

      const sessions = sessionStore.getSessionsByTicket(ticketId);
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].id, mySession.id);
    });
  });

  describe("status derivation logic (route handler behavior)", () => {
    it("derives 'running' status when endedAt is absent", () => {
      const sessionStore = createSessionStore(db);
      const session = sessionStore.createSession({ projectId, ticketId });

      // Simulate the route's status derivation
      const status = !session.endedAt
        ? "running"
        : session.exitCode === 0 || session.exitCode == null
          ? "completed"
          : "failed";

      assert.strictEqual(status, "running");
    });

    it("derives 'completed' status when endedAt is set and exitCode is 0", () => {
      const sessionStore = createSessionStore(db);
      const session = sessionStore.createSession({ projectId, ticketId });
      sessionStore.endSession(session.id, 0);

      const ended = sessionStore.getSession(session.id);
      assert.ok(ended);

      const status = !ended.endedAt
        ? "running"
        : ended.exitCode === 0 || ended.exitCode == null
          ? "completed"
          : "failed";

      assert.strictEqual(status, "completed");
    });

    it("derives 'failed' status when endedAt is set and exitCode is non-zero", () => {
      const sessionStore = createSessionStore(db);
      const session = sessionStore.createSession({ projectId, ticketId });
      sessionStore.endSession(session.id, 1);

      const ended = sessionStore.getSession(session.id);
      assert.ok(ended);

      const status = !ended.endedAt
        ? "running"
        : ended.exitCode === 0 || ended.exitCode == null
          ? "completed"
          : "failed";

      assert.strictEqual(status, "failed");
    });

    it("derives 'completed' status when endedAt is set and exitCode is null/undefined", () => {
      const sessionStore = createSessionStore(db);
      const session = sessionStore.createSession({ projectId, ticketId });
      sessionStore.endSession(session.id);

      const ended = sessionStore.getSession(session.id);
      assert.ok(ended);

      const status = !ended.endedAt
        ? "running"
        : ended.exitCode === 0 || ended.exitCode == null
          ? "completed"
          : "failed";

      assert.strictEqual(status, "completed");
    });
  });

  describe("StoredSession shape", () => {
    it("session record includes expected fields", () => {
      const sessionStore = createSessionStore(db);
      const session = sessionStore.createSession({
        projectId,
        ticketId,
        agentSource: "agents/refinement.md",
        phase: "refinement",
      });

      assert.ok(session.id);
      assert.strictEqual(session.projectId, projectId);
      assert.strictEqual(session.ticketId, ticketId);
      assert.strictEqual(session.agentSource, "agents/refinement.md");
      assert.strictEqual(session.phase, "refinement");
      assert.ok(session.startedAt);
      assert.strictEqual(session.endedAt, undefined);
      assert.strictEqual(session.exitCode, undefined);
    });
  });

  describe("continuity projection helpers", () => {
    it("prefers continuity fields from session metadata", () => {
      const continuity = continuityFromMetadata({
        continuityMode: "handoff",
        continuityReason: "packet_available",
        continuityScope: "same_lifecycle",
        continuitySummary: "handoff(same_lifecycle): turns=1, highlights=1, questions=0",
        continuitySourceSessionId: "claude_prev_1",
        continuityCompatibility: { ticketId: "hidden" },
      });

      assert.deepStrictEqual(continuity, {
        continuityMode: "handoff",
        continuityReason: "packet_available",
        continuityScope: "same_lifecycle",
        continuitySummary: "handoff(same_lifecycle): turns=1, highlights=1, questions=0",
        continuitySourceSessionId: "claude_prev_1",
      });
    });

    it("falls back to continuity fields from session_start log metadata", async () => {
      await fs.promises.mkdir(SESSIONS_DIR, { recursive: true });
      const sessionId = `sess_route_${Date.now()}`;
      const logPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
      await fs.promises.writeFile(
        logPath,
        [
          JSON.stringify({
            type: "session_start",
            meta: {
              projectId: projectId,
              ticketId,
              continuityMode: "fresh",
              continuityReason: "packet_unavailable",
              continuitySummary: "fresh(packet_unavailable)",
            },
            timestamp: new Date().toISOString(),
          }),
        ].join("\n"),
      );

      const continuity = await continuityFromSessionLog(sessionId);
      assert.strictEqual(continuity.continuityMode, "fresh");
      assert.strictEqual(continuity.continuityReason, "packet_unavailable");
      assert.strictEqual(
        continuity.continuitySummary,
        "fresh(packet_unavailable)",
      );

      await fs.promises.unlink(logPath);
    });
  });
});
