import type { PmConfig } from "@potato-cannon/shared";
import { getBoardPmConfig } from "../../stores/board-settings.store.js";

interface PmConfigCarrier {
  workflowId?: string | null;
  pmConfig?: PmConfig | null;
}

export function resolveEffectivePmConfig(
  brainstorm: PmConfigCarrier,
): PmConfig | null {
  if (!brainstorm.workflowId) {
    return brainstorm.pmConfig ?? null;
  }

  const workflowDefaults = getBoardPmConfig(brainstorm.workflowId);
  if (!brainstorm.pmConfig) {
    return workflowDefaults;
  }

  return {
    ...workflowDefaults,
    ...brainstorm.pmConfig,
    polling: {
      ...workflowDefaults.polling,
      ...brainstorm.pmConfig.polling,
    },
    alerts: {
      ...workflowDefaults.alerts,
      ...brainstorm.pmConfig.alerts,
    },
  };
}
