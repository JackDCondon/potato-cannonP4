import type { PmConfig } from "./board-settings.types.js";

export type BrainstormStatus = 'active' | 'completed' | 'epic'

export interface Brainstorm {
  id: string
  projectId?: string
  name: string
  status: BrainstormStatus
  createdAt: string
  updatedAt: string
  conversationId?: string | null
  createdTicketId?: string | null
  workflowId?: string | null
  hasActiveSession?: boolean
  planSummary?: string | null
  ticketCount?: number
  activeTicketCount?: number
  pmEnabled?: boolean
  pmConfig?: PmConfig | null
  color?: string | null
  icon?: string | null
}

export interface BrainstormQuestion {
  conversationId: string
  question: string
  options?: string[]
  askedAt: string
}

export interface BrainstormMessage {
  type: 'question' | 'user' | 'error' | 'notification'
  text: string
  conversationId?: string
  options?: string[]
  askedAt?: string
  sentAt?: string
  timestamp?: string
  metadata?: Record<string, unknown>
}
