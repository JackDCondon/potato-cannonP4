import type { DependencyTier } from './ticket.types.js'

export interface Template {
  name: string
  description?: string
  version: number
  isDefault?: boolean
  phases: TemplatePhase[]
  createdAt: string
  updatedAt: string
}

export interface TemplatePhase {
  id: string
  name: string
  description?: string
  requiresWorktree?: boolean
  transitions?: {
    next?: string
    manual?: boolean
  }
  output?: {
    artifacts?: string[]
  }
  unblocksTier?: DependencyTier | null
  blocksOnUnsatisfiedTiers?: DependencyTier[]
  workers?: TemplateWorker[]
  agents?: TemplateAgent[]
  ralphLoop?: RalphLoopConfig
  ticketLoop?: TicketLoopConfig
}

export interface TemplateWorker {
  id: string
  type: 'agent' | 'ralphLoop' | 'taskLoop'
  description?: string
  source?: string
  workers?: TemplateWorker[]
  maxAttempts?: number
}

export interface TemplateAgent {
  id?: string
  type: string
  role: 'primary' | 'adversarial' | 'validation'
  description?: string
  prompt?: string
  modelTier?: ModelTier | ModelTierMap
  context?: {
    artifacts?: string[]
  }
}

export type ModelTier = 'low' | 'mid' | 'high'

export interface ModelTierMap {
  simple?: ModelTier
  standard?: ModelTier
  complex?: ModelTier
}

export interface RalphLoopConfig {
  loopId: string
  maxAttempts: number
  agents: TemplateAgent[]
}

export interface TicketLoopConfig {
  loopId: string
  input: string[]
  agents?: TemplateAgent[]
  ralphLoop?: RalphLoopConfig
}
