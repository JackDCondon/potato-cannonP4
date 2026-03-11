export type SessionStatus = 'running' | 'completed' | 'failed'

export interface SessionMeta {
  id: string
  ticketId?: string
  executionGeneration?: number | null
  phase?: string
  agentSource?: string
  status: SessionStatus
  startedAt: string
  endedAt?: string
}

export interface Session {
  id: string
  projectId: string
  ticketId?: string
  executionGeneration?: number | null
  brainstormId?: string
  status: SessionStatus
  startedAt: string
  endedAt?: string
  preview?: string
}

/** A single content block within an assistant message */
export interface SessionLogContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  /** text block */
  text?: string
  /** tool_use block */
  name?: string
  id?: string
  input?: Record<string, unknown>
  /** tool_result block */
  tool_use_id?: string
  content?: string | unknown[]
  is_error?: boolean
}

/** An assistant message carrying content blocks */
export interface SessionLogMessage {
  content: SessionLogContentBlock[]
}

/**
 * The shape of entries returned by GET /api/sessions/:id.
 *
 * Supports two formats:
 * - Legacy flat format: tool_name, tool_input, tool_result fields
 * - Streaming format: message field with content blocks (assistant/user turns)
 */
export interface SessionLogEntry {
  type: string
  timestamp?: string
  // session lifecycle
  meta?: Record<string, unknown>
  // raw fallback
  content?: string
  // system events
  subtype?: string
  description?: string
  // assistant / user turns (streaming format)
  message?: SessionLogMessage
  // legacy flat format
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_result?: string
  is_error?: boolean
}
