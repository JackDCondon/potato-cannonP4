export type ConversationMessageOrigin = 'agent' | 'user' | 'system' | 'provider'

export interface ConversationContinuityMetadata {
  phase?: string
  executionGeneration?: number
  agentSource?: string
  sourceSessionId?: string
  messageOrigin?: ConversationMessageOrigin
}

export type ConversationMessageMetadata =
  ConversationContinuityMetadata & Record<string, unknown>

export interface ConversationEntry {
  id: string
  questionId?: string
  question: string
  options?: string[]
  askedAt: string
  phase?: string
  ticketGeneration?: number
  phaseAtAsk?: string
  answer?: string
  answeredAt?: string
}

export interface TicketPendingQuestion {
  conversationId: string
  questionId?: string
  question: string
  options?: string[]
  askedAt: string
  phase?: string
  ticketGeneration?: number
  phaseAtAsk?: string
}

export interface TicketPendingResponse {
  questionId?: string
  ticketGeneration?: number
  question?: TicketPendingQuestion
}

export interface TicketMessage {
  type: 'question' | 'user' | 'notification' | 'artifact' | 'error'
  text: string
  conversationId?: string
  options?: string[]
  timestamp: string
  metadata?: ConversationMessageMetadata
  artifact?: {
    filename: string
    description?: string
  }
}

export interface TicketMessagesResponse {
  messages: TicketMessage[]
}

export interface ArtifactChatMessage {
  type: 'question' | 'user' | 'error' | 'system'
  text: string
  conversationId?: string
  options?: string[]
  timestamp: string
}

export interface ArtifactChatPendingResponse {
  question?: {
    conversationId: string
    question: string
    options?: string[]
    askedAt: string
  }
  sessionActive: boolean
  endReason?: 'completed' | 'error' | 'timeout'
}

export interface ArtifactChatStartResponse {
  sessionId: string
  contextId: string
}

export interface TicketLifecycleConflictPayload {
  code: 'TICKET_LIFECYCLE_CONFLICT'
  message: string
  currentPhase: string
  currentGeneration: number
  retryable: true
}

export interface StaleTicketInputPayload {
  code: 'STALE_TICKET_INPUT'
  message: string
  reason?: string
  currentGeneration: number
  providedGeneration?: number
  expectedQuestionId?: string
  providedQuestionId?: string
  retryable: false
}

export type TicketLifecycleErrorPayload =
  | TicketLifecycleConflictPayload
  | StaleTicketInputPayload
