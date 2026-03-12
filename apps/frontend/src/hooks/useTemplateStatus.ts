// src/hooks/useTemplateStatus.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export interface TemplateStatus {
  current: string | null;
  available: string | null;
  upgradeType: "major" | "minor" | "patch" | null;
}

export function useTemplateStatus(projectId: string | undefined, workflowId: string | undefined) {
  return useQuery({
    queryKey: ["template-status", projectId, workflowId],
    queryFn: async (): Promise<TemplateStatus> => {
      if (!projectId || !workflowId) {
        return { current: null, available: null, upgradeType: null };
      }
      return api.getWorkflowTemplateStatus(projectId, workflowId);
    },
    enabled: !!projectId && !!workflowId,
    staleTime: 30000, // Check every 30 seconds
  });
}

export function useUpgradeTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      workflowId,
      force,
    }: {
      projectId: string;
      workflowId: string;
      force?: boolean;
    }) => {
      return api.upgradeWorkflowTemplate(projectId, workflowId, force);
    },
    onSuccess: (_, { projectId, workflowId }) => {
      queryClient.invalidateQueries({ queryKey: ["template-status", projectId, workflowId] });
      queryClient.invalidateQueries({ queryKey: ["workflow-template-status", projectId, workflowId] });
      queryClient.invalidateQueries({ queryKey: ["workflow-template-changelog", projectId, workflowId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
