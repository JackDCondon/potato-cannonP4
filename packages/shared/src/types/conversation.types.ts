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
