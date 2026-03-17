import type { Complexity } from './ticket.types.js'

export type { Complexity } from './ticket.types.js'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface TaskComment {
  id: string
  taskId: string
  text: string
  createdAt: string
}

/**
 * Reference to extract task body content from an artifact.
 * Used by create_task to avoid LLM regeneration of large artifact content.
 */
export interface BodyFrom {
  /** Artifact filename, e.g. "specification.md" */
  artifact: string
  /** Literal string to find — extraction starts from this marker (inclusive) */
  start_marker: string
  /** Literal string marking end of extraction (exclusive). If omitted, extracts to EOF. */
  end_marker?: string
}

export interface Task {
  id: string
  ticketId: string
  displayNumber: number
  phase: string
  status: TaskStatus
  attemptCount: number
  description: string
  body?: string
  createdAt: string
  updatedAt: string
  complexity: Complexity
}
