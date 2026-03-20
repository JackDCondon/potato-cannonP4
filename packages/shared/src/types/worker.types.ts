import type { ModelTier, ModelTierMap } from './template.types.js'

export interface WorkerNode {
  id: string
  type: 'agent' | 'ralphLoop' | 'taskLoop'
  description?: string
  agentType?: string
  modelTier?: ModelTier | ModelTierMap
  hasOverride?: boolean
  skipOnFirstIteration?: boolean
  maxAttempts?: number
  workers?: WorkerNode[]
}

export interface WorkerTreeResponse {
  workers: WorkerNode[]
}
