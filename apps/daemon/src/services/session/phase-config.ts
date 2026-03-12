import type { Phase } from '../../types/template.types.js';
import { getProjectById } from '../../stores/project.store.js';
import {
  getWorkflowWithFullPhases,
  WorkflowContextError,
} from '../../stores/template.store.js';
import { projectWorkflowGet } from '../../stores/project-workflow.store.js';

/**
 * Resolve the full-phases template to use for a given project + optional workflowId.
 *
 * Strictly requires a valid workflowId for this project.
 */
async function resolveTemplate(
  projectId: string,
  workflowId?: string,
): Promise<{ phases: Phase[] } | null> {
  if (!workflowId) {
    throw new WorkflowContextError(
      "WORKFLOW_ID_REQUIRED",
      `workflowId is required for project ${projectId}`,
    );
  }

  const workflow = projectWorkflowGet(workflowId);
  if (!workflow) {
    throw new WorkflowContextError(
      "WORKFLOW_NOT_FOUND",
      `Workflow ${workflowId} was not found`,
    );
  }

  if (workflow.projectId !== projectId) {
    throw new WorkflowContextError(
      "WORKFLOW_SCOPE_MISMATCH",
      `Workflow ${workflowId} does not belong to project ${projectId}`,
    );
  }

  const template = await getWorkflowWithFullPhases(workflow.templateName);
  if (!template) {
    throw new WorkflowContextError(
      "WORKFLOW_TEMPLATE_NOT_FOUND",
      `Template ${workflow.templateName} for workflow ${workflowId} was not found`,
    );
  }
  return template;
}

/**
 * Check if a phase is disabled for a project.
 */
export async function isPhaseDisabled(
  projectId: string,
  phaseName: string,
  _workflowId?: string,
): Promise<boolean> {
  const project = await getProjectById(projectId);
  return project?.disabledPhases?.includes(phaseName) ?? false;
}

/**
 * Get phase configuration from project's template (or the workflow's template if workflowId given).
 * Throws if project has no template assigned (and no valid workflowId override is found).
 */
export async function getPhaseConfig(
  projectId: string,
  phaseName: string,
  workflowId?: string,
): Promise<Phase | null> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const template = await resolveTemplate(projectId, workflowId);
  if (!template) {
    throw new Error(`Template not found for project ${projectId}`);
  }

  return template.phases.find(p => p.id === phaseName || p.name === phaseName) || null;
}

/**
 * Get the next phase after completing the current one.
 */
export async function getNextPhase(
  projectId: string,
  currentPhaseName: string,
  workflowId?: string,
): Promise<string | null> {
  const phase = await getPhaseConfig(projectId, currentPhaseName, workflowId);
  return phase?.transitions?.next || null;
}

/**
 * Resolve the actual target phase, skipping any disabled phases.
 * Returns the first enabled phase starting from the requested phase.
 * If the requested phase is enabled, returns it unchanged.
 * If all subsequent phases are disabled, returns the last phase (Done).
 */
export async function resolveTargetPhase(
  projectId: string,
  requestedPhase: string,
  workflowId?: string,
): Promise<string> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const template = await resolveTemplate(projectId, workflowId);
  if (!template) {
    throw new Error(`Template not found for project ${projectId}`);
  }

  const phases = template.phases;
  const startIndex = phases.findIndex(p => p.name === requestedPhase || p.id === requestedPhase);

  if (startIndex === -1) {
    throw new Error(`Phase ${requestedPhase} not found in workflow template`);
  }

  // Find first enabled phase starting from requestedPhase
  for (let i = startIndex; i < phases.length; i++) {
    const phase = phases[i];
    const isDisabled = project.disabledPhases?.includes(phase.name) ?? false;
    if (!isDisabled) {
      return phase.name;
    }
  }

  // All remaining phases disabled - return last phase (Done)
  return phases[phases.length - 1].name;
}

/**
 * Get the next enabled phase after completing the current one.
 * Used by completePhase() to skip disabled phases.
 */
export async function getNextEnabledPhase(
  projectId: string,
  currentPhaseName: string,
  workflowId?: string,
): Promise<string | null> {
  const nextPhase = await getNextPhase(projectId, currentPhaseName, workflowId);
  if (!nextPhase) {
    return null;
  }
  return resolveTargetPhase(projectId, nextPhase, workflowId);
}

/**
 * Check if a phase requires VCS workspace isolation.
 * Checks requiresIsolation first, falls back to deprecated requiresWorktree.
 */
export async function phaseRequiresIsolation(
  projectId: string,
  phaseName: string,
  workflowId?: string,
): Promise<boolean> {
  const phase = await getPhaseConfig(projectId, phaseName, workflowId);
  return phase?.requiresIsolation ?? phase?.requiresWorktree ?? false;
}
