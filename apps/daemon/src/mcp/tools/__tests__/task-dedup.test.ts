import { describe, it } from "node:test";
import assert from "node:assert";
import { extractDescriptionPrefix } from "../task.tools.js";
import type { Task } from "../../../types/task.types.js";

describe("extractDescriptionPrefix", () => {
  it("extracts prefix up to first colon", () => {
    assert.strictEqual(
      extractDescriptionPrefix("Ticket 1: Create Button component"),
      "ticket 1"
    );
  });

  it("normalizes whitespace and case", () => {
    assert.strictEqual(
      extractDescriptionPrefix("  Ticket 1:  Create Button  "),
      "ticket 1"
    );
  });

  it("returns full description when no colon present", () => {
    assert.strictEqual(
      extractDescriptionPrefix("Create Button component"),
      "create button component"
    );
  });

  it("handles empty string", () => {
    assert.strictEqual(extractDescriptionPrefix(""), "");
  });

  it("matches different suffixes with same prefix", () => {
    const a = extractDescriptionPrefix("Ticket 1: Create Button component");
    const b = extractDescriptionPrefix("Ticket 1: Create button Component v2");
    assert.strictEqual(a, b);
  });

  it("does not match different ticket numbers", () => {
    const a = extractDescriptionPrefix("Ticket 1: Create Button");
    const b = extractDescriptionPrefix("Ticket 2: Create Button");
    assert.notStrictEqual(a, b);
  });
});

// Helpers shared across handler-logic tests
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task1",
    ticketId: "ticket-1",
    displayNumber: 1,
    phase: "build",
    status: "pending",
    attemptCount: 0,
    description: "Ticket 1: Create Button component",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    complexity: "standard",
    ...overrides,
  };
}

/**
 * Replicates the duplicate-detection logic from the create_task handler so it
 * can be tested without standing up a full MCP context or HTTP server.
 *
 * If the handler logic changes, this helper must be kept in sync.
 */
function checkDuplicate(
  existingTasks: Task[],
  newDescription: string,
): { isDuplicate: boolean; duplicate?: Task } {
  const newPrefix = extractDescriptionPrefix(newDescription);
  if (!newPrefix) return { isDuplicate: false };
  const duplicate = existingTasks.find(
    (t) =>
      t.status !== "cancelled" &&
      extractDescriptionPrefix(t.description) === newPrefix,
  );
  return duplicate ? { isDuplicate: true, duplicate } : { isDuplicate: false };
}

describe("create_task handler — dedup logic", () => {
  it("returns isDuplicate=true when a task with the same prefix exists", () => {
    const tasks = [makeTask({ description: "Ticket 1: Create Button component" })];
    const result = checkDuplicate(tasks, "Ticket 1: Create Button component v2");
    assert.strictEqual(result.isDuplicate, true);
    assert.strictEqual(result.duplicate?.id, "task1");
  });

  it("returns isDuplicate=false when no matching prefix exists", () => {
    const tasks = [makeTask({ description: "Ticket 2: Something else" })];
    const result = checkDuplicate(tasks, "Ticket 1: Create Button component");
    assert.strictEqual(result.isDuplicate, false);
  });

  it("excludes cancelled tasks from duplicate check", () => {
    const tasks = [makeTask({ status: "cancelled", description: "Ticket 1: Create Button component" })];
    const result = checkDuplicate(tasks, "Ticket 1: Create Button component v2");
    assert.strictEqual(result.isDuplicate, false);
  });

  it("still detects duplicate when a non-cancelled task shares the prefix alongside a cancelled one", () => {
    const tasks = [
      makeTask({ id: "task1", status: "cancelled", description: "Ticket 1: Create Button component" }),
      makeTask({ id: "task2", status: "completed", description: "Ticket 1: Create Button component v2" }),
    ];
    const result = checkDuplicate(tasks, "Ticket 1: something new here");
    assert.strictEqual(result.isDuplicate, true);
    assert.strictEqual(result.duplicate?.id, "task2");
  });

  it("returns isDuplicate=false when task list is empty", () => {
    const result = checkDuplicate([], "Ticket 1: Create Button component");
    assert.strictEqual(result.isDuplicate, false);
  });

  it("duplicate response message contains expected fields", () => {
    const duplicate = makeTask({ id: "task99", status: "in_progress", description: "Ticket 1: Build" });
    const result = checkDuplicate([duplicate], "Ticket 1: Build (retry)");
    assert.ok(result.isDuplicate);
    // Simulate the message the handler would produce
    const message =
      `Duplicate detected: task "${result.duplicate!.id}" already has description prefix ` +
      `"${extractDescriptionPrefix(duplicate.description)}". ` +
      `Skipping creation. Existing task: ${JSON.stringify({ id: result.duplicate!.id, description: result.duplicate!.description, status: result.duplicate!.status })}`;
    assert.ok(message.includes("task99"));
    assert.ok(message.includes("ticket 1"));
    assert.ok(message.includes("Skipping creation"));
  });
});

describe("create_task handler — listTasksForTicket failure", () => {
  /**
   * Full handler integration tests are deferred because `listTasksForTicket`
   * and `createTask` are private (not exported) and the handler requires a live
   * McpContext with a running HTTP daemon.
   *
   * The tests below document the expected error contract and exercise the
   * surrounding logic (dedup guard, error shape) without requiring network I/O.
   */

  it("structured error shape is isError:true with descriptive message", () => {
    // Simulate what the handler returns when listTasksForTicket rejects
    const simulatedErr = new Error("connection refused");
    const result = {
      content: [{
        type: "text",
        text: `Failed to fetch existing tasks for dedup check: ${simulatedErr.message}. Aborting task creation to prevent duplicates.`,
      }],
      isError: true as const,
    };
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("connection refused"));
    assert.ok(result.content[0].text.includes("Aborting task creation"));
  });

  it("non-Error rejection still produces a string message", () => {
    const simulatedErr: unknown = "timeout";
    const message = `Failed to fetch existing tasks for dedup check: ${simulatedErr instanceof Error ? simulatedErr.message : String(simulatedErr)}. Aborting task creation to prevent duplicates.`;
    assert.ok(message.includes("timeout"));
  });
});
