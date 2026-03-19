import fs from "fs/promises";
import { createWriteStream, createReadStream, writeFileSync, unlinkSync } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import pty from "node-pty";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";

import { SESSIONS_DIR } from "../../config/paths.js";
import { eventBus } from "../../utils/event-bus.js";
import { resolveNode, resolveClaude } from "../../utils/resolve-executable.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  getTicket,
  listTicketImages,
  updateTicket,
} from "../../stores/ticket.store.js";
import { getDatabase } from "../../stores/db.js";
import { getProjectById } from "../../stores/project.store.js";
import { getBrainstorm, brainstormGetDirect } from "../../stores/brainstorm.store.js";
import {
  createStoredSession,
  endStoredSession,
  getLatestClaudeSessionId,
  getLatestClaudeSessionIdForTicket,
  getRecentSessionsForContinuity,
  updateClaudeSessionId,
  getActiveSessionForBrainstorm,
  getActiveSessionForTicket,
  getSessionsByTicket,
} from "../../stores/session.store.js";
import {
  addMessage,
  getMessages,
  getMessagesForContinuity,
  updateMessageMetadata,
} from "../../stores/conversation.store.js";
import {
  DEFAULT_LIFECYCLE_CONTINUITY_CONFIG,
  getConfigStore,
  loadGlobalConfig,
} from "../../stores/config.store.js";
import {
  readResponse,
  readQuestion,
  clearResponse,
  clearQuestion,
  clearPendingInteraction,
  cancelWaitForResponse,
} from "../../stores/chat.store.js";
import type {
  SessionMeta,
  SessionInfo,
  SessionLogEntry,
} from "../../types/session.types.js";
import type { TicketPhase } from "../../types/ticket.types.js";
import type { AgentWorker } from "../../types/template.types.js";
import type { TaskContext } from "../../types/orchestration.types.js";
import type { GlobalConfig } from "../../types/config.types.js";
import type {
  ContinuityDecision,
  ContinuityPacket,
  ContinuityCompatibilityKey,
  SessionContinuityMetadata,
} from "./continuity.types.js";

import type {
  ActiveSession,
  RemoteControlState,
  PhaseEntryContext,
} from "./types.js";
import { getPhaseConfig, phaseRequiresIsolation, getNextEnabledPhase } from "./phase-config.js";
import { createVCSProvider } from "./vcs/factory.js";
import type { McpServerConfig } from "./vcs/types.js";
import { buildBrainstormPrompt, buildAgentPrompt, buildPmPrompt } from "./prompts.js";
import { shouldUsePmSkill } from "../pm/pm-transition.js";
import { PtyTextExtractor } from "./pty-text-extractor.js";
import { getPtyCaptureDedup, clearPtyCaptureDedup } from "./pty-capture-dedup.js";
import { buildResumePrompt } from "./resume-prompt.js";
import { tryLoadAgentDefinition } from "./agent-loader.js";
import { resolveConcreteModelForWorker } from "./model-tier-resolver.js";
import { logToDaemon, savePrompt } from "./ticket-logger.js";
import {
  startPhase,
  handleAgentCompletion,
  type ExecutorCallbacks,
} from "./worker-executor.js";
import { formatTaskContext } from "./loops/task-loop.js";
import { getPendingVerdict } from "../../server/routes/ralph.routes.js";
import { createSpawnPendingWorkerState } from "./worker-state.js";
import { consumeSpawnPendingContinuitySnapshot } from "./worker-state.js";
import {
  decideContinuityMode,
  type ResumeEligibilityInput,
} from "./continuity-policy.js";
import {
  buildBoundedContinuityPacket,
  type ContinuityPacketLimits,
  type ContinuityPacketFilter,
} from "./continuity-context.service.js";
import { buildRestartSnapshot } from "./continuity-snapshot.service.js";

export class TicketLifecycleConflictError extends Error {
  readonly code = "TICKET_LIFECYCLE_CONFLICT";
  readonly retryable = true;

  constructor(
    public readonly currentPhase: string,
    public readonly currentGeneration: number,
  ) {
    super("Ticket lifecycle changed concurrently");
    this.name = "TicketLifecycleConflictError";
  }
}

export class StaleTicketInputError extends Error {
  readonly code = "STALE_TICKET_INPUT";
  readonly retryable = false;

  constructor(
    public readonly reason: string,
    public readonly currentGeneration: number,
    public readonly providedGeneration?: number,
    public readonly expectedQuestionId?: string,
    public readonly providedQuestionId?: string,
  ) {
    super(reason);
    this.name = "StaleTicketInputError";
  }
}

interface InvalidateTicketLifecycleOptions {
  targetPhase: TicketPhase;
  expectedPhase?: TicketPhase;
  expectedGeneration?: number;
  restartSnapshot?: ContinuityPacket;
}

interface InvalidateTicketLifecycleResult {
  ticket: Awaited<ReturnType<typeof getTicket>>;
  executionGeneration: number;
}

interface ResumeTicketInputIdentity {
  questionId: string;
  ticketGeneration: number;
}

export interface SessionTranscriptHighlight {
  sourceSessionId: string;
  kind: "assistant" | "tool";
  summary: string;
  timestamp?: string;
}

interface BuildContinuityPacketForTicketInput {
  ticketId: string;
  conversationId?: string;
  filter: ContinuityPacketFilter;
  limits: ContinuityPacketLimits;
  reasonForRestart?: string;
  scope: ContinuityPacket["scope"];
}

interface BuildRestartSnapshotInput {
  projectId: string;
  ticketId: string;
  currentPhase: string;
  targetPhase: string;
  executionGeneration: number;
  conversationId?: string;
}

interface DecideContinuityForTicketInput {
  ticketId: string;
  conversationId?: string;
  filter: ContinuityPacketFilter;
  limits: ContinuityPacketLimits;
  resumeEligibility: ResumeEligibilityInput;
  suspendedResumeSessionId?: string | null;
}

interface StoredSessionContinuityMetadata extends Record<string, unknown> {
  continuityMode?: SessionContinuityMetadata["continuityMode"];
  continuityReason?: SessionContinuityMetadata["continuityReason"];
  continuityScope?: SessionContinuityMetadata["continuityScope"];
  continuitySummary?: SessionContinuityMetadata["continuitySummary"];
  continuitySourceSessionId?: SessionContinuityMetadata["continuitySourceSessionId"];
  continuityCompatibility?: ContinuityCompatibilityKey;
}

interface RateLimitInfoLike {
  type?: unknown;
  result?: unknown;
  rate_limit_info?: {
    rateLimitType?: unknown;
    resetsAt?: unknown;
  };
}

/**
 * Build a user-facing rate-limit notice from Claude stream events.
 */
export function extractRateLimitNotice(event: unknown): string | null {
  const candidate = event as RateLimitInfoLike | null;
  if (!candidate || typeof candidate !== "object") return null;

  if (candidate.type === "result" && typeof candidate.result === "string") {
    if (/hit your limit/i.test(candidate.result)) {
      return candidate.result.replace(/\s+/g, " ").trim();
    }
  }

  if (candidate.type !== "rate_limit_event") return null;

  const info = candidate.rate_limit_info;
  const limitType = typeof info?.rateLimitType === "string" ? info.rateLimitType : "usage";
  const resetAt =
    typeof info?.resetsAt === "number"
      ? new Date(info.resetsAt * 1000).toLocaleString()
      : null;

  if (resetAt) {
    return `Claude rate limit reached (${limitType}). Resets at ${resetAt}.`;
  }

  return `Claude rate limit reached (${limitType}).`;
}

interface ResolveWorkerModelInput {
  worker: Pick<AgentWorker, "id" | "source" | "modelTier" | "model">;
  complexity?: TaskContext["complexity"] | null;
  project: { providerOverride?: string | null };
  config: GlobalConfig;
}

export function resolveWorkerModelForSpawn(input: ResolveWorkerModelInput): string | undefined {
  if (input.worker.model !== undefined) {
    throw new Error(
      `Worker "${input.worker.id}" (${input.worker.source}) uses deprecated field "model"; use "modelTier".`,
    );
  }

  const resolved = resolveConcreteModelForWorker({
    modelTier: input.worker.modelTier,
    complexity: input.complexity,
    project: { providerOverride: input.project.providerOverride ?? undefined },
    config: input.config,
  });

  return resolved?.model;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function arraysExactlyMatch(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function compatibilityKeysExactlyMatch(
  left: ContinuityCompatibilityKey | undefined,
  right: ContinuityCompatibilityKey | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.ticketId === right.ticketId &&
    left.phase === right.phase &&
    left.agentSource === right.agentSource &&
    left.executionGeneration === right.executionGeneration &&
    left.workflowId === right.workflowId &&
    left.worktreePath === right.worktreePath &&
    left.branchName === right.branchName &&
    left.agentDefinitionPromptHash === right.agentDefinitionPromptHash &&
    left.model === right.model &&
    arraysExactlyMatch(left.mcpServerNames, right.mcpServerNames) &&
    arraysExactlyMatch(left.disallowedTools, right.disallowedTools)
  );
}

/**
 * Select the Claude session ID that belongs to the current compatibility chain.
 * Prevents using a stale ID from a different phase/agent/generation.
 */
export function resolveStoredContinuityContext(
  sessions: Array<{ claudeSessionId?: string; metadata?: Record<string, unknown> }>,
): {
  storedCompatibility?: ContinuityCompatibilityKey;
  claudeSessionId: string | null;
} {
  const latestSession = sessions.at(0);
  const storedCompatibility =
    latestSession?.metadata &&
    typeof latestSession.metadata === "object"
      ? (latestSession.metadata as StoredSessionContinuityMetadata).continuityCompatibility
      : undefined;

  if (!storedCompatibility) {
    return {
      storedCompatibility: undefined,
      claudeSessionId: null,
    };
  }

  for (const session of sessions) {
    const claudeSessionId = nonEmptyStringOrNull(session.claudeSessionId);
    if (!claudeSessionId) {
      continue;
    }
    const candidateCompatibility =
      session.metadata && typeof session.metadata === "object"
        ? (session.metadata as StoredSessionContinuityMetadata).continuityCompatibility
        : undefined;
    if (compatibilityKeysExactlyMatch(candidateCompatibility, storedCompatibility)) {
      return {
        storedCompatibility,
        claudeSessionId,
      };
    }
  }

  return {
    storedCompatibility,
    claudeSessionId: null,
  };
}

/**
 * Ensure blocked reasons include clear, line-broken quota context for users.
 */
export function formatBlockedReasonWithRateLimit(
  reason: string,
  detectedRateLimit?: string | null,
): string {
  const quotaSuffix =
    "This is a model/account quota limit, not an app failure.";
  let normalized = reason.trim();

  const hasRateLimit = /rate limit|hit your limit/i.test(normalized);

  if (detectedRateLimit && !hasRateLimit) {
    normalized = `${normalized}\n${detectedRateLimit.trim()}`;
  }

  // If the reason already contains a rate-limit sentence, ensure it starts on a new line.
  normalized = normalized.replace(
    /\.\s+(Claude rate limit reached\b)/i,
    ".\n$1",
  );

  if (/rate limit|hit your limit/i.test(normalized) && !/quota limit, not an app failure/i.test(normalized)) {
    normalized = `${normalized}\n${quotaSuffix}`;
  }

  return normalized;
}

export class SessionService {
  private sessions: Map<string, ActiveSession> = new Map();
  private remoteControlState: Map<string, RemoteControlState> = new Map();
  private consumedRestartSnapshots: Map<string, ContinuityPacket> = new Map();
  private rateLimitNoticeByTicket: Map<string, string> = new Map();
  private eventEmitter: EventEmitter;

  constructor(eventEmitter: EventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  private buildContinuityCompatibilityKey(input: {
    ticketId: string;
    phase: string;
    agentSource: string;
    executionGeneration: number;
    workflowId: string;
    worktreePath: string;
    branchName: string;
    agentPrompt: string;
    mcpServerNames: string[];
    model: string;
    disallowedTools: string[];
  }): ContinuityCompatibilityKey {
    return {
      ticketId: input.ticketId,
      phase: input.phase,
      agentSource: input.agentSource,
      executionGeneration: input.executionGeneration,
      workflowId: input.workflowId,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      agentDefinitionPromptHash: crypto
        .createHash("sha256")
        .update(input.agentPrompt)
        .digest("hex"),
      mcpServerNames: [...input.mcpServerNames].sort(),
      model: input.model,
      disallowedTools: [...input.disallowedTools].sort(),
    };
  }

  generateSessionId(): string {
    return `sess_${crypto.randomBytes(8).toString("hex")}`;
  }

  getSessionLogPath(sessionId: string): string {
    return path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  }

  async invalidateTicketLifecycle(
    projectId: string,
    ticketId: string,
    options: InvalidateTicketLifecycleOptions,
  ): Promise<InvalidateTicketLifecycleResult> {
    const db = getDatabase();
    const now = new Date().toISOString();

    const run = db.transaction(() => {
      const current = db
        .prepare(
          `SELECT phase, execution_generation
           FROM tickets
           WHERE id = ? AND project_id = ?`
        )
        .get(ticketId, projectId) as
        | { phase: string; execution_generation: number }
        | undefined;

      if (!current) {
        throw new Error(`Ticket ${ticketId} not found`);
      }

      if (
        (options.expectedPhase !== undefined &&
          current.phase !== options.expectedPhase) ||
        (options.expectedGeneration !== undefined &&
          current.execution_generation !== options.expectedGeneration)
      ) {
        throw new TicketLifecycleConflictError(
          current.phase,
          current.execution_generation,
        );
      }

      const newGeneration = current.execution_generation + 1;
      const workerState = createSpawnPendingWorkerState(
        options.targetPhase,
        newGeneration,
        options.restartSnapshot,
      );

      const result = db
        .prepare(
          `UPDATE tickets
           SET phase = ?, execution_generation = ?, worker_state = ?, updated_at = ?
           WHERE id = ? AND project_id = ? AND phase = ? AND execution_generation = ?`
        )
        .run(
          options.targetPhase,
          newGeneration,
          JSON.stringify(workerState),
          now,
          ticketId,
          projectId,
          current.phase,
          current.execution_generation,
        );

      if (result.changes === 0) {
        const refreshed = db
          .prepare(
            `SELECT phase, execution_generation
             FROM tickets
             WHERE id = ? AND project_id = ?`
          )
          .get(ticketId, projectId) as
          | { phase: string; execution_generation: number }
          | undefined;

        throw new TicketLifecycleConflictError(
          refreshed?.phase ?? current.phase,
          refreshed?.execution_generation ?? current.execution_generation,
        );
      }

      db.prepare(
        `UPDATE ticket_history
         SET exited_at = ?
         WHERE ticket_id = ? AND exited_at IS NULL`
      ).run(now, ticketId);

      db.prepare(
        `INSERT INTO ticket_history (id, ticket_id, phase, entered_at)
         VALUES (?, ?, ?, ?)`
      ).run(crypto.randomUUID(), ticketId, options.targetPhase, now);

      db.prepare(
        `UPDATE sessions
         SET ended_at = ?, exit_code = -1
         WHERE ticket_id = ? AND ended_at IS NULL`
      ).run(now, ticketId);

      return newGeneration;
    });

    const executionGeneration = run();

    cancelWaitForResponse(ticketId);
    await clearPendingInteraction(projectId, ticketId);
    await this.terminateExistingSession("ticket", ticketId, {
      skipDatabaseClose: true,
    });

    const ticket = await getTicket(projectId, ticketId);

    return {
      ticket,
      executionGeneration,
    };
  }

  async listSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];

    // Add active sessions
    for (const [id, session] of this.sessions) {
      sessions.push({
        id,
        projectId: session.meta.projectId,
        ticketId: session.meta.ticketId,
        ticketTitle: session.meta.ticketTitle,
        brainstormId: session.meta.brainstormId,
        brainstormName: session.meta.brainstormName,
        phase: session.meta.phase,
        worktreePath: session.meta.worktreePath,
        branchName: session.meta.branchName,
        startedAt: session.meta.startedAt,
        status: "running",
      });
    }

    // Add recent completed sessions from files
    try {
      const files = await fs.readdir(SESSIONS_DIR);
      for (const file of files) {
        if (file.endsWith(".jsonl")) {
          const sessionId = file.replace(".jsonl", "");
          if (!this.sessions.has(sessionId)) {
            const meta = await this.getSessionMeta(sessionId);
            if (meta) {
              sessions.push({
                id: sessionId,
                projectId: meta.projectId,
                ticketId: meta.ticketId,
                ticketTitle: meta.ticketTitle,
                brainstormId: meta.brainstormId,
                brainstormName: meta.brainstormName,
                phase: meta.phase,
                worktreePath: meta.worktreePath,
                branchName: meta.branchName,
                startedAt: meta.startedAt,
                status: meta.status || "completed",
                exitCode: meta.exitCode,
                endedAt: meta.endedAt,
              });
            }
          }
        }
      }
    } catch {
      // Sessions directory may not exist yet
    }

    return sessions.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }

  async getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    const logPath = this.getSessionLogPath(sessionId);
    try {
      const { first, last } = await this.readFirstAndLastLines(logPath);
      if (first) {
        const startEvent = JSON.parse(first) as SessionLogEntry;
        if (startEvent.type === "session_start" && startEvent.meta) {
          const meta = { ...startEvent.meta };
          // Check if session has ended by examining last line
          if (last && last !== first) {
            try {
              const endEvent = JSON.parse(last) as SessionLogEntry;
              if (endEvent.type === "session_end" && endEvent.meta) {
                meta.status = endEvent.meta.status;
                meta.exitCode = endEvent.meta.exitCode;
                meta.endedAt = endEvent.meta.endedAt;
              }
            } catch {
              // Last line may not be valid JSON
            }
          }
          return meta;
        }
      }
    } catch {
      // Log file may not exist
    }
    return null;
  }

  private async readFirstAndLastLines(
    filePath: string
  ): Promise<{ first: string | null; last: string | null }> {
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream });

    let first: string | null = null;
    let last: string | null = null;

    try {
      for await (const line of rl) {
        if (first === null) {
          first = line;
        }
        last = line;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return { first, last };
  }

  async getSessionLog(sessionId: string): Promise<SessionLogEntry[]> {
    const logPath = this.getSessionLogPath(sessionId);
    let content: string;
    try {
      content = await fs.readFile(logPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`[getSessionLog] Session log not found on disk: ${sessionId}`);
        return [];
      }
      throw err;
    }
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionLogEntry);
  }

  async getTranscriptHighlightsForContinuity(
    sessionId: string,
    maxEvents: number = 20
  ): Promise<SessionTranscriptHighlight[]> {
    const entries = await this.getSessionLog(sessionId);
    const highlights: SessionTranscriptHighlight[] = [];

    for (const entry of entries) {
      const entryAny = entry as unknown as Record<string, unknown>;
      if (entryAny.type === "raw") {
        continue;
      }

      if (typeof entryAny.tool_name === "string") {
        const resultText =
          typeof entryAny.tool_result === "string" ? entryAny.tool_result : "";
        highlights.push({
          sourceSessionId: sessionId,
          kind: "tool",
          summary: `${entryAny.tool_name}: ${resultText}`.trim().slice(0, 240),
          timestamp: entry.timestamp,
        });
        continue;
      }

      const message = entryAny.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      if (entryAny.type === "assistant" && Array.isArray(message?.content)) {
        const textSummary = message.content
          .map((block: Record<string, unknown>) => {
            if (block.type === "text" && typeof block.text === "string") {
              return block.text;
            }
            if (block.type === "tool_use" && block.name) {
              return `tool_use:${block.name}`;
            }
            if (block.type === "tool_result") {
              if (typeof block.content === "string") {
                return `tool_result:${block.content}`;
              }
              return "tool_result";
            }
            return "";
          })
          .filter(Boolean)
          .join(" | ")
          .slice(0, 240);

        if (textSummary.length > 0) {
          highlights.push({
            sourceSessionId: sessionId,
            kind: "assistant",
            summary: textSummary,
            timestamp: entry.timestamp,
          });
        }
      }
    }

    const bounded = Number.isFinite(maxEvents) && maxEvents > 0 ? Math.floor(maxEvents) : 1;
    if (highlights.length <= bounded) {
      return highlights;
    }
    return highlights.slice(highlights.length - bounded);
  }

  async buildContinuityPacketForTicket(
    input: BuildContinuityPacketForTicketInput,
  ): Promise<ContinuityPacket | null> {
    const conversationMessages = input.conversationId
      ? getMessagesForContinuity(input.conversationId, input.filter, input.limits.maxConversationTurns)
      : [];
    const candidateSessions = getRecentSessionsForContinuity(
      input.ticketId,
      input.filter,
      input.limits.maxSessionEvents,
    );

    const transcriptHighlights: SessionTranscriptHighlight[] = [];
    for (const session of candidateSessions) {
      const highlights = await this.getTranscriptHighlightsForContinuity(
        session.id,
        input.limits.maxSessionEvents,
      );
      transcriptHighlights.push(...highlights);
    }

    return buildBoundedContinuityPacket({
      scope: input.scope,
      reasonForRestart: input.reasonForRestart,
      filter: input.filter,
      limits: input.limits,
      conversationMessages,
      transcriptHighlights,
    });
  }

  async buildRestartSnapshotForLifecycleRestart(
    input: BuildRestartSnapshotInput,
  ): Promise<ContinuityPacket | null> {
    const daemonConfig = getConfigStore().getDaemonConfig();
    const lifecycleContinuity = daemonConfig?.lifecycleContinuity ?? {};
    const limits: ContinuityPacketLimits = {
      maxConversationTurns:
        lifecycleContinuity.maxConversationTurns ??
        DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxConversationTurns,
      // Restart snapshots are safe user context only; transcript events are excluded.
      maxSessionEvents: 1,
      maxCharsPerItem:
        lifecycleContinuity.maxCharsPerItem ??
        DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxCharsPerItem,
      maxPromptChars:
        lifecycleContinuity.maxPromptChars ??
        DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxPromptChars,
    };

    const conversationMessages = input.conversationId
      ? getMessages(input.conversationId)
      : [];
    const pendingQuestion = await readQuestion(input.projectId, input.ticketId);
    const pendingResponse = await readResponse(input.projectId, input.ticketId);

    return buildRestartSnapshot({
      projectId: input.projectId,
      ticketId: input.ticketId,
      currentPhase: input.currentPhase,
      targetPhase: input.targetPhase,
      executionGeneration: input.executionGeneration,
      conversationMessages,
      pendingQuestion,
      pendingResponse,
      limits,
    });
  }

  private getLifecycleContinuityLimits(): ContinuityPacketLimits {
    const daemonConfig = getConfigStore().getDaemonConfig();
    const lifecycleContinuity = daemonConfig?.lifecycleContinuity ?? {};
    return {
      maxConversationTurns:
        lifecycleContinuity.maxConversationTurns ??
        DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxConversationTurns,
      maxSessionEvents:
        lifecycleContinuity.maxSessionEvents ??
        DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxSessionEvents,
      maxCharsPerItem:
        lifecycleContinuity.maxCharsPerItem ??
        DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxCharsPerItem,
      maxPromptChars:
        lifecycleContinuity.maxPromptChars ??
        DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxPromptChars,
    };
  }

  private isLifecycleContinuityEnabled(): boolean {
    try {
      const daemonConfig = getConfigStore().getDaemonConfig();
      const enabled = daemonConfig?.lifecycleContinuity?.enabled;
      if (typeof enabled === "boolean") {
        return enabled;
      }
    } catch {
      // Some unit tests construct SessionService without initializing DB-backed config.
      // Default behavior should still match runtime default continuity enablement.
    }
    return DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.enabled;
  }

  private buildContinuitySummary(decision: ContinuityDecision): string {
    if (decision.mode === "handoff" && decision.packet) {
      return `handoff(${decision.scope ?? decision.packet.scope}): turns=${decision.packet.conversationTurns.length}, highlights=${decision.packet.sessionHighlights.length}, questions=${decision.packet.unresolvedQuestions.length}`;
    }
    if (decision.mode === "resume") {
      return `resume(${decision.reason})`;
    }
    return `fresh(${decision.reason})`;
  }

  private buildStoredSessionContinuityMetadata(
    decision: ContinuityDecision,
    compatibility: ContinuityCompatibilityKey,
  ): StoredSessionContinuityMetadata {
    return {
      continuityMode: decision.mode,
      continuityReason: decision.reason,
      continuityScope: decision.scope,
      continuitySummary: this.buildContinuitySummary(decision),
      continuitySourceSessionId: decision.sourceSessionId,
      continuityCompatibility: compatibility,
    };
  }

  private buildContinuityDecisionLogFields(
    decision: ContinuityDecision,
  ): Record<string, string> {
    return {
      continuity_mode: decision.mode,
      continuity_reason: decision.reason,
      continuity_scope: decision.scope ?? "none",
      continuity_source_session_id: decision.sourceSessionId ?? "none",
      continuity_resume_rejected:
        decision.mode === "fresh" && decision.reason === "resume_not_allowed"
          ? "true"
          : "false",
    };
  }

  isActive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get all currently processing sessions grouped by project.
   * Returns both ticket IDs and brainstorm IDs for each project.
   * Used for the processing:sync heartbeat.
   */
  getProcessingByProject(): Map<string, { ticketIds: string[]; brainstormIds: string[] }> {
    const byProject = new Map<string, { ticketIds: string[]; brainstormIds: string[] }>();

    for (const [, session] of this.sessions) {
      const { projectId, ticketId, brainstormId } = session.meta;
      if (!projectId) continue;

      if (!byProject.has(projectId)) {
        byProject.set(projectId, { ticketIds: [], brainstormIds: [] });
      }

      const entry = byProject.get(projectId)!;

      if (ticketId && !entry.ticketIds.includes(ticketId)) {
        entry.ticketIds.push(ticketId);
      }
      if (brainstormId && !entry.brainstormIds.includes(brainstormId)) {
        entry.brainstormIds.push(brainstormId);
      }
    }

    return byProject;
  }

  /**
   * Spawn a session for a ticket phase using the worker executor.
   * This is the main entry point for starting phase execution.
   */
  async spawnForTicket(
    projectId: string,
    ticketId: string,
    phase: TicketPhase,
    projectPath: string,
  ): Promise<string> {
    console.log(
      `[spawnForTicket] Starting for ticket ${ticketId}, phase ${phase}`,
    );
    const ticket = getTicket(projectId, ticketId);
    const snapshot = consumeSpawnPendingContinuitySnapshot(
      projectId,
      ticketId,
      phase,
      ticket.executionGeneration ?? 0,
    );
    if (snapshot) {
      this.consumedRestartSnapshots.set(ticketId, snapshot);
    }

    // Delegate to the worker executor which handles all orchestration
    const sessionId = await startPhase(
      projectId,
      ticketId,
      phase,
      projectPath,
      this.getExecutorCallbacks(),
    );

    return sessionId || "";
  }

  takeRestartSnapshotForTicket(ticketId: string): ContinuityPacket | null {
    const snapshot = this.consumedRestartSnapshots.get(ticketId);
    if (!snapshot) {
      return null;
    }
    this.consumedRestartSnapshots.delete(ticketId);
    return snapshot;
  }

  async decideContinuityForTicket(
    input: DecideContinuityForTicketInput,
  ): Promise<ContinuityDecision> {
    if (!this.isLifecycleContinuityEnabled()) {
      return {
        mode: "fresh",
        reason: "disabled",
      };
    }

    const restartSnapshot = this.takeRestartSnapshotForTicket(input.ticketId);
    const sameLifecyclePacket = await this.buildContinuityPacketForTicket({
      ticketId: input.ticketId,
      conversationId: input.conversationId,
      filter: input.filter,
      limits: input.limits,
      scope: "same_lifecycle",
    });

    return decideContinuityMode({
      suspendedResumeSessionId: input.suspendedResumeSessionId,
      restartSnapshot,
      resumeEligibility: input.resumeEligibility,
      sameLifecyclePacket,
    });
  }

  /**
   * Common session spawning logic for Claude agent processes.
   * Agent instructions are included in the prompt via --print.
   */
  private spawnClaudeSession(
    sessionId: string,
    meta: SessionMeta,
    prompt: string,
    worktreePath: string,
    projectId: string,
    ticketId: string,
    brainstormId: string,
    workflowId: string,
    agentType: string,
    phase: TicketPhase | undefined,
    projectPath: string,
    stage: number,
    additionalDisallowedTools?: string[],
    model?: string,
    claudeResumeSessionId?: string,
    additionalMcpServers?: Record<string, McpServerConfig>,
  ): string {
    // Save prompt for debugging (non-blocking)
    if (ticketId && phase) {
      savePrompt(projectId, ticketId, agentType, phase, stage, prompt).catch(
        (err) =>
          console.error(
            `[spawnClaudeSession] Failed to save prompt: ${err.message}`,
          ),
      );

      logToDaemon(projectId, ticketId, `Spawning session ${sessionId}`, {
        agentType,
        phase,
        stage,
        worktreePath,
        model: model || "default",
      }).catch(() => {});
    }

    const logPath = this.getSessionLogPath(sessionId);
    const logStream = createWriteStream(logPath, { flags: "a" });
    logStream.on("error", (err) => {
      console.error(`[spawnClaudeSession] Log stream error for session ${sessionId}:`, err);
    });

    logStream.write(
      JSON.stringify({
        type: "session_start",
        meta,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    // Get path to compiled MCP proxy (dist/mcp/proxy.js)
    const mcpProxyPath = path.join(__dirname, "..", "..", "mcp", "proxy.js");

    // Get full path to node (required when running under Electron where PATH may not include node)
    const nodePath = resolveNode();

    const mcpConfig = {
      mcpServers: {
        "potato-cannon": {
          command: nodePath,
          args: [mcpProxyPath],
          env: {
            POTATO_PROJECT_ID: projectId,
            POTATO_TICKET_ID: ticketId,
            POTATO_BRAINSTORM_ID: brainstormId,
            POTATO_WORKFLOW_ID: workflowId,
            POTATO_AGENT_MODEL: model || "",
            POTATO_AGENT_SOURCE: agentType || "",
          },
        },
        ...additionalMcpServers,
      },
    };

    const args = [
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    // Add model flag if specified
    if (model) {
      args.push("--model", model);
    }

    // Write MCP config to temp file to reduce command line length
    const mcpConfigFile = path.join(os.tmpdir(), `potato-mcp-${sessionId}.json`);
    writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig), "utf-8");
    args.push("--mcp-config", mcpConfigFile);

    const disallowed = ["Skill(superpowers:*)"];
    if (additionalDisallowedTools && additionalDisallowedTools.length > 0) {
      disallowed.push(...additionalDisallowedTools);
    }
    if (disallowed.length > 0) {
      args.push("--disallowedTools", disallowed.join(","));
    }

    // Support --resume for suspended ticket sessions
    if (claudeResumeSessionId) {
      args.push("--resume", claudeResumeSessionId);
    }

    const { claudePath, claudePrependArgs } = resolveClaude(nodePath);
    console.log(`[spawnClaudeSession] Spawning ${agentType} at: ${claudePath}`);

    const spawnProject = getProjectById(projectId);
    const ptyEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      POTATO_PROJECT_ID: projectId,
      POTATO_TICKET_ID: ticketId,
      POTATO_BRAINSTORM_ID: brainstormId,
      POTATO_WORKFLOW_ID: workflowId,
      POTATO_AGENT_MODEL: model || "",
      POTATO_AGENT_SOURCE: agentType || "",
    };
    if (spawnProject?.helixSwarmUrl) {
      ptyEnv.HELIX_SWARM_URL = spawnProject.helixSwarmUrl;
    }

    // On Windows, CreateProcess has a 32,767 character command line limit.
    // Large prompts (especially Build phase with continuity data) can exceed this,
    // causing error 206 (ERROR_FILENAME_EXCED_RANGE).
    // Fix: write prompt to temp file and pipe via stdin instead of --print arg.
    const promptFile = path.join(os.tmpdir(), `potato-prompt-${sessionId}.txt`);
    writeFileSync(promptFile, prompt, "utf-8");
    const tempFiles = [mcpConfigFile, promptFile];

    let proc: pty.IPty;
    if (process.platform === "win32") {
      // Add --print flag (no message value) so Claude runs in non-interactive mode.
      // The prompt is piped via stdin from the bat file below — Claude reads it when
      // --print is present without an explicit message argument.
      args.push("--print");

      // Build the Claude command with all args (without inline prompt)
      const fullClaudeArgs = [...claudePrependArgs, ...args]
        .map((a) => (a.includes(" ") || a.includes('"') ? `"${a}"` : a))
        .join(" ");
      const claudeCmd = `"${claudePath}" ${fullClaudeArgs}`;

      // Pipe prompt from file to Claude's stdin. Claude reads it because --print
      // without an explicit message argument falls back to stdin.
      // IMPORTANT: We write the command to a .bat file instead of passing it as a
      // cmd.exe /c argument because node-pty escapes double quotes as \" in args,
      // but cmd.exe doesn't understand \" escaping — it causes "is not recognized
      // as an internal or external command" errors (exit code 255).
      const pipeCmd = `@type "${promptFile}" | ${claudeCmd}`;
      const batFile = path.join(os.tmpdir(), `potato-spawn-${sessionId}.bat`);
      writeFileSync(batFile, pipeCmd + "\r\n", "utf-8");
      tempFiles.push(batFile);

      console.log(
        `[spawnClaudeSession] Windows bat-file mode, prompt=${prompt.length} chars, cmd=${pipeCmd.length} chars`,
      );

      proc = pty.spawn("cmd.exe", ["/c", batFile], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: worktreePath,
        env: ptyEnv,
      });
    } else {
      // On non-Windows platforms, pass prompt inline (no command line limit issue)
      args.push("--print", prompt);
      proc = pty.spawn(claudePath, [...claudePrependArgs, ...args], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: worktreePath,
        env: ptyEnv,
      });
    }

    console.log(`[spawnClaudeSession] Claude PTY spawned, pid: ${proc.pid}`);

    let exitResolver!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      exitResolver = resolve;
    });

    this.sessions.set(sessionId, {
      process: proc,
      meta,
      callbackIdentity: {
        sessionId,
        executionGeneration: meta.executionGeneration ?? null,
      },
      logStream,
      exitPromise,
      exitResolver,
    });

    this.eventEmitter.emit("session:started", { sessionId, ...meta });

    // Don't overwrite claude_session_id for resumed sessions — Claude gives
    // resumed sessions a new transient ID, but --resume only works with the
    // original session ID. The stored session already has the correct one.
    let claudeSessionIdCaptured = !!claudeResumeSessionId;

    const ptyTextExtractor = new PtyTextExtractor();

    proc.onData((data: string) => {
      // Scan for remote-control URL in raw PTY output (BEFORE per-line loop)
      if (this.remoteControlState.get(sessionId)?.pending) {
        const stripped = data.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
        const match = stripped.match(/https:\/\/claude\.ai\/code\/[^\s]{1,150}/);
        if (match) {
          const url = match[0];
          this.remoteControlState.set(sessionId, { pending: false, url });
          eventBus.emit("session:remote-control-url", {
            sessionId,
            ticketId: meta.ticketId,
            projectId: meta.projectId,
            url,
          });
        }
      }

      const lines = data.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const rateLimitNotice = extractRateLimitNotice(event);
          const isStructuredRateLimitEvent = event?.type === "rate_limit_event";
          if (rateLimitNotice && ticketId) {
            const existingNotice = this.rateLimitNoticeByTicket.get(ticketId);
            if (!existingNotice || isStructuredRateLimitEvent) {
              this.rateLimitNoticeByTicket.set(ticketId, rateLimitNotice);
            }
            logToDaemon(projectId, ticketId, `Rate limit detected`, {
              agentType,
              phase,
              notice: rateLimitNotice,
            }).catch(() => {});
          }
          const logEntry = { ...event, timestamp: new Date().toISOString() };
          logStream.write(JSON.stringify(logEntry) + "\n");
          this.eventEmitter.emit("session:output", {
            sessionId,
            ...meta,
            event: logEntry,
          });

          // Capture Claude's session ID from the first system event that has one
          if (
            !claudeSessionIdCaptured &&
            event.type === "system" &&
            event.session_id
          ) {
            claudeSessionIdCaptured = true;
            updateClaudeSessionId(sessionId, event.session_id);
          }
        } catch {
          const logEntry = {
            type: "raw",
            content: line,
            timestamp: new Date().toISOString(),
          };
          logStream.write(JSON.stringify(logEntry) + "\n");
        }
      }

      // Capture assistant text blocks from PTY stream
      if (meta.ticketId || meta.brainstormId) {
        const texts = ptyTextExtractor.feed(data);
        for (const text of texts) {
          this.handleCapturedPtyText(
            text,
            meta.projectId,
            meta.ticketId,
            meta.brainstormId,
            phase,
            agentType,
          );
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      console.log(
        `[spawnClaudeSession] Agent ${agentType} exited with code: ${exitCode}`,
      );

      // Log to ticket daemon.log
      if (ticketId) {
        logToDaemon(projectId, ticketId, `Session ${sessionId} exited`, {
          agentType,
          exitCode,
          phase,
          stage,
        }).catch(() => {});
      }

      const endMeta: SessionMeta = {
        ...meta,
        status: exitCode === 0 ? "completed" : "failed",
        exitCode,
        endedAt: new Date().toISOString(),
      };

      logStream.write(
        JSON.stringify({
          type: "session_end",
          meta: endMeta,
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
      logStream.end();

      // Clean up temp files written for Windows stdin-pipe spawn
      for (const tmpFile of tempFiles) {
        try { unlinkSync(tmpFile); } catch { /* already removed or never created */ }
      }

      const session = this.sessions.get(sessionId);
      const wasForceKilled = session?.forceKilled ?? false;
      if (session?.exitResolver) {
        session.exitResolver();
      }

      if (this.remoteControlState.has(sessionId)) {
        this.remoteControlState.delete(sessionId);
        eventBus.emit("session:remote-control-cleared", {
          sessionId,
          ticketId: meta.ticketId,
          projectId: meta.projectId,
        });
      }
      this.sessions.delete(sessionId);

      // Clean up PTY-capture dedup registry for this session's context
      const dedupKey = ticketId || brainstormId;
      if (dedupKey) {
        clearPtyCaptureDedup(dedupKey);
      }

      // End stored session in database (for ticket sessions tracked in SQLite)
      endStoredSession(sessionId, exitCode);

      this.eventEmitter.emit("session:ended", { sessionId, ...endMeta });

      // Handle agent completion via new executor.
      // Skip for force-killed sessions: terminateExistingSession already started a replacement,
      // so running completion here would corrupt worker state with a stale ghost handler.
      if (phase && ticketId && !wasForceKilled) {
        handleAgentCompletion(
          projectId,
          ticketId,
          phase,
          projectPath,
          exitCode,
          agentType,
          getPendingVerdict(projectId, ticketId) ?? { approved: exitCode === 0 },
          this.getExecutorCallbacks(),
          {
            sessionId,
            executionGeneration: meta.executionGeneration ?? null,
          }
        ).catch((err) =>
          console.error(`[spawnClaudeSession] Error in completion handler:`, err),
        );
      }
    });

    return sessionId;
  }

  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.process.kill("SIGTERM");
      return true;
    }
    return false;
  }

  async terminateTicketSession(ticketId: string): Promise<boolean> {
    return this.terminateExistingSession("ticket", ticketId);
  }

  /**
   * Internal helper for unit tests: simulate the cleanup that proc.onExit performs
   * for a session registered in the sessions map (without spawning a real PTY).
   * Not intended for production use.
   */
  _testSimulateSessionExit(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.exitResolver) {
      session.exitResolver();
    }
    if (this.remoteControlState.has(sessionId)) {
      this.remoteControlState.delete(sessionId);
      const meta = session?.meta as any;
      eventBus.emit("session:remote-control-cleared", {
        sessionId,
        ticketId: meta?.ticketId ?? "",
        projectId: meta?.projectId ?? "",
      });
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Internal helper for unit tests: simulate the URL scanning that proc.onData performs
   * for a pending remote-control session (without spawning a real PTY).
   * Not intended for production use.
   */
  _testSimulateOnData(sessionId: string, data: string): void {
    const meta = this.sessions.get(sessionId)?.meta ?? {};
    if (this.remoteControlState.get(sessionId)?.pending) {
      const stripped = data.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
      const match = stripped.match(/https:\/\/claude\.ai\/code\/[^\s]{1,150}/);
      if (match) {
        const url = match[0];
        this.remoteControlState.set(sessionId, { pending: false, url });
        eventBus.emit("session:remote-control-url", {
          sessionId,
          ticketId: (meta as any).ticketId,
          projectId: (meta as any).projectId,
          url,
        });
      }
    }
  }

  startRemoteControl(sessionId: string, ticketTitle: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Double-click guard
    const existing = this.remoteControlState.get(sessionId);
    if (existing?.pending || existing?.url) return false;

    this.remoteControlState.set(sessionId, { pending: true });
    const safeName = ticketTitle.replace(/["\n\r]/g, " ").slice(0, 50);
    const command = `/remote-control "${safeName}"\r`;
    session.process.write(command);
    return true;
  }

  getRemoteControlState(sessionId: string): RemoteControlState | null {
    return this.remoteControlState.get(sessionId) ?? null;
  }

  /**
   * Terminate an existing session for a context (brainstorm or ticket).
   * Uses the existing sessions table as the "lock" - ended_at IS NULL means active.
   *
   * @param contextType - Either 'brainstorm' or 'ticket'
   * @param contextId - The brainstorm or ticket ID
   */
  private async terminateExistingSession(
    contextType: 'brainstorm' | 'ticket',
    contextId: string,
    options: { skipDatabaseClose?: boolean } = {},
  ): Promise<boolean> {
    // Query for active session using existing store functions
    const activeSession = contextType === 'brainstorm'
      ? getActiveSessionForBrainstorm(contextId)
      : getActiveSessionForTicket(contextId);

    if (!activeSession) {
      return false; // No active session to terminate
    }

    console.log(`[terminateExistingSession] Terminating existing session ${activeSession.id} for ${contextType} ${contextId}`);

    // Step 1: Cancel any pending waitForResponse
    cancelWaitForResponse(contextId);

    // Step 2: Stop the PTY process if it's still running in memory.
    // Mark as forceKilled BEFORE killing so the PTY exit handler knows to skip handleAgentCompletion.
    // Without this, the killed session's exit fires and races with the new session.
    if (this.sessions.has(activeSession.id)) {
      const existing = this.sessions.get(activeSession.id);
      if (existing) existing.forceKilled = true;
      this.stopSession(activeSession.id);
    }

    // Step 3: Mark session as ended in database (releases the "lock")
    if (!options.skipDatabaseClose) {
      endStoredSession(activeSession.id, -1); // -1 indicates forced termination
    }

    // Brief delay to allow cleanup
    await new Promise(resolve => setTimeout(resolve, 50));
    return true;
  }

  async spawnForBrainstorm(
    projectId: string,
    brainstormId: string,
    projectPath: string,
    initialMessage?: string,
  ): Promise<string> {
    console.log(`[spawnForBrainstorm] Starting for brainstorm ${brainstormId}`);

    // Concurrency guard — prevent duplicate spawns from poller + user messages
    const existingActive = getActiveSessionForBrainstorm(brainstormId);
    if (existingActive && this.sessions.has(existingActive.id)) {
      console.log(`[spawnForBrainstorm] Session ${existingActive.id} already active for ${brainstormId} — returning existing`);
      return existingActive.id;
    }

    const brainstorm = await getBrainstorm(projectId, brainstormId);
    const workflowId = brainstorm.workflowId || "";
    const existingClaudeSessionId = getLatestClaudeSessionId(brainstormId);

    // Create session record in database
    const storedSession = createStoredSession({
      projectId,
      brainstormId,
      claudeSessionId: existingClaudeSessionId || undefined,
      agentSource: "brainstorm",
    });
    const sessionId = storedSession.id;

    // Check for pending response from previous session
    let pendingContext: { question: string; response: string } | undefined;
    const pendingResponse = await readResponse(projectId, brainstormId);
    const pendingQuestion = await readQuestion(projectId, brainstormId);

    if (pendingResponse && pendingQuestion) {
      console.log(
        `[spawnForBrainstorm] Found pending context - resuming conversation`,
      );
      pendingContext = {
        question: pendingQuestion.question,
        response: pendingResponse.answer,
      };
      // Clear the files so the new session doesn't also pick them up via waitForResponse
      await clearResponse(projectId, brainstormId);
      await clearQuestion(projectId, brainstormId);
    }

    // Determine whether this brainstorm should use the PM skill
    const usePm = shouldUsePmSkill(brainstorm);

    // Load agent from template — PM skill takes priority when transition has occurred
    const agentType = usePm ? "agents/project-manager.md" : "agents/brainstorm.md";

    // Only build full prompt for first session; resumed sessions use --resume
    const prompt = existingClaudeSessionId
      ? pendingContext?.response || (usePm ? "Continue as Project Manager." : "Continue the brainstorm.")
      : usePm
        ? await buildPmPrompt(projectId, brainstormId, brainstorm, { pendingContext })
        : buildBrainstormPrompt(projectId, brainstormId, brainstorm, { pendingContext, initialMessage });

    const meta: SessionMeta = {
      projectId,
      brainstormId,
      brainstormName: brainstorm.name,
      worktreePath: projectPath,
      startedAt: new Date().toISOString(),
      status: "running",
    };

    const logPath = this.getSessionLogPath(sessionId);
    const logStream = createWriteStream(logPath, { flags: "a" });
    logStream.on("error", (err) => {
      console.error(`[spawnForBrainstorm] Log stream error for session ${sessionId}:`, err);
    });

    logStream.write(
      JSON.stringify({
        type: "session_start",
        meta,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    const mcpProxyPath = path.join(__dirname, "..", "..", "mcp", "proxy.js");

    // Get full path to node (required when running under Electron where PATH may not include node)
    const nodePath = resolveNode();

    const mcpConfig = {
      mcpServers: {
        "potato-cannon": {
          command: nodePath,
          args: [mcpProxyPath],
          env: {
            POTATO_PROJECT_ID: projectId,
            POTATO_TICKET_ID: "",
            POTATO_BRAINSTORM_ID: brainstormId,
            POTATO_WORKFLOW_ID: workflowId,
            POTATO_AGENT_MODEL: "",
            POTATO_AGENT_SOURCE: agentType,
          },
        },
      },
    };
    const agentDefinition = await tryLoadAgentDefinition(projectId, agentType);

    if (!agentDefinition) {
      throw new Error(
        `Agent '${agentType}' not found in template for project ${projectId}`,
      );
    }

    // Include agent instructions in prompt for new sessions
    // (resumed sessions already have agent context)
    const fullPrompt = existingClaudeSessionId
      ? prompt
      : `${agentDefinition.prompt}\n\n---\n\n${prompt}`;

    const args = [
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      JSON.stringify(mcpConfig),
    ];

    const disallowed = ["Skill(superpowers:*)", "AskUserQuestion"];
    if (disallowed.length > 0) {
      args.push("--disallowedTools", disallowed.join(","));
    }

    // Use --resume for continuing existing Claude session, --print for new sessions
    if (existingClaudeSessionId) {
      console.log(
        `[spawnForBrainstorm] Resuming Claude session ${existingClaudeSessionId}`,
      );
      args.push("--resume", existingClaudeSessionId);
    }
    args.push("--print", fullPrompt);

    const { claudePath, claudePrependArgs } = resolveClaude(nodePath);
    console.log(`[spawnForBrainstorm] Calling pty.spawn, claudePath=${claudePath}, cwd=${projectPath}`);

    const proc = pty.spawn(claudePath, [...claudePrependArgs, ...args], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: projectPath,
      env: {
        ...process.env,
        POTATO_PROJECT_ID: projectId,
        POTATO_BRAINSTORM_ID: brainstormId,
        POTATO_WORKFLOW_ID: workflowId,
        POTATO_AGENT_MODEL: "",
        POTATO_AGENT_SOURCE: agentType,
      },
    });
    console.log(`[spawnForBrainstorm] pty.spawn succeeded, pid=${proc.pid}`);

    let exitResolver!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      exitResolver = resolve;
    });

    this.sessions.set(sessionId, {
      process: proc,
      meta,
      logStream,
      exitPromise,
      exitResolver,
    });

    this.eventEmitter.emit("session:started", { sessionId, ...meta });

    let claudeSessionIdCaptured = !!existingClaudeSessionId;

    proc.onData((data: string) => {
      const lines = data.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const logEntry = { ...event, timestamp: new Date().toISOString() };
          logStream.write(JSON.stringify(logEntry) + "\n");
          this.eventEmitter.emit("session:output", {
            sessionId,
            ...meta,
            event: logEntry,
          });

          // Capture Claude's session ID from the first system event (first session only)
          if (
            !claudeSessionIdCaptured &&
            event.type === "system" &&
            event.session_id
          ) {
            claudeSessionIdCaptured = true;
            console.log(
              `[spawnForBrainstorm] Captured Claude session ID: ${event.session_id}`,
            );
            // Store in session record
            updateClaudeSessionId(sessionId, event.session_id);
          }
        } catch {
          const logEntry = {
            type: "raw",
            content: line,
            timestamp: new Date().toISOString(),
          };
          logStream.write(JSON.stringify(logEntry) + "\n");
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      try {
        const endMeta: SessionMeta = {
          ...meta,
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
          endedAt: new Date().toISOString(),
        };

        logStream.write(
          JSON.stringify({
            type: "session_end",
            meta: endMeta,
            timestamp: new Date().toISOString(),
          }) + "\n",
        );
        logStream.end();

        // End session record in database
        endStoredSession(sessionId, exitCode);

        const session = this.sessions.get(sessionId);
        if (session?.exitResolver) {
          session.exitResolver();
        }

        this.sessions.delete(sessionId);
        this.eventEmitter.emit("session:ended", { sessionId, ...endMeta });
      } catch (err) {
        console.error(`[spawnForBrainstorm] Error in onExit handler for session ${sessionId}:`, err);
        this.sessions.delete(sessionId);
      }
    });

    return sessionId;
  }

  /**
   * Spawn an agent session via the worker executor
   */
  async spawnAgentWorker(
    projectId: string,
    ticketId: string,
    phase: TicketPhase,
    projectPath: string,
    agentWorker: AgentWorker,
    taskContext?: TaskContext,
    ralphContext?: { phaseId: string; ralphLoopId: string; taskId: string | null },
    phaseEntryContext?: PhaseEntryContext,
  ): Promise<string> {
    console.log(`[spawnAgentWorker] Spawning ${agentWorker.source} for phase ${phase}`);
    this.rateLimitNoticeByTicket.delete(ticketId);

    // Terminate any existing session first (uses sessions table as lock)
    await this.terminateExistingSession('ticket', ticketId);

    const ticket = await getTicket(projectId, ticketId);
    const images = await listTicketImages(projectId, ticketId);

    const project = getProjectById(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const provider = createVCSProvider(project);

    const needsIsolation = await phaseRequiresIsolation(projectId, phase, ticket.workflowId);
    let worktreePath: string;
    let workspaceLabel: string;
    if (needsIsolation) {
      const info = await provider.ensureWorkspace(ticketId);
      worktreePath = info.workspacePath;
      workspaceLabel = info.workspaceLabel;
    } else {
      worktreePath = projectPath;
      workspaceLabel = ticketId;
    }

    const nodePath = resolveNode();
    const additionalMcpServers = provider.getMcpServers(nodePath, projectId, ticketId);

    // Load agent definition
    const agentDefinition = await tryLoadAgentDefinition(projectId, agentWorker.source);
    if (!agentDefinition) {
      throw new Error(`Agent ${agentWorker.source} not found in template`);
    }

    const globalConfig = await loadGlobalConfig();
    if (!globalConfig) {
      throw new Error("Global config is unavailable; cannot resolve AI model routing.");
    }

    // Resolve model for this agent, using task complexity if available, else ticket complexity.
    const taskComplexity = taskContext?.complexity ?? ticket.complexity;
    const resolvedModel = resolveWorkerModelForSpawn({
      worker: agentWorker,
      complexity: taskComplexity,
      project: { providerOverride: project.providerOverride },
      config: globalConfig,
    });
    const disallowedTools = ["Skill(superpowers:*)", ...(agentWorker.disallowTools || [])];
    const compatibilityKey = this.buildContinuityCompatibilityKey({
      ticketId,
      phase,
      agentSource: agentWorker.source,
      executionGeneration: ticket.executionGeneration ?? 0,
      workflowId: ticket.workflowId || "",
      worktreePath,
      branchName: workspaceLabel,
      agentPrompt: agentDefinition.prompt,
      mcpServerNames: ["potato-cannon", ...Object.keys(additionalMcpServers)],
      model: resolvedModel ?? "default",
      disallowedTools,
    });
    const continuitySessions = getRecentSessionsForContinuity(
      ticketId,
      {
        phase,
        agentSource: agentWorker.source,
        executionGeneration: ticket.executionGeneration ?? 0,
      },
      20,
    );
    const { storedCompatibility, claudeSessionId: existingClaudeSessionId } =
      resolveStoredContinuityContext(continuitySessions);
    const continuityDecision = await this.decideContinuityForTicket({
      ticketId,
      conversationId: ticket.conversationId,
      filter: {
        phase,
        agentSource: agentWorker.source,
        executionGeneration: ticket.executionGeneration ?? 0,
      },
      limits: this.getLifecycleContinuityLimits(),
      resumeEligibility: {
        stored: storedCompatibility,
        current: compatibilityKey,
        claudeSessionId: existingClaudeSessionId,
        lifecycleInvalidated: false,
      },
    });
    const continuityMetadata = this.buildStoredSessionContinuityMetadata(
      continuityDecision,
      compatibilityKey,
    );
    logToDaemon(
      projectId,
      ticketId,
      "Continuity decision for ticket spawn",
      this.buildContinuityDecisionLogFields(continuityDecision),
    ).catch(() => {});
    const resumeSessionId =
      continuityDecision.mode === "resume"
        ? continuityDecision.sourceSessionId ??
          existingClaudeSessionId ??
          undefined
        : undefined;
    const handoffDecision =
      continuityDecision.mode === "handoff" ? continuityDecision : undefined;

    // Build prompt with task context if provided
    let prompt = agentDefinition.prompt;
    if (taskContext) {
      prompt += `\n\n---\n\n${formatTaskContext(taskContext)}`;
    }

    // Build ticket context with optional continuity and phase-entry sections
    const ticketContext = await buildAgentPrompt(
      projectId,
      ticketId,
      ticket,
      phase,
      agentWorker,
      images,
      undefined, // agentPrompt - we already have it
      ralphContext,
      phaseEntryContext,
      handoffDecision,
    );
    prompt += `\n\n---\n\n${ticketContext}`;

    const meta: SessionMeta = {
      projectId,
      ticketId,
      ticketTitle: ticket.title,
      executionGeneration: ticket.executionGeneration ?? 0,
      phase,
      worktreePath,
      branchName: workspaceLabel,
      startedAt: new Date().toISOString(),
      status: "running",
      agentType: agentWorker.source,
      stage: 0,
      continuityMode: continuityMetadata.continuityMode,
      continuityReason: continuityMetadata.continuityReason,
      continuityScope: continuityMetadata.continuityScope,
      continuitySummary: continuityMetadata.continuitySummary,
      continuitySourceSessionId: continuityMetadata.continuitySourceSessionId,
    };

    const storedSession = createStoredSession({
      projectId,
      ticketId,
      executionGeneration: ticket.executionGeneration ?? 0,
      claudeSessionId: resumeSessionId,
      agentSource: agentWorker.source,
      phase,
      metadata: continuityMetadata,
    });
    const sessionId = storedSession.id;

    return this.spawnClaudeSession(
      sessionId,
      meta,
      prompt,
      worktreePath,
      projectId,
      ticketId,
      "",
      ticket.workflowId || "",
      agentWorker.source,
      phase,
      projectPath,
      0,
      agentWorker.disallowTools,
      resolvedModel ?? undefined,
      resumeSessionId,
      additionalMcpServers,
    );
  }

  /**
   * Resume a suspended ticket session after user responds.
   * Mirrors spawnForBrainstorm's resume pattern:
   * - Reads pending context for conversation injection
   * - Gets latest Claude session ID for --resume
   * - Clears pending files
   * - Spawns new session with --resume flag
   */
  async resumeSuspendedTicket(
    projectId: string,
    ticketId: string,
    userResponse: string,
    identity: ResumeTicketInputIdentity,
  ): Promise<string> {
    console.log(`[resumeSuspendedTicket] Resuming suspended ticket ${ticketId}`);

    const ticket = await getTicket(projectId, ticketId);
    const ticketGeneration = ticket.executionGeneration ?? 0;
    const project = getProjectById(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const pendingQuestion = await readQuestion(projectId, ticketId);
    if (!pendingQuestion) {
      throw new StaleTicketInputError(
        "No pending question to resume",
        ticketGeneration,
        identity.ticketGeneration,
        undefined,
        identity.questionId,
      );
    }

    const expectedQuestionId = pendingQuestion.questionId;
    const expectedGeneration = pendingQuestion.ticketGeneration;
    if (!expectedQuestionId || expectedGeneration === undefined) {
      await clearPendingInteraction(projectId, ticketId);
      throw new StaleTicketInputError(
        "Pending question is missing lifecycle identity",
        ticketGeneration,
        identity.ticketGeneration,
        expectedQuestionId,
        identity.questionId,
      );
    }

    if (
      identity.questionId !== expectedQuestionId ||
      identity.ticketGeneration !== expectedGeneration ||
      identity.ticketGeneration !== ticketGeneration
    ) {
      await clearPendingInteraction(projectId, ticketId);
      throw new StaleTicketInputError(
        "Ticket input no longer matches the active lifecycle",
        ticketGeneration,
        identity.ticketGeneration,
        expectedQuestionId,
        identity.questionId,
      );
    }

    // Safety: terminate any lingering session for this ticket
    await this.terminateExistingSession("ticket", ticketId);

    // Get the Claude session ID from the most recent session for --resume
    const claudeSessionId = getLatestClaudeSessionIdForTicket(ticketId);
    if (!claudeSessionId) {
      throw new Error(`No Claude session ID found for ticket ${ticketId} — cannot resume`);
    }

    // Mark the pending question as answered in conversation store
    if (ticket.conversationId) {
      const { answerQuestion, getPendingQuestion, addMessage } = await import(
        "../../stores/conversation.store.js"
      );
      const pendingQuestion = getPendingQuestion(ticket.conversationId);
      if (pendingQuestion) {
        answerQuestion(pendingQuestion.id);
      }
      addMessage(ticket.conversationId, {
        type: "user",
        text: userResponse,
      });
    }

    // Clear pending files
    await clearQuestion(projectId, ticketId);
    await clearResponse(projectId, ticketId);

    // Emit SSE event for the user's response
    eventBus.emit("ticket:message", {
      projectId,
      ticketId,
      message: { type: "user", text: userResponse, timestamp: new Date().toISOString() },
    });

    const provider = createVCSProvider(project);

    const needsIsolation = await phaseRequiresIsolation(projectId, ticket.phase, ticket.workflowId);
    let worktreePath: string;
    let workspaceLabel: string;
    if (needsIsolation) {
      const info = await provider.ensureWorkspace(ticketId);
      worktreePath = info.workspacePath;
      workspaceLabel = info.workspaceLabel;
    } else {
      worktreePath = project.path;
      workspaceLabel = ticketId;
    }

    const nodePath = resolveNode();
    const additionalMcpServers = provider.getMcpServers(nodePath, projectId, ticketId);
    const compatibilityKey = this.buildContinuityCompatibilityKey({
      ticketId,
      phase: ticket.phase,
      agentSource: "resume",
      executionGeneration: ticketGeneration,
      workflowId: ticket.workflowId || "",
      worktreePath,
      branchName: workspaceLabel,
      agentPrompt: "resume",
      mcpServerNames: ["potato-cannon", ...Object.keys(additionalMcpServers)],
      model: "default",
      disallowedTools: ["Skill(superpowers:*)"],
    });

    const latestSession = getSessionsByTicket(ticketId).at(-1);
    const storedCompatibility = latestSession?.metadata
      ? (latestSession.metadata as { continuityCompatibility?: ContinuityCompatibilityKey })
          .continuityCompatibility
      : undefined;
    const continuityDecision = await this.decideContinuityForTicket({
      ticketId,
      conversationId: ticket.conversationId,
      filter: {
        phase: ticket.phase,
        agentSource: "resume",
        executionGeneration: ticketGeneration,
      },
      limits: this.getLifecycleContinuityLimits(),
      resumeEligibility: {
        stored: storedCompatibility,
        current: compatibilityKey,
        claudeSessionId,
        lifecycleInvalidated: false,
      },
      suspendedResumeSessionId: claudeSessionId,
    });
    if (continuityDecision.mode !== "resume") {
      return this.spawnForTicket(projectId, ticketId, ticket.phase, project.path);
    }
    const continuityMetadata = this.buildStoredSessionContinuityMetadata(
      continuityDecision,
      compatibilityKey,
    );
    logToDaemon(
      projectId,
      ticketId,
      "Continuity decision for suspended resume",
      this.buildContinuityDecisionLogFields(continuityDecision),
    ).catch(() => {});

    const storedSession = createStoredSession({
      projectId,
      ticketId,
      executionGeneration: ticketGeneration,
      claudeSessionId,
      agentSource: "resume",
      phase: ticket.phase,
      metadata: continuityMetadata,
    });

    const meta: SessionMeta = {
      projectId,
      ticketId,
      ticketTitle: ticket.title,
      executionGeneration: ticketGeneration,
      phase: ticket.phase,
      worktreePath,
      branchName: workspaceLabel,
      startedAt: new Date().toISOString(),
      status: "running",
      agentType: "resume",
      stage: 0,
      continuityMode: continuityMetadata.continuityMode,
      continuityReason: continuityMetadata.continuityReason,
      continuityScope: continuityMetadata.continuityScope,
      continuitySummary: continuityMetadata.continuitySummary,
      continuitySourceSessionId: continuityMetadata.continuitySourceSessionId,
    };

    // With --resume, Claude already has the full conversation context.
    // The user's response is the new prompt input.
    // Prepend a reminder to use MCP tools for all user-visible output.
    const prompt = buildResumePrompt(userResponse);

    return this.spawnClaudeSession(
      storedSession.id,
      meta,
      prompt,
      worktreePath,
      projectId,
      ticketId,
      "",
      ticket.workflowId || "",
      "resume",
      ticket.phase,
      project.path,
      0,
      undefined,
      undefined,
      claudeSessionId, // triggers --resume flag
      additionalMcpServers,
    );
  }

  /**
   * Get executor callbacks bound to this service
   */
  private getExecutorCallbacks(): ExecutorCallbacks {
    return {
      spawnAgent: this.spawnAgentWorker.bind(this),
      onPhaseComplete: this.handlePhaseTransition.bind(this),
      onTicketBlocked: this.handleTicketBlocked.bind(this),
    };
  }

  /**
   * Handle phase transition via executor
   */
  private async handlePhaseTransition(
    projectId: string,
    ticketId: string,
    completedPhase: TicketPhase,
    projectPath: string
  ): Promise<void> {
    // Get the ticket's workflowId so phase resolution uses the correct template
    const currentTicket = getTicket(projectId, ticketId);
    const workflowId = currentTicket?.workflowId;

    const nextPhase = await getNextEnabledPhase(projectId, completedPhase, workflowId);
    if (!nextPhase) {
      console.log(`[handlePhaseTransition] No next phase after ${completedPhase}`);
      return;
    }

    const ticket = await updateTicket(projectId, ticketId, { phase: nextPhase });
    console.log(`[handlePhaseTransition] Transitioned to ${nextPhase}`);

    // Emit SSE events so frontend updates
    eventBus.emit("ticket:updated", { projectId, ticket });
    eventBus.emit("ticket:moved", {
      projectId,
      ticketId,
      from: completedPhase,
      to: nextPhase,
    });

    // Check if next phase has workers
    const phaseConfig = await getPhaseConfig(projectId, nextPhase, workflowId);
    if (phaseConfig?.workers && phaseConfig.workers.length > 0) {
      await startPhase(projectId, ticketId, nextPhase, projectPath, this.getExecutorCallbacks());
    }
  }

  /**
   * Handle ticket blocked - move to Blocked phase
   */
  private async handleTicketBlocked(
    projectId: string,
    ticketId: string,
    reason: string
  ): Promise<void> {
    const detectedRateLimit = this.rateLimitNoticeByTicket.get(ticketId);
    reason = formatBlockedReasonWithRateLimit(reason, detectedRateLimit);
    this.rateLimitNoticeByTicket.delete(ticketId);

    console.log(`[handleTicketBlocked] Blocking ticket ${ticketId}: ${reason}`);

    // Get current phase before updating
    const currentTicket = getTicket(projectId, ticketId);
    const previousPhase = currentTicket.phase;

    const ticket = await updateTicket(projectId, ticketId, { phase: "Blocked" });
    await logToDaemon(projectId, ticketId, `Ticket blocked: ${reason}`);

    // Write error to conversation so it appears in Activity feed
    try {
      const blockedTicket = getTicket(projectId, ticketId);
      if (blockedTicket?.conversationId) {
        addMessage(blockedTicket.conversationId, {
          type: 'error',
          text: reason,
        });
        eventBus.emit('ticket:message', {
          projectId,
          ticketId,
          message: { type: 'error', text: reason },
        });
      }
    } catch (err) {
      console.error(`[handleTicketBlocked] Failed to write error message: ${(err as Error).message}`);
    }

    // Emit SSE events so frontend updates
    eventBus.emit("ticket:updated", { projectId, ticket });
    eventBus.emit("ticket:moved", {
      projectId,
      ticketId,
      from: previousPhase,
      to: "Blocked",
    });
  }

  /**
   * Store captured PTY assistant text as a conversation notification.
   * This catches reasoning text that the agent outputs directly instead
   * of sending via chat_notify.
   *
   * Records each stored message in the per-context PtyCaptureDedup so that
   * when chat_notify fires with the same content, the PTY-captured message
   * can be marked as superseded (soft-deleted from display).
   */
  private handleCapturedPtyText(
    text: string,
    projectId: string,
    ticketId: string | undefined,
    brainstormId: string | undefined,
    phase: TicketPhase | undefined,
    agentType: string,
  ): void {
    try {
      let conversationId: string | undefined;
      if (ticketId) {
        // getTicket throws if not found — caught by the try/catch wrapping this method
        const ticket = getTicket(projectId, ticketId);
        conversationId = ticket.conversationId;
      } else if (brainstormId) {
        const brainstorm = brainstormGetDirect(brainstormId);
        conversationId = brainstorm?.conversationId ?? undefined;
      }

      if (!conversationId) return;

      const stored = addMessage(conversationId, {
        type: "notification",
        text,
        metadata: {
          source: "pty-capture",
          phase,
          agentSource: agentType,
        },
      });

      // Register in dedup so chat_notify can supersede this message
      const contextKey = ticketId ?? brainstormId;
      if (contextKey) {
        getPtyCaptureDedup(contextKey).recordCapture(text, stored.id);
      }

      // Emit SSE event so the frontend updates in real time
      const now = new Date().toISOString();
      if (ticketId) {
        eventBus.emit("ticket:message", {
          projectId,
          ticketId,
          message: { type: "notification", text, timestamp: now },
        });
      } else if (brainstormId) {
        eventBus.emit("brainstorm:message", {
          projectId,
          brainstormId,
          message: { type: "notification", text, timestamp: now },
        });
      }
    } catch (err) {
      console.error("[handleCapturedPtyText] Failed to store captured text:", err);
    }
  }

  async stopAll(timeout: number = 4000): Promise<void> {
    if (this.sessions.size === 0) return;

    console.log(
      `[stopAll] Stopping ${this.sessions.size} active session(s)...`,
    );

    const exitPromises: Promise<void>[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.exitPromise) {
        exitPromises.push(session.exitPromise);
      }
      this.stopSession(sessionId);
    }

    if (exitPromises.length > 0) {
      const timeoutPromise = new Promise<void>((resolve) =>
        setTimeout(() => {
          console.log(`[stopAll] Timeout waiting for sessions to exit`);
          resolve();
        }, timeout),
      );

      await Promise.race([Promise.all(exitPromises), timeoutPromise]);
    }

    console.log(`[stopAll] All sessions stopped`);
  }
}
