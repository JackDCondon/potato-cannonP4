export type ContinuityMode = "resume" | "handoff" | "fresh";

export type ContinuityReason =
  | "suspended_session_resume"
  | "restart_snapshot"
  | "same_lifecycle_resume"
  | "resume_not_allowed"
  | "packet_available"
  | "packet_unavailable"
  | "disabled"
  | "default_fallback"
  | "ralph_retry_resume";

export type ContinuityPacketScope =
  | "same_lifecycle"
  | "safe_user_context_only";

export interface ContinuityPacketTurn {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: string;
  sourceSessionId?: string;
}

export interface ContinuityPacketHighlight {
  summary: string;
  timestamp?: string;
  sourceSessionId?: string;
}

export interface ContinuityPacket {
  scope: ContinuityPacketScope;
  reasonForRestart?: string;
  conversationTurns: ContinuityPacketTurn[];
  sessionHighlights: ContinuityPacketHighlight[];
  unresolvedQuestions: string[];
}

export interface ContinuityDecision {
  mode: ContinuityMode;
  reason: ContinuityReason;
  scope?: ContinuityPacketScope;
  packet?: ContinuityPacket;
  sourceSessionId?: string;
}

export interface ContinuityCompatibilityKey {
  ticketId: string;
  phase: string;
  agentSource: string;
  executionGeneration: number;
  workflowId: string;
  worktreePath: string;
  branchName: string;
  agentDefinitionPromptHash: string;
  mcpServerNames: string[];
  model: string;
  disallowedTools: string[];
}

export interface SessionContinuityMetadata {
  continuityMode?: ContinuityMode;
  continuityReason?: ContinuityReason;
  continuityScope?: ContinuityPacketScope;
  continuitySummary?: string;
  continuitySourceSessionId?: string;
  continuityCompatibility?: ContinuityCompatibilityKey;
}
