// src/types/template.types.ts

import type { DependencyTier } from "@potato-cannon/shared";

// Worker types
export type WorkerType = "agent" | "ralphLoop" | "taskLoop";

export type ModelTier = "low" | "mid" | "high";

export interface ModelTierMap {
  simple?: ModelTier;
  standard?: ModelTier;
  complex?: ModelTier;
}

// Transitional alias used by existing runtime resolver code.
export type ModelSpec =
  | string
  | { id: string; provider?: string }
  | { simple?: string; standard?: string; complex?: string }
  | ModelTierMap;

export function isModelTierMap(modelTier: unknown): modelTier is ModelTierMap {
  return (
    typeof modelTier === "object" &&
    modelTier !== null &&
    ("simple" in modelTier || "standard" in modelTier || "complex" in modelTier)
  );
}

// Transitional alias used by existing runtime resolver code.
export function isComplexityModelMap(
  model: ModelSpec,
): model is { simple?: string; standard?: string; complex?: string } | ModelTierMap {
  return (
    typeof model === "object" &&
    model !== null &&
    !("id" in model) &&
    ("simple" in model || "standard" in model || "complex" in model)
  );
}

export interface BaseWorker {
  id: string;
  type: WorkerType;
  description?: string;
}

export interface AgentWorker extends BaseWorker {
  type: "agent";
  source: string;
  disallowTools?: string[];
  modelTier?: ModelTier | ModelTierMap;
  model?: ModelSpec;
}

export interface RalphLoopWorker extends BaseWorker {
  type: "ralphLoop";
  maxAttempts: number;
  workers: Worker[];
}

export interface TaskLoopWorker extends BaseWorker {
  type: "taskLoop";
  maxAttempts: number;
  workers: Worker[]; // Cannot contain TaskLoopWorker
}

export type Worker = AgentWorker | RalphLoopWorker | TaskLoopWorker;

// Phase types
export interface Transitions {
  next: string | null;
  manual?: boolean;
}

export interface Phase {
  id: string;
  name: string;
  description: string;
  workers: Worker[];
  transitions: Transitions;
  /** @deprecated Use requiresIsolation instead */
  requiresWorktree?: boolean;
  requiresIsolation?: boolean;
  unblocksTier?: DependencyTier | null;
  blocksOnUnsatisfiedTiers?: DependencyTier[];
}

// Template types
export interface WorkflowTemplate {
  name: string;
  description: string;
  version: string; // Semver format "1.0.0"
  phases: Phase[];
  /** Optional parent template name for agent prompt fallback lookup */
  parentTemplate?: string;
}

export interface TemplateRegistryEntry {
  name: string;
  version: string; // Semver format "1.0.0"
  isDefault: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateRegistry {
  templates: TemplateRegistryEntry[];
}

export interface ProjectTemplateRef {
  name: string;
  version: string; // Semver format "1.0.0"
}

// Type guards
export function isAgentWorker(worker: Worker): worker is AgentWorker {
  return worker.type === "agent";
}

export function isRalphLoopWorker(worker: Worker): worker is RalphLoopWorker {
  return worker.type === "ralphLoop";
}

export function isTaskLoopWorker(worker: Worker): worker is TaskLoopWorker {
  return worker.type === "taskLoop";
}
