import type { Brainstorm } from "@potato-cannon/shared";
import { updateBrainstorm } from "../../stores/brainstorm.store.js";
import { eventBus } from "../../utils/event-bus.js";

/**
 * Transition a brainstorm to PM mode by setting pm_enabled = true.
 * Idempotent: safe to call multiple times on the same brainstorm.
 * Emits brainstorm:updated for SSE reactivity.
 */
export async function transitionToEpicPm(
  projectId: string,
  brainstormId: string,
): Promise<void> {
  const updated = await updateBrainstorm(projectId, brainstormId, {
    pmEnabled: true,
  });
  eventBus.emit("brainstorm:updated", { projectId, brainstorm: updated });
}

/**
 * Returns true when the brainstorm should be handled by the PM skill
 * rather than the standard brainstorm agent.
 */
export function shouldUsePmSkill(brainstorm: Brainstorm): boolean {
  return brainstorm.status === "epic" && brainstorm.pmEnabled === true;
}
