import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import type { Ticket } from "../../../types/index.js";

const mockUpdateTicket = mock.fn(
  async (
    projectId: string,
    ticketId: string,
    updates: Record<string, unknown>,
  ): Promise<Ticket> => ({
    id: ticketId,
    project: projectId,
    title: (updates.title as string | undefined) ?? "Existing title",
    description: (updates.description as string | undefined) ?? "",
    phase: "Ideas",
    executionGeneration: 0,
    complexity: (updates.complexity as Ticket["complexity"] | undefined) ?? "standard",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
    history: [],
    archived: false,
    paused: false,
    pauseRetryCount: 0,
  }),
);

mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicket: () => ({
      id: "TKT-9",
      project: "proj-1",
      title: "Existing title",
      description: "",
      phase: "Specification Review",
      executionGeneration: 0,
      complexity: "standard",
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z",
      history: [],
      archived: false,
      paused: false,
      pauseRetryCount: 0,
      workflowId: "wf-1",
    }),
    updateTicket: mockUpdateTicket,
  },
});

mock.module("../../../services/session/phase-config.js", {
  namedExports: {
    getPhaseConfig: async (_projectId: string, phaseName: string) => ({
      id: phaseName,
      name: phaseName,
      transitions: {
        manual: phaseName === "Specification Review" || phaseName === "Done",
      },
    }),
  },
});

const { pmTools, pmHandlers } = await import("../pm.tools.js");

describe("pmTools", () => {
  it("marks every PM tool as pm-only", () => {
    const toolNames = pmTools.map((tool: { name: string }) => tool.name).sort();

    assert.deepStrictEqual(toolNames, [
      "move_ticket",
      "set_ticket_complexity",
      "update_ticket",
    ]);
    assert.ok(pmTools.every((tool: { mcpServer?: string }) => tool.mcpServer === "pm"));
  });
});

describe("move_ticket", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls PUT /api/tickets/:project/:id with phase and overrideDependencies", async () => {
    const capturedRequests: Array<{
      url: string;
      method: string;
      headers?: HeadersInit;
      body?: string;
    }> = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ id: "TKT-9", phase: "Review" }), {
        status: 200,
      });
    };

    const result = await pmHandlers.move_ticket(
      { projectId: "proj 1", daemonUrl: "http://localhost:8443" },
      {
        ticketId: "TKT-9",
        targetPhase: "Review",
        overrideDependencies: true,
      },
    );

    assert.strictEqual(capturedRequests.length, 1);
    assert.strictEqual(
      capturedRequests[0].url,
      "http://localhost:8443/api/tickets/proj%201/TKT-9",
    );
    assert.strictEqual(capturedRequests[0].method, "PUT");
    assert.deepStrictEqual(JSON.parse(capturedRequests[0].body ?? "{}"), {
      phase: "Review",
      overrideDependencies: true,
    });
    assert.ok(result.content[0].text.includes("Review"));
  });

  it("returns an error when ticketId is missing", async () => {
    const result = await pmHandlers.move_ticket(
      { projectId: "proj-1", daemonUrl: "http://localhost:8443" },
      { targetPhase: "Review" },
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("ticketId is required"));
  });

  it("returns an error when targetPhase is missing", async () => {
    const result = await pmHandlers.move_ticket(
      { projectId: "proj-1", daemonUrl: "http://localhost:8443" },
      { ticketId: "TKT-9" },
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("targetPhase is required"));
  });

  it("returns an error when the daemon route rejects the move", async () => {
    globalThis.fetch = async () =>
      new Response("blocked", { status: 409, statusText: "Conflict" });

    const result = await pmHandlers.move_ticket(
      { projectId: "proj-1", daemonUrl: "http://localhost:8443" },
      { ticketId: "TKT-9", targetPhase: "Review" },
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("Failed to move ticket"));
    assert.ok(result.content[0].text.includes("Conflict"));
  });

  it("blocks PM brainstorm sessions from moving tickets out of manual phases", async () => {
    const result = await pmHandlers.move_ticket(
      {
        projectId: "proj-1",
        brainstormId: "brain-1",
        workflowId: "wf-1",
        daemonUrl: "http://localhost:8443",
      },
      { ticketId: "TKT-9", targetPhase: "Done" },
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("cannot move ticket TKT-9 out of manual phase"));
  });
});

describe("update_ticket", () => {
  afterEach(() => {
    mockUpdateTicket.mock.resetCalls();
  });

  it("updates title and description through the store", async () => {
    const result = await pmHandlers.update_ticket(
      { projectId: "proj-1", daemonUrl: "http://localhost:8443" },
      {
        ticketId: "TKT-4",
        title: "New title",
        description: "Updated description",
      },
    );

    assert.strictEqual(mockUpdateTicket.mock.calls.length, 1);
    assert.deepStrictEqual(mockUpdateTicket.mock.calls[0].arguments, [
      "proj-1",
      "TKT-4",
      {
        title: "New title",
        description: "Updated description",
      },
    ]);
    assert.ok(result.content[0].text.includes("TKT-4"));
  });

  it("rejects requests that provide no updatable fields", async () => {
    const result = await pmHandlers.update_ticket(
      { projectId: "proj-1", daemonUrl: "http://localhost:8443" },
      { ticketId: "TKT-4" },
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("At least one of title or description is required"));
    assert.strictEqual(mockUpdateTicket.mock.calls.length, 0);
  });
});

describe("set_ticket_complexity", () => {
  afterEach(() => {
    mockUpdateTicket.mock.resetCalls();
  });

  it("updates complexity through the store", async () => {
    const result = await pmHandlers.set_ticket_complexity(
      { projectId: "proj-1", daemonUrl: "http://localhost:8443" },
      { ticketId: "TKT-7", complexity: "complex" },
    );

    assert.strictEqual(mockUpdateTicket.mock.calls.length, 1);
    assert.deepStrictEqual(mockUpdateTicket.mock.calls[0].arguments, [
      "proj-1",
      "TKT-7",
      { complexity: "complex" },
    ]);
    assert.ok(result.content[0].text.includes("complex"));
  });

  it("rejects invalid complexity values", async () => {
    const result = await pmHandlers.set_ticket_complexity(
      { projectId: "proj-1", daemonUrl: "http://localhost:8443" },
      { ticketId: "TKT-7", complexity: "tiny" },
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("complexity must be one of"));
    assert.strictEqual(mockUpdateTicket.mock.calls.length, 0);
  });
});
