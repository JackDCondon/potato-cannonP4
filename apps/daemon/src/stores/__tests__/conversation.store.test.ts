import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import { createProjectStore } from "../project.store.js";
import {
  createConversationStore,
  ConversationStore,
} from "../conversation.store.js";

describe("ConversationStore", () => {
  let db: Database.Database;
  let store: ConversationStore;
  let testDbPath: string;
  let projectId: string;

  before(() => {
    testDbPath = path.join(os.tmpdir(), `potato-conv-test-${Date.now()}.db`);
    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);

    const projectStore = createProjectStore(db);
    const project = projectStore.createProject({
      displayName: "Test Project",
      path: "/test/project",
    });
    projectId = project.id;

    store = createConversationStore(db);
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
    db.prepare("DELETE FROM conversation_messages").run();
    db.prepare("DELETE FROM conversations").run();
  });

  describe("createConversation", () => {
    it("should create a conversation with UUID", () => {
      const conv = store.createConversation(projectId);

      assert.ok(conv.id);
      assert.strictEqual(conv.projectId, projectId);
      assert.ok(conv.createdAt);
      assert.ok(conv.updatedAt);
    });
  });

  describe("getConversation", () => {
    it("should return null for non-existent conversation", () => {
      const conv = store.getConversation("non-existent");
      assert.strictEqual(conv, null);
    });

    it("should return conversation by ID", () => {
      const created = store.createConversation(projectId);
      const conv = store.getConversation(created.id);

      assert.ok(conv);
      assert.strictEqual(conv.id, created.id);
    });
  });

  describe("addMessage", () => {
    it("should add a message to conversation", () => {
      const conv = store.createConversation(projectId);
      const msg = store.addMessage(conv.id, {
        type: "question",
        text: "What color?",
        options: ["Red", "Blue"],
      });

      assert.ok(msg.id);
      assert.strictEqual(msg.conversationId, conv.id);
      assert.strictEqual(msg.type, "question");
      assert.strictEqual(msg.text, "What color?");
      assert.deepStrictEqual(msg.options, ["Red", "Blue"]);
      assert.strictEqual(msg.answeredAt, undefined);
    });

    it("should update conversation updatedAt", () => {
      const conv = store.createConversation(projectId);
      const originalUpdatedAt = conv.updatedAt;

      // Small delay to ensure different timestamp
      store.addMessage(conv.id, { type: "notification", text: "Hello" });

      const updated = store.getConversation(conv.id)!;
      assert.ok(updated.updatedAt >= originalUpdatedAt);
    });

    it("should add message with metadata", () => {
      const conv = store.createConversation(projectId);
      const msg = store.addMessage(conv.id, {
        type: "question",
        text: "Pick one",
        metadata: { phase: "Refinement", source: "agent" },
      });

      assert.deepStrictEqual(msg.metadata, {
        phase: "Refinement",
        source: "agent",
      });
    });

    it("should persist continuity provenance metadata fields", () => {
      const conv = store.createConversation(projectId);
      const msg = store.addMessage(conv.id, {
        type: "question",
        text: "Need more detail?",
        metadata: {
          phase: "Build",
          executionGeneration: 4,
          agentSource: "worker:builder",
          sourceSessionId: "sess_123",
          messageOrigin: "agent",
        },
      });

      assert.deepStrictEqual(msg.metadata, {
        phase: "Build",
        executionGeneration: 4,
        agentSource: "worker:builder",
        sourceSessionId: "sess_123",
        messageOrigin: "agent",
      });
    });
  });

  describe("getMessages", () => {
    it("should return empty array for no messages", () => {
      const conv = store.createConversation(projectId);
      const messages = store.getMessages(conv.id);
      assert.deepStrictEqual(messages, []);
    });

    it("should return messages in order", () => {
      const conv = store.createConversation(projectId);
      store.addMessage(conv.id, { type: "question", text: "First?" });
      store.addMessage(conv.id, { type: "user", text: "Answer" });
      store.addMessage(conv.id, { type: "notification", text: "Done" });

      const messages = store.getMessages(conv.id);

      assert.strictEqual(messages.length, 3);
      assert.strictEqual(messages[0].text, "First?");
      assert.strictEqual(messages[1].text, "Answer");
      assert.strictEqual(messages[2].text, "Done");
    });
  });

  describe("getMessagesForContinuity", () => {
    it("filters by phase", () => {
      const conv = store.createConversation(projectId);
      store.addMessage(conv.id, {
        type: "question",
        text: "Refinement question",
        metadata: { phase: "Refinement", executionGeneration: 1 },
      });
      store.addMessage(conv.id, {
        type: "question",
        text: "Build question",
        metadata: { phase: "Build", executionGeneration: 1 },
      });

      const messages = store.getMessagesForContinuity(
        conv.id,
        { phase: "Build" },
        10
      );

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].text, "Build question");
    });

    it("filters by execution generation", () => {
      const conv = store.createConversation(projectId);
      store.addMessage(conv.id, {
        type: "user",
        text: "Gen 1 context",
        metadata: { phase: "Build", executionGeneration: 1 },
      });
      store.addMessage(conv.id, {
        type: "user",
        text: "Gen 2 context",
        metadata: { phase: "Build", executionGeneration: 2 },
      });

      const messages = store.getMessagesForContinuity(
        conv.id,
        { executionGeneration: 2 },
        10
      );

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].text, "Gen 2 context");
    });

    it("filters by agent source when present", () => {
      const conv = store.createConversation(projectId);
      store.addMessage(conv.id, {
        type: "question",
        text: "Builder message",
        metadata: {
          phase: "Build",
          executionGeneration: 1,
          agentSource: "agents/build.md",
        },
      });
      store.addMessage(conv.id, {
        type: "question",
        text: "Verifier message",
        metadata: {
          phase: "Build",
          executionGeneration: 1,
          agentSource: "agents/review.md",
        },
      });

      const messages = store.getMessagesForContinuity(
        conv.id,
        { phase: "Build", agentSource: "agents/build.md" },
        10
      );

      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].text, "Builder message");
    });

    it("returns most recent matching messages but emits oldest to newest", () => {
      const conv = store.createConversation(projectId);
      const first = store.addMessage(conv.id, {
        type: "user",
        text: "first",
        metadata: { phase: "Build", executionGeneration: 3 },
      });
      const second = store.addMessage(conv.id, {
        type: "user",
        text: "second",
        metadata: { phase: "Build", executionGeneration: 3 },
      });
      const third = store.addMessage(conv.id, {
        type: "user",
        text: "third",
        metadata: { phase: "Build", executionGeneration: 3 },
      });

      db.prepare("UPDATE conversation_messages SET timestamp = ? WHERE id = ?").run(
        "2026-03-11T00:00:01.000Z",
        first.id
      );
      db.prepare("UPDATE conversation_messages SET timestamp = ? WHERE id = ?").run(
        "2026-03-11T00:00:02.000Z",
        second.id
      );
      db.prepare("UPDATE conversation_messages SET timestamp = ? WHERE id = ?").run(
        "2026-03-11T00:00:03.000Z",
        third.id
      );

      const messages = store.getMessagesForContinuity(
        conv.id,
        { phase: "Build", executionGeneration: 3 },
        2
      );

      assert.deepStrictEqual(
        messages.map((m) => m.text),
        ["second", "third"]
      );
    });
  });

  describe("getPendingQuestion", () => {
    it("should return null when no pending questions", () => {
      const conv = store.createConversation(projectId);
      const pending = store.getPendingQuestion(conv.id);
      assert.strictEqual(pending, null);
    });

    it("should return unanswered question", () => {
      const conv = store.createConversation(projectId);
      store.addMessage(conv.id, { type: "question", text: "Pick one?" });

      const pending = store.getPendingQuestion(conv.id);

      assert.ok(pending);
      assert.strictEqual(pending.text, "Pick one?");
      assert.strictEqual(pending.answeredAt, undefined);
    });

    it("should return null after question is answered", () => {
      const conv = store.createConversation(projectId);
      const msg = store.addMessage(conv.id, { type: "question", text: "Pick?" });

      store.answerQuestion(msg.id);

      const pending = store.getPendingQuestion(conv.id);
      assert.strictEqual(pending, null);
    });

    it("should return most recent pending question", () => {
      const conv = store.createConversation(projectId);
      const first = store.addMessage(conv.id, {
        type: "question",
        text: "First question?",
      });
      store.answerQuestion(first.id);
      store.addMessage(conv.id, { type: "question", text: "Second question?" });

      const pending = store.getPendingQuestion(conv.id);

      assert.ok(pending);
      assert.strictEqual(pending.text, "Second question?");
    });
  });

  describe("answerQuestion", () => {
    it("should set answeredAt timestamp", () => {
      const conv = store.createConversation(projectId);
      const msg = store.addMessage(conv.id, { type: "question", text: "Pick?" });

      const result = store.answerQuestion(msg.id);

      assert.strictEqual(result, true);

      const updated = store.getMessage(msg.id)!;
      assert.ok(updated.answeredAt);
    });

    it("should return false for non-existent message", () => {
      const result = store.answerQuestion("non-existent");
      assert.strictEqual(result, false);
    });
  });

  describe("deleteConversation", () => {
    it("should delete conversation and cascade messages", () => {
      const conv = store.createConversation(projectId);
      store.addMessage(conv.id, { type: "notification", text: "Hello" });

      const deleted = store.deleteConversation(conv.id);

      assert.strictEqual(deleted, true);
      assert.strictEqual(store.getConversation(conv.id), null);
      assert.deepStrictEqual(store.getMessages(conv.id), []);
    });
  });
});
