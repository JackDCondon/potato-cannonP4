import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

// Mock the ticket-dependency store before importing scope.tools
import type { BlockedByEntry } from "@potato-cannon/shared";
const mockGetDependents = mock.fn((): BlockedByEntry[] => []);
mock.module("../../../stores/ticket-dependency.store.js", {
  namedExports: {
    ticketDependencyGetDependents: mockGetDependents,
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
