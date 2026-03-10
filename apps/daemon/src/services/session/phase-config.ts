import type { Phase } from '../../types/template.types.js';
import { getProjectById, updateProjectTemplate } from '../../stores/project.store.js';
import { getTemplateWithFullPhasesForProject, getWorkflowWithFullPhases } from '../../stores/template.store.js';
import { hasProjectTemplate, copyTemplateToProject } from '../../stores/project-template.store.js';
import { projectWorkflowGet } from '../../stores/project-workflow.store.js';

/**
 * Resolve the full-phases template to use for a given project + optional workflowId.
 *
 * - If workflowId is provided and found: use the global catalog template for that workflow's
 *   templateName (non-default workflows read directly from the global catalog).
 * - Otherwise: use the per-project template copy (default behaviour, supports overrides).
 */
async function resolveTemplate(
  projectId: string,
  workflowId?: string,
): Promise<{ phases: Phase[] } | null> {
  if (workflowId) {
    const workflow = projectWorkflowGet(workflowId);
    if (workflow) {
      // Non-default workflow: read directly from global catalog
      return getWorkflowWithFullPhases(workflow.templateName);
    }
    // workflowId not found — fall through to default project template
  }

  return getTemplateWithFullPhasesForProject(projectId);
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

  // For the default (no workflowId) path, auto-migrate: copy template if project lacks local copy.
  // Non-default workflows use the global catalog directly so no migration is needed.
  if (!workflowId || !projectWorkflowGet(workflowId)) {
    if (!project?.template) {
      throw new Error(`Project ${projectId} has no template assigned`);
    }
    if (!(await hasProjectTemplate(projectId))) {
      try {
        const copied = await copyTemplateToProject(projectId, project.template.name);
        await updateProjectTemplate(projectId, project.template.name, copied.version);
        console.log(`[phase-config] Migrated template for project ${projectId}`);
      } catch (error) {
        console.error(`[phase-config] Failed to migrate template: ${(error as Error).message}`);
        // Continue with global template as fallback
      }
    }
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
  if (!project?.template) {
    return requestedPhase; // No template, can't resolve
  }

  const template = await resolveTemplate(projectId, workflowId);
  if (!template) {
    return requestedPhase;
  }

  const phases = template.phases;
  const startIndex = phases.findIndex(p => p.name === requestedPhase || p.id === requestedPhase);

  if (startIndex === -1) {
    return requestedPhase; // Phase not found, return as-is
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
