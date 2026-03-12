import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  api,
  ApiError,
  isStaleTicketInputPayload,
  isTicketLifecycleConflictPayload,
} from "./client";

describe("api client workflow context", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => "{}",
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("passes workflowId when loading phase workers", async () => {
    await api.getPhaseWorkers("project-1", "Solve Issue", "workflow-abc");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "/api/projects/project-1/phases/Solve%20Issue/workers?workflowId=workflow-abc",
    );
  });

  it("passes workflowId when loading default agent prompt", async () => {
    await api.getAgentDefault("project-1", "builder", "workflow-abc");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "/api/projects/project-1/agents/builder/default?workflowId=workflow-abc",
    );
  });

  it("passes workflowId when loading agent override", async () => {
    await api.getAgentOverride("project-1", "builder", "workflow-abc");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "/api/projects/project-1/agents/builder/override?workflowId=workflow-abc",
    );
  });

  it("passes workflowId when deleting agent override", async () => {
    await api.deleteAgentOverride("project-1", "builder", "workflow-abc");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "/api/projects/project-1/agents/builder/override?workflowId=workflow-abc",
    );
  });

  it("passes question identity and generation when sending ticket input", async () => {
    await api.sendTicketInput("project-1", "POT-1", "yes", {
      questionId: "q-123",
      ticketGeneration: 8,
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.body).toContain('"questionId":"q-123"');
    expect(options.body).toContain('"ticketGeneration":8');
  });

  it("throws typed stale-input ApiError payload for 409 responses", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          code: "STALE_TICKET_INPUT",
          message: "stale",
          reason: "generation_mismatch",
          currentGeneration: 9,
          retryable: false,
        }),
    });

    try {
      await api.sendTicketInput("project-1", "POT-1", "yes");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.status).toBe(409);
      expect(isStaleTicketInputPayload(apiError.payload)).toBe(true);
      return;
    }

    throw new Error("Expected ApiError to be thrown");
  });

  it("narrows lifecycle conflict payloads", () => {
    expect(
      isTicketLifecycleConflictPayload({
        code: "TICKET_LIFECYCLE_CONFLICT",
        currentPhase: "Build",
        currentGeneration: 3,
        message: "conflict",
        retryable: true,
      }),
    ).toBe(true);
  });
});
