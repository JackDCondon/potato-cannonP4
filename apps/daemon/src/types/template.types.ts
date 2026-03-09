// src/types/template.types.ts

// Worker types
export type WorkerType = "agent" | "ralphLoop" | "taskLoop";

export interface BaseWorker {
  id: string;
  type: WorkerType;
  description?: string;
}

/**
 * Complexity-keyed model map. Each key maps a complexity level to a model spec string.
 * At least one of the keys must be present. When a key is missing, resolveModel falls
 * back to `standard`. Use this in workflow.json to route cheap work to cheaper models.
 */
export interface ComplexityModelMap {
  simple?: string;
  standard?: string;
  complex?: string;
}

/**
 * Model specification — one of three forms:
 *   1. String shortcut or explicit ID:  "haiku" | "claude-sonnet-4-20250514"
 *   2. Object with id (+ optional provider): { id: "...", provider: "anthropic" }
 *   3. Complexity map: { simple: "haiku", standard: "sonnet", complex: "opus" }
 *
 * The complexity map form (3) enables per-ticket cost optimisation; resolveModel
 * selects the right entry at agent-spawn time using the ticket/task complexity level.
 */
export type ModelSpec = string | { id: string; provider?: string } | ComplexityModelMap;

/**
 * Type guard: returns true when `model` is a ComplexityModelMap.
 *
 * Uses a POSITIVE key check rather than checking for the absence of `id`, making
 * it robust against future additions to the ModelSpec union.
 */
export function isComplexityModelMap(model: ModelSpec): model is ComplexityModelMap {
  return (
    typeof model === "object" &&
    !("id" in model) &&
    ("simple" in model || "standard" in model || "complex" in model)
  );
}

export interface AgentWorker extends BaseWorker {
  type: "agent";
  source: string;
  disallowTools?: string[];
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
