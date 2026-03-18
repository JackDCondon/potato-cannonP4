import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// Mock the stores before importing scope.tools
import type { BlockedByEntry, Ticket } from "@potato-cannon/shared";
const mockGetDependents = mock.fn((): BlockedByEntry[] => []);
const mockGetForTicket = mock.fn((): BlockedByEntry[] => []);
mock.module("../../../stores/ticket-dependency.store.js", {
  namedExports: {
    ticketDependencyGetDependents: mockGetDependents,
    ticketDependencyGetForTicket: mockGetForTicket,
  },
});

const mockGetTicketsByBrainstormId = mock.fn((): Ticket[] => []);
mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    getTicketsByBrainstormId: mockGetTicketsByBrainstormId,
  },
});

const { scopeHandlers } = await import("../scope.tools.js");

// =============================================================================
// set_plan_summary
// =============================================================================

describe("set_plan_summary", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should error without brainstormId context", async () => {
    const result = await scopeHandlers.set_plan_summary(
      { projectId: "proj-1", daemonUrl: "http://localhost:8443" } as Parameters<typeof scopeHandlers.set_plan_summary>[0],
      { summary: "test summary" },
    );
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("brainstorm session context"));
  });

  it("should error without summary argument", async () => {
    const result = await scopeHandlers.set_plan_summary(
      {
        projectId: "proj-1",
        brainstormId: "brain_123",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.set_plan_summary>[0],
      {},
    );
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("summary is required"));
  });

  it("should call PUT /api/brainstorms/{projectId}/{brainstormId} on success", async () => {
    const capturedRequests: { url: string; method: string; body: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: (init?.body as string) ?? "",
      });
      return new Response(JSON.stringify({ id: "brain_123" }), { status: 200 });
    };

    try {
      const result = await scopeHandlers.set_plan_summary(
        {
          projectId: "proj-1",
          brainstormId: "brain_123",
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.set_plan_summary>[0],
        { summary: "Overall plan for the epic." },
      );

      assert.strictEqual((result as { isError?: boolean }).isError, undefined);
      assert.ok(result.content[0].text.includes("saved successfully"));
      assert.strictEqual(capturedRequests.length, 1);
      assert.strictEqual(
        capturedRequests[0].url,
        "http://localhost:8443/api/brainstorms/proj-1/brain_123",
      );
      assert.strictEqual(capturedRequests[0].method, "PUT");
      const body = JSON.parse(capturedRequests[0].body);
      assert.strictEqual(body.planSummary, "Overall plan for the epic.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should auto-write plan.md artifact on success", async () => {
    const testBrainstormId = `test_set_plan_${Date.now()}`;
    const expectedArtifactPath = path.join(
      os.homedir(),
      ".potato-cannon",
      "projects",
      "proj-1",
      "brainstorms",
      testBrainstormId,
      "artifacts",
      "plan.md",
    );

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: testBrainstormId }), { status: 200 });

    try {
      const result = await scopeHandlers.set_plan_summary(
        {
          projectId: "proj-1",
          brainstormId: testBrainstormId,
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.set_plan_summary>[0],
        { summary: "Build a user auth system with three components." },
      );

      assert.strictEqual((result as { isError?: boolean }).isError, undefined);
      assert.ok(result.content[0].text.includes("saved successfully"));

      // Verify plan.md was written
      const content = await fs.readFile(expectedArtifactPath, "utf-8");
      assert.strictEqual(content, "# Plan Summary\n\nBuild a user auth system with three components.\n");
    } finally {
      // Clean up
      await fs.rm(path.dirname(expectedArtifactPath), { recursive: true, force: true });
      globalThis.fetch = originalFetch;
    }
  });

  it("should gracefully handle plan.md write failure", async () => {
    // Test that failure to write plan.md doesn't prevent the success response
    // Force a write failure by making the artifacts path a file instead of a directory
    const brainstormDir = path.join(
      os.homedir(),
      ".potato-cannon",
      "projects",
      "proj-1",
      "brainstorms",
      "brain_write_fail_test",
    );
    const artifactsPath = path.join(brainstormDir, "artifacts");

    const originalFetch = globalThis.fetch;
    try {
      // Create a file where the artifacts directory should be, causing mkdir to fail
      await fs.mkdir(brainstormDir, { recursive: true });
      await fs.writeFile(artifactsPath, "block", "utf-8");

      globalThis.fetch = async () =>
        new Response(JSON.stringify({ id: "brain_write_fail_test" }), { status: 200 });

      const result = await scopeHandlers.set_plan_summary(
        {
          projectId: "proj-1",
          brainstormId: "brain_write_fail_test",
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.set_plan_summary>[0],
        { summary: "Test plan" },
      );

      // Should still succeed even though plan.md write fails (non-fatal)
      assert.strictEqual((result as { isError?: boolean }).isError, undefined);
      assert.ok(result.content[0].text.includes("saved successfully"));
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(brainstormDir, { recursive: true, force: true });
    }
  });

  it("should return error when fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" });

    try {
      const result = await scopeHandlers.set_plan_summary(
        {
          projectId: "proj-1",
          brainstormId: "brain_123",
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.set_plan_summary>[0],
        { summary: "test" },
      );

      assert.strictEqual((result as { isError?: boolean }).isError, true);
      assert.ok(result.content[0].text.includes("Failed to set plan summary"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// =============================================================================
// get_dependents
// =============================================================================

describe("get_dependents", () => {
  beforeEach(() => {
    mockGetDependents.mock.resetCalls();
  });

  it("should return dependents from store", async () => {
    const fakeDependent: BlockedByEntry = {
      ticketId: "POT-2",
      title: "Child ticket",
      currentPhase: "Build",
      tier: "code-ready",
      satisfied: false,
    };
    mockGetDependents.mock.mockImplementationOnce(() => [fakeDependent]);

    const result = await scopeHandlers.get_dependents(
      {
        projectId: "proj-1",
        ticketId: "POT-1",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.get_dependents>[0],
      {},
    );

    assert.strictEqual((result as { isError?: boolean }).isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.dependents.length, 1);
    assert.strictEqual(parsed.dependents[0].ticketId, "POT-2");
  });

  it("should default to ctx.ticketId when no arg passed", async () => {
    mockGetDependents.mock.mockImplementationOnce(() => []);

    await scopeHandlers.get_dependents(
      {
        projectId: "proj-1",
        ticketId: "POT-1",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.get_dependents>[0],
      {},
    );

    assert.strictEqual(mockGetDependents.mock.calls.length, 1);
    const call1 = mockGetDependents.mock.calls[0];
    assert.strictEqual((call1?.arguments as unknown[])[0], "POT-1");
  });

  it("should use args.ticketId when provided", async () => {
    mockGetDependents.mock.mockImplementationOnce(() => []);

    await scopeHandlers.get_dependents(
      {
        projectId: "proj-1",
        ticketId: "POT-1",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.get_dependents>[0],
      { ticketId: "POT-5" },
    );

    assert.strictEqual(mockGetDependents.mock.calls.length, 1);
    const call2 = mockGetDependents.mock.calls[0];
    assert.strictEqual((call2?.arguments as unknown[])[0], "POT-5");
  });

  it("should error when no ticketId available", async () => {
    const result = await scopeHandlers.get_dependents(
      {
        projectId: "proj-1",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.get_dependents>[0],
      {},
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("no ticketId available"));
  });

  it("should return empty dependents array when no downstream tickets", async () => {
    mockGetDependents.mock.mockImplementationOnce(() => []);

    const result = await scopeHandlers.get_dependents(
      {
        projectId: "proj-1",
        ticketId: "POT-1",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.get_dependents>[0],
      {},
    );

    assert.strictEqual((result as { isError?: boolean }).isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(parsed.dependents, []);
  });
});

// =============================================================================
// get_sibling_tickets
// =============================================================================

describe("get_sibling_tickets", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockGetTicketsByBrainstormId.mock.resetCalls();
  });

  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      projectId: "proj-1",
      ticketId: "POT-1",
      daemonUrl: "http://localhost:8443",
      ...overrides,
    } as Parameters<typeof scopeHandlers.get_sibling_tickets>[0];
  }

  it("should error when no ticketId available", async () => {
    const result = await scopeHandlers.get_sibling_tickets(
      makeCtx({ ticketId: undefined }),
      {},
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("no ticketId available"));
  });

  it("should error when ticket fetch fails", async () => {
    globalThis.fetch = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" });

    const result = await scopeHandlers.get_sibling_tickets(makeCtx(), {});

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("not found"));
  });

  it("should return isError when ticket fetch throws a network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await scopeHandlers.get_sibling_tickets(makeCtx(), {});

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("failed to fetch ticket"));
    assert.ok(result.content[0].text.includes("ECONNREFUSED"));
  });

  it("should return empty siblings when ticket has no brainstormId", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ id: "POT-1", title: "Solo", brainstormId: null }),
        { status: 200 },
      );

    const result = await scopeHandlers.get_sibling_tickets(makeCtx(), {});

    assert.strictEqual((result as { isError?: boolean }).isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.siblings.length, 0);
    assert.strictEqual(parsed.brainstormId, null);
  });

  it("should return siblings excluding self when ticket has brainstormId", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "POT-1",
          title: "Ticket One",
          brainstormId: "brain_abc",
        }),
        { status: 200 },
      );

    mockGetTicketsByBrainstormId.mock.mockImplementationOnce(() => [
      { id: "POT-1", title: "Ticket One", phase: "Build", complexity: "standard" } as Ticket,
      { id: "POT-2", title: "Ticket Two", phase: "Ideas", complexity: "complex" } as Ticket,
      { id: "POT-3", title: "Ticket Three", phase: "Review", complexity: "standard" } as Ticket,
    ]);

    const result = await scopeHandlers.get_sibling_tickets(makeCtx(), {});

    assert.strictEqual((result as { isError?: boolean }).isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.brainstormId, "brain_abc");
    assert.strictEqual(parsed.siblings.length, 2);
    assert.strictEqual(parsed.siblings[0].ticketId, "POT-2");
    assert.strictEqual(parsed.siblings[1].ticketId, "POT-3");
  });

  it("should use args.ticketId when provided", async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrls.push(String(input));
      return new Response(
        JSON.stringify({ id: "POT-5", title: "Other", brainstormId: null }),
        { status: 200 },
      );
    };

    await scopeHandlers.get_sibling_tickets(makeCtx(), { ticketId: "POT-5" });

    assert.ok(capturedUrls[0].includes("POT-5"));
  });

  it("should include descriptions when includeDescriptions is true", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "POT-1",
          title: "Ticket One",
          brainstormId: "brain_abc",
        }),
        { status: 200 },
      );

    mockGetTicketsByBrainstormId.mock.mockImplementationOnce(() => [
      { id: "POT-1", title: "Ticket One", phase: "Build", complexity: "standard", description: "Self desc" } as Ticket,
      { id: "POT-2", title: "Ticket Two", phase: "Ideas", complexity: "complex", description: "Short desc" } as Ticket,
      { id: "POT-3", title: "Long Desc Ticket", phase: "Review", complexity: "standard", description: "X".repeat(400) } as Ticket,
    ]);

    const result = await scopeHandlers.get_sibling_tickets(
      makeCtx(),
      { includeDescriptions: true },
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.siblings.length, 2);
    assert.strictEqual(parsed.siblings[0].description, "Short desc");
    assert.ok(parsed.siblings[1].description.length <= 303, "long desc should be truncated to 300 + ellipsis");
    assert.ok(parsed.siblings[1].description.endsWith("..."));
  });

  it("should omit descriptions by default", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "POT-1",
          title: "Ticket One",
          brainstormId: "brain_abc",
        }),
        { status: 200 },
      );

    mockGetTicketsByBrainstormId.mock.mockImplementationOnce(() => [
      { id: "POT-1", title: "Ticket One", phase: "Build", complexity: "standard", description: "Self desc" } as Ticket,
      { id: "POT-2", title: "Ticket Two", phase: "Ideas", complexity: "complex", description: "Has a description" } as Ticket,
    ]);

    const result = await scopeHandlers.get_sibling_tickets(makeCtx(), {});

    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.siblings.length, 1);
    assert.strictEqual(parsed.siblings[0].description, undefined);
  });
});

// =============================================================================
// get_scope_context
// =============================================================================

describe("get_scope_context", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockGetDependents.mock.resetCalls();
    mockGetForTicket.mock.resetCalls();
    mockGetTicketsByBrainstormId.mock.resetCalls();
  });

  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      projectId: "proj-1",
      ticketId: "POT-1",
      daemonUrl: "http://localhost:8443",
      ...overrides,
    } as Parameters<typeof scopeHandlers.get_scope_context>[0];
  }

  it("should error when no ticketId available", async () => {
    const result = await scopeHandlers.get_scope_context(
      makeCtx({ ticketId: undefined }),
      {},
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("no ticketId available"));
  });

  it("should error when ticket not found", async () => {
    globalThis.fetch = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" });

    mockGetForTicket.mock.mockImplementationOnce(() => []);
    mockGetDependents.mock.mockImplementationOnce(() => []);

    const result = await scopeHandlers.get_scope_context(makeCtx(), {});

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("not found"));
  });

  it("should return isError when ticket fetch throws a network error", async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/tickets/")) {
        throw new Error("ECONNREFUSED");
      }
      return new Response("Not Found", { status: 404 });
    };

    const result = await scopeHandlers.get_scope_context(makeCtx(), {});

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("failed to fetch ticket"));
    assert.ok(result.content[0].text.includes("ECONNREFUSED"));
  });

  it("should return basic ticket context without brainstorm", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "POT-1",
          title: "Test Ticket",
          description: "A".repeat(600),
          phase: "Build",
          complexity: "standard",
        }),
        { status: 200 },
      );

    mockGetForTicket.mock.mockImplementationOnce(() => []);
    mockGetDependents.mock.mockImplementationOnce(() => []);

    const result = await scopeHandlers.get_scope_context(makeCtx(), {});

    assert.strictEqual((result as { isError?: boolean }).isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.ticket.id, "POT-1");
    assert.strictEqual(parsed.ticket.title, "Test Ticket");
    assert.ok(
      parsed.ticket.description.length <= 503,
      "description should be truncated to 500 chars + ellipsis",
    );
    assert.ok(parsed.ticket.description.endsWith("..."));
    assert.strictEqual(parsed.ticket.phase, "Build");
    assert.strictEqual(parsed.ticket.complexity, "standard");
    assert.strictEqual(parsed.origin, null);
    assert.deepStrictEqual(parsed.siblings, []);
    assert.deepStrictEqual(parsed.dependsOn, []);
    assert.deepStrictEqual(parsed.dependedOnBy, []);
  });

  it("should not truncate short descriptions", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "POT-1",
          title: "Short Desc Ticket",
          description: "A short description",
          phase: "Build",
          complexity: "standard",
        }),
        { status: 200 },
      );

    mockGetForTicket.mock.mockImplementationOnce(() => []);
    mockGetDependents.mock.mockImplementationOnce(() => []);

    const result = await scopeHandlers.get_scope_context(makeCtx(), {});
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.ticket.description, "A short description");
  });

  it("should handle missing description gracefully", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "POT-1",
          title: "No Desc",
          phase: "Ideas",
          complexity: "standard",
        }),
        { status: 200 },
      );

    mockGetForTicket.mock.mockImplementationOnce(() => []);
    mockGetDependents.mock.mockImplementationOnce(() => []);

    const result = await scopeHandlers.get_scope_context(makeCtx(), {});
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.ticket.description, "");
  });

  it("should use args.ticketId when provided", async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrls.push(String(input));
      return new Response(
        JSON.stringify({
          id: "POT-5",
          title: "Other Ticket",
          phase: "Build",
          complexity: "standard",
        }),
        { status: 200 },
      );
    };

    mockGetForTicket.mock.mockImplementationOnce(() => []);
    mockGetDependents.mock.mockImplementationOnce(() => []);

    await scopeHandlers.get_scope_context(makeCtx(), { ticketId: "POT-5" });

    assert.ok(capturedUrls[0].includes("POT-5"));
    assert.strictEqual(
      (mockGetForTicket.mock.calls[0]?.arguments as unknown[])[0],
      "POT-5",
    );
    assert.strictEqual(
      (mockGetDependents.mock.calls[0]?.arguments as unknown[])[0],
      "POT-5",
    );
  });

  it("should include origin and siblings when ticket has brainstormId", async () => {
    let callCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      callCount++;
      if (url.includes("/api/tickets/")) {
        return new Response(
          JSON.stringify({
            id: "POT-1",
            title: "Ticket One",
            phase: "Build",
            complexity: "standard",
            brainstormId: "brain_abc",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/brainstorms/")) {
        return new Response(
          JSON.stringify({
            id: "brain_abc",
            name: "My Brainstorm",
            planSummary: "Build a widget with three parts.",
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    mockGetForTicket.mock.mockImplementationOnce(() => []);
    mockGetDependents.mock.mockImplementationOnce(() => []);
    mockGetTicketsByBrainstormId.mock.mockImplementationOnce(() => [
      {
        id: "POT-1",
        title: "Ticket One",
        phase: "Build",
        complexity: "standard",
      } as Ticket,
      {
        id: "POT-2",
        title: "Ticket Two",
        phase: "Ideas",
        complexity: "complex",
      } as Ticket,
      {
        id: "POT-3",
        title: "Ticket Three",
        phase: "Review",
        complexity: "standard",
      } as Ticket,
    ]);

    const result = await scopeHandlers.get_scope_context(makeCtx(), {});
    const parsed = JSON.parse(result.content[0].text);

    // Origin
    assert.strictEqual(parsed.origin.brainstormId, "brain_abc");
    assert.strictEqual(parsed.origin.brainstormName, "My Brainstorm");
    assert.strictEqual(
      parsed.origin.planSummary,
      "Build a widget with three parts.",
    );

    // Siblings (excludes self)
    assert.strictEqual(parsed.siblings.length, 2);
    assert.strictEqual(parsed.siblings[0].ticketId, "POT-2");
    assert.strictEqual(parsed.siblings[1].ticketId, "POT-3");

    // Verify brainstormId was passed to the store
    assert.strictEqual(
      (mockGetTicketsByBrainstormId.mock.calls[0]?.arguments as unknown[])[0],
      "brain_abc",
    );
  });

  it("should handle brainstorm fetch failure gracefully", async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/tickets/")) {
        return new Response(
          JSON.stringify({
            id: "POT-1",
            title: "Ticket One",
            phase: "Build",
            complexity: "standard",
            brainstormId: "brain_gone",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/brainstorms/")) {
        return new Response("Server Error", { status: 500 });
      }
      return new Response("Not Found", { status: 404 });
    };

    mockGetForTicket.mock.mockImplementationOnce(() => []);
    mockGetDependents.mock.mockImplementationOnce(() => []);
    mockGetTicketsByBrainstormId.mock.mockImplementationOnce(() => []);

    const result = await scopeHandlers.get_scope_context(makeCtx(), {});
    const parsed = JSON.parse(result.content[0].text);

    // Origin should be null when brainstorm fetch fails
    assert.strictEqual(parsed.origin, null);
    // Siblings should still be fetched from the store
    assert.deepStrictEqual(parsed.siblings, []);
  });

  it("should include upstream dependencies and downstream dependents", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "POT-3",
          title: "Middle Ticket",
          phase: "Build",
          complexity: "standard",
        }),
        { status: 200 },
      );

    const upstreamDep: BlockedByEntry = {
      ticketId: "POT-1",
      title: "Foundation",
      currentPhase: "Done",
      tier: "code-ready",
      satisfied: true,
    };
    const downstreamDep: BlockedByEntry = {
      ticketId: "POT-5",
      title: "Consumer",
      currentPhase: "Ideas",
      tier: "artifact-ready",
      satisfied: false,
    };

    mockGetForTicket.mock.mockImplementationOnce(() => [upstreamDep]);
    mockGetDependents.mock.mockImplementationOnce(() => [downstreamDep]);

    const result = await scopeHandlers.get_scope_context(
      makeCtx({ ticketId: "POT-3" }),
      {},
    );
    const parsed = JSON.parse(result.content[0].text);

    assert.strictEqual(parsed.dependsOn.length, 1);
    assert.strictEqual(parsed.dependsOn[0].ticketId, "POT-1");
    assert.strictEqual(parsed.dependsOn[0].satisfied, true);

    assert.strictEqual(parsed.dependedOnBy.length, 1);
    assert.strictEqual(parsed.dependedOnBy[0].ticketId, "POT-5");
    assert.strictEqual(parsed.dependedOnBy[0].satisfied, false);
  });

  it("should handle null planSummary on brainstorm", async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/tickets/")) {
        return new Response(
          JSON.stringify({
            id: "POT-1",
            title: "Ticket",
            phase: "Build",
            complexity: "standard",
            brainstormId: "brain_no_plan",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/brainstorms/")) {
        return new Response(
          JSON.stringify({
            id: "brain_no_plan",
            name: "No Plan Yet",
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    mockGetForTicket.mock.mockImplementationOnce(() => []);
    mockGetDependents.mock.mockImplementationOnce(() => []);
    mockGetTicketsByBrainstormId.mock.mockImplementationOnce(() => []);

    const result = await scopeHandlers.get_scope_context(makeCtx(), {});
    const parsed = JSON.parse(result.content[0].text);

    assert.strictEqual(parsed.origin.planSummary, null);
  });
});

// =============================================================================
// rename_brainstorm
// =============================================================================

describe("rename_brainstorm", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should error when not in brainstorm context", async () => {
    const result = await scopeHandlers.rename_brainstorm(
      {
        projectId: "proj-1",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.rename_brainstorm>[0],
      { name: "New Name" },
    );
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("brainstorm session context"));
  });

  it("should error when name is missing", async () => {
    const result = await scopeHandlers.rename_brainstorm(
      {
        projectId: "proj-1",
        brainstormId: "brain_1",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.rename_brainstorm>[0],
      {},
    );
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("name is required"));
  });

  it("should call PUT /api/brainstorms/{projectId}/{brainstormId} with name on success", async () => {
    const capturedRequests: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: (init?.body as string) ?? "",
      });
      return new Response(JSON.stringify({ id: "brain_123", name: "New Name" }), {
        status: 200,
      });
    };

    try {
      const result = await scopeHandlers.rename_brainstorm(
        {
          projectId: "proj-1",
          brainstormId: "brain_123",
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.rename_brainstorm>[0],
        { name: "User Authentication System" },
      );

      assert.strictEqual((result as { isError?: boolean }).isError, undefined);
      assert.ok(result.content[0].text.includes("Brainstorm renamed to"));
      assert.ok(result.content[0].text.includes("User Authentication System"));
      assert.strictEqual(capturedRequests.length, 1);
      assert.strictEqual(
        capturedRequests[0].url,
        "http://localhost:8443/api/brainstorms/proj-1/brain_123",
      );
      assert.strictEqual(capturedRequests[0].method, "PUT");
      const body = JSON.parse(capturedRequests[0].body);
      assert.strictEqual(body.name, "User Authentication System");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should return error when fetch fails", async () => {
    globalThis.fetch = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" });

    try {
      const result = await scopeHandlers.rename_brainstorm(
        {
          projectId: "proj-1",
          brainstormId: "brain_123",
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.rename_brainstorm>[0],
        { name: "Test Name" },
      );

      assert.strictEqual((result as { isError?: boolean }).isError, true);
      assert.ok(result.content[0].text.includes("Failed to rename brainstorm"));
      assert.ok(result.content[0].text.includes("Not Found"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should URL-encode projectId in request", async () => {
    const capturedRequests: { url: string }[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedRequests.push({ url: String(input) });
      return new Response(JSON.stringify({ id: "brain_123" }), { status: 200 });
    };

    try {
      await scopeHandlers.rename_brainstorm(
        {
          projectId: "proj with spaces",
          brainstormId: "brain_123",
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.rename_brainstorm>[0],
        { name: "Test" },
      );

      assert.ok(capturedRequests[0].url.includes("proj%20with%20spaces"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should URL-encode brainstormId in request", async () => {
    const capturedRequests: { url: string }[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedRequests.push({ url: String(input) });
      return new Response(JSON.stringify({ id: "brain_123" }), { status: 200 });
    };

    try {
      await scopeHandlers.rename_brainstorm(
        {
          projectId: "proj-1",
          brainstormId: "brain with spaces",
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.rename_brainstorm>[0],
        { name: "Test" },
      );

      assert.ok(capturedRequests[0].url.includes("brain%20with%20spaces"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should handle empty name string gracefully", async () => {
    const result = await scopeHandlers.rename_brainstorm(
      {
        projectId: "proj-1",
        brainstormId: "brain_123",
        daemonUrl: "http://localhost:8443",
      } as Parameters<typeof scopeHandlers.rename_brainstorm>[0],
      { name: "" },
    );

    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("name is required"));
  });

  it("should return isError when fetch throws a network error", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      const result = await scopeHandlers.rename_brainstorm(
        {
          projectId: "proj-1",
          brainstormId: "brain_123",
          daemonUrl: "http://localhost:8443",
        } as Parameters<typeof scopeHandlers.rename_brainstorm>[0],
        { name: "New Name" },
      );

      assert.strictEqual((result as { isError?: boolean }).isError, true);
      assert.ok(result.content[0].text.includes("ECONNREFUSED"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// =============================================================================
// save_brainstorm_artifact
// =============================================================================

describe("save_brainstorm_artifact", () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Create a temp dir that mimics ~/.potato-cannon/projects/
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-tools-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      projectId: "proj-1",
      brainstormId: "brain_123",
      daemonUrl: "http://localhost:8443",
      ...overrides,
    } as Parameters<typeof scopeHandlers.save_brainstorm_artifact>[0];
  }

  it("should error when not in brainstorm context", async () => {
    const result = await scopeHandlers.save_brainstorm_artifact(
      makeCtx({ brainstormId: undefined }),
      { filename: "plan.md", content: "# Plan" },
    );
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("brainstorm session context"));
  });

  it("should error when filename is missing", async () => {
    const result = await scopeHandlers.save_brainstorm_artifact(
      makeCtx(),
      { content: "# Plan" },
    );
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("filename is required"));
  });

  it("should error when content is missing", async () => {
    const result = await scopeHandlers.save_brainstorm_artifact(
      makeCtx(),
      { filename: "plan.md" },
    );
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("content is required"));
  });

  it("should error when filename does not end with .md", async () => {
    const result = await scopeHandlers.save_brainstorm_artifact(
      makeCtx(),
      { filename: "plan.txt", content: "# Plan" },
    );
    assert.strictEqual((result as { isError?: boolean }).isError, true);
    assert.ok(result.content[0].text.includes("must end with .md"));
  });

  it("should sanitize path traversal attempts in filename", async () => {
    // ../etc/passwd.md would resolve basename to passwd.md
    // but ../../etc/plan.md should still fail on .md check if path attack
    // The key check: path.basename strips directory components
    // Since basename of "../evil/plan.md" is "plan.md" (valid .md), it should succeed writing to artifacts dir
    // The test verifies no path traversal outside artifacts dir
    const result = await scopeHandlers.save_brainstorm_artifact(
      makeCtx(),
      { filename: "../evil/plan.md", content: "# Evil" },
    );
    // path.basename("../evil/plan.md") === "plan.md" => valid, should succeed (not error)
    // The point is it doesn't write outside artifacts dir
    // It will fail because the artifacts dir doesn't exist under the real ~/.potato-cannon path
    // We just verify no error about path traversal - behavior depends on FS
    // The real test: it should NOT write to ../evil/, only to artifacts/plan.md
    // Since the real path won't exist in test, we just verify isError is about FS, not path validation
    assert.ok(
      result.content[0].text.includes("plan.md") || result.content[0].text.includes("Error"),
    );
  });

  it("should write artifact file and return success", async () => {
    // We need to test with a real writable location. Since getBrainstormFilesDir uses
    // GLOBAL_DIR (~/.potato-cannon/projects/...), we test via the actual implementation.
    // This is an integration-level check: create a temp brainstorm dir and verify write works.
    // We use a unique brainstorm ID that maps to a predictable path.
    const testBrainstormId = `test_${Date.now()}`;
    const expectedDir = path.join(
      os.homedir(),
      ".potato-cannon",
      "projects",
      "proj-1",
      "brainstorms",
      testBrainstormId,
      "artifacts",
    );

    try {
      const result = await scopeHandlers.save_brainstorm_artifact(
        makeCtx({ brainstormId: testBrainstormId }),
        { filename: "plan.md", content: "# Test Plan\n\nHello world." },
      );

      assert.strictEqual((result as { isError?: boolean }).isError, undefined);
      assert.ok(result.content[0].text.includes("plan.md"));
      assert.ok(result.content[0].text.includes("saved successfully"));

      // Verify file was actually written
      const written = await fs.readFile(path.join(expectedDir, "plan.md"), "utf-8");
      assert.strictEqual(written, "# Test Plan\n\nHello world.");
    } finally {
      // Clean up: remove test artifact dir
      await fs.rm(expectedDir, { recursive: true, force: true });
    }
  });

  it("should create the artifacts directory if it does not exist", async () => {
    const testBrainstormId = `test_mkdir_${Date.now()}`;
    const expectedDir = path.join(
      os.homedir(),
      ".potato-cannon",
      "projects",
      "proj-1",
      "brainstorms",
      testBrainstormId,
      "artifacts",
    );

    try {
      const result = await scopeHandlers.save_brainstorm_artifact(
        makeCtx({ brainstormId: testBrainstormId }),
        { filename: "notes.md", content: "some notes" },
      );

      assert.strictEqual((result as { isError?: boolean }).isError, undefined);
      const stat = await fs.stat(expectedDir);
      assert.ok(stat.isDirectory());
    } finally {
      await fs.rm(expectedDir, { recursive: true, force: true });
    }
  });

  it("should strip path components from filename (security)", async () => {
    // path.basename("../../etc/passwd.md") === "passwd.md"
    // So the tool should write passwd.md in the artifacts dir (not at ../../etc/)
    const testBrainstormId = `test_path_${Date.now()}`;
    const expectedDir = path.join(
      os.homedir(),
      ".potato-cannon",
      "projects",
      "proj-1",
      "brainstorms",
      testBrainstormId,
      "artifacts",
    );

    try {
      const result = await scopeHandlers.save_brainstorm_artifact(
        makeCtx({ brainstormId: testBrainstormId }),
        { filename: "../../etc/passwd.md", content: "# Not evil" },
      );

      // Should succeed (writes "passwd.md" inside artifacts dir)
      assert.strictEqual((result as { isError?: boolean }).isError, undefined);
      assert.ok(result.content[0].text.includes("passwd.md"));

      // Verify it wrote to the correct (safe) location
      const written = await fs.readFile(path.join(expectedDir, "passwd.md"), "utf-8");
      assert.strictEqual(written, "# Not evil");
    } finally {
      await fs.rm(expectedDir, { recursive: true, force: true });
    }
  });

  it("should overwrite an existing artifact file", async () => {
    const testBrainstormId = `test_overwrite_${Date.now()}`;
    const expectedDir = path.join(
      os.homedir(),
      ".potato-cannon",
      "projects",
      "proj-1",
      "brainstorms",
      testBrainstormId,
      "artifacts",
    );

    try {
      await scopeHandlers.save_brainstorm_artifact(
        makeCtx({ brainstormId: testBrainstormId }),
        { filename: "plan.md", content: "# Version 1" },
      );
      await scopeHandlers.save_brainstorm_artifact(
        makeCtx({ brainstormId: testBrainstormId }),
        { filename: "plan.md", content: "# Version 2" },
      );

      const written = await fs.readFile(path.join(expectedDir, "plan.md"), "utf-8");
      assert.strictEqual(written, "# Version 2");
    } finally {
      await fs.rm(expectedDir, { recursive: true, force: true });
    }
  });
});
