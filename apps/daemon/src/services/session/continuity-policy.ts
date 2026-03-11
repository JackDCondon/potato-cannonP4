import type { ContinuityCompatibilityKey } from "./continuity.types.js";

export interface ResumeEligibilityInput {
  stored?: ContinuityCompatibilityKey;
  current?: ContinuityCompatibilityKey;
  claudeSessionId?: string | null;
  lifecycleInvalidated?: boolean;
}

export interface ResumeEligibilityResult {
  eligible: boolean;
  reason:
    | "eligible"
    | "missing_claude_session_id"
    | "lifecycle_invalidated"
    | "missing_compatibility_key"
    | "compatibility_mismatch";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCompleteCompatibilityKey(
  key: ContinuityCompatibilityKey | undefined
): key is ContinuityCompatibilityKey {
  if (!key) return false;
  return (
    isNonEmptyString(key.ticketId) &&
    isNonEmptyString(key.phase) &&
    isNonEmptyString(key.agentSource) &&
    Number.isFinite(key.executionGeneration) &&
    isNonEmptyString(key.workflowId) &&
    isNonEmptyString(key.worktreePath) &&
    isNonEmptyString(key.branchName) &&
    isNonEmptyString(key.agentDefinitionPromptHash) &&
    Array.isArray(key.mcpServerNames) &&
    Array.isArray(key.disallowedTools) &&
    isNonEmptyString(key.model)
  );
}

function arraysExactlyMatch(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function evaluateResumeEligibility(
  input: ResumeEligibilityInput
): ResumeEligibilityResult {
  if (!isNonEmptyString(input.claudeSessionId)) {
    return { eligible: false, reason: "missing_claude_session_id" };
  }

  if (input.lifecycleInvalidated) {
    return { eligible: false, reason: "lifecycle_invalidated" };
  }

  if (
    !hasCompleteCompatibilityKey(input.stored) ||
    !hasCompleteCompatibilityKey(input.current)
  ) {
    return { eligible: false, reason: "missing_compatibility_key" };
  }

  const stored = input.stored;
  const current = input.current;

  const matches =
    stored.ticketId === current.ticketId &&
    stored.phase === current.phase &&
    stored.agentSource === current.agentSource &&
    stored.executionGeneration === current.executionGeneration &&
    stored.workflowId === current.workflowId &&
    stored.worktreePath === current.worktreePath &&
    stored.branchName === current.branchName &&
    stored.agentDefinitionPromptHash === current.agentDefinitionPromptHash &&
    stored.model === current.model &&
    arraysExactlyMatch(stored.mcpServerNames, current.mcpServerNames) &&
    arraysExactlyMatch(stored.disallowedTools, current.disallowedTools);

  if (!matches) {
    return { eligible: false, reason: "compatibility_mismatch" };
  }

  return { eligible: true, reason: "eligible" };
}
