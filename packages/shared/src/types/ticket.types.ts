export type Complexity = 'simple' | 'standard' | 'complex'

export type DependencyTier = 'artifact-ready' | 'code-ready'

export interface TicketDependency {
  id: string
  ticketId: string
  dependsOn: string
  tier: DependencyTier
  createdAt: string
}

export interface BlockedByEntry {
  ticketId: string
  title: string
  currentPhase: string
  tier: DependencyTier
  satisfied: boolean
}

export interface Ticket {
  id: string
  title: string
  description?: string
  phase: string
  executionGeneration?: number
  project?: string
  createdAt: string
  updatedAt: string
  images?: string[]
  history: TicketHistoryEntry[]
  archived?: boolean
  archivedAt?: string
  conversationId?: string
  complexity: Complexity
  workflowId?: string
  brainstormId?: string
  blockedBy?: BlockedByEntry[]
}

export interface ArchiveResult {
  ticket: Ticket
  cleanup: {
    worktreeRemoved: boolean
    branchRemoved: boolean
    errors: string[]
  }
}

export interface HistorySessionRecord {
  sessionId: string
  source: string
  startedAt: string
  endedAt?: string
  exitCode?: number
}

export interface TicketHistoryEntry {
  phase: string
  at: string
  sessionId?: string
  sessions?: HistorySessionRecord[]
  endedAt?: string
  metadata?: Record<string, unknown>
}
