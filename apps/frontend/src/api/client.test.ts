import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "./client";

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
});
