import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useBrainstormArtifacts } from "./queries";

describe("Brainstorm query hooks", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  describe("useBrainstormArtifacts", () => {
    it("should return enabled=false when projectId or brainstormId is null", () => {
      const { result } = renderHook(
        () => useBrainstormArtifacts(null, "brain-123"),
        { wrapper }
      );

      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toBeUndefined();
    });

    it("should return enabled=false when both are null", () => {
      const { result } = renderHook(() => useBrainstormArtifacts(null, null), {
        wrapper,
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toBeUndefined();
    });

    it("should fetch artifacts with correct URL when enabled", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            artifacts: [
              {
                filename: "plan.md",
                content: "# Plan",
                updatedAt: "2026-03-18T10:00:00Z",
              },
            ],
          }),
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(
        () => useBrainstormArtifacts("proj-1", "brain-123"),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/brainstorms/proj-1/brain-123/artifacts",
        expect.any(Object)
      );

      expect(result.current.data).toBeDefined();
      expect(result.current.data?.artifacts).toHaveLength(1);
    });
  });

});
