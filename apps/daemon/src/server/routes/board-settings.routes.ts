import type { Express, Request, Response } from "express";
import { getProjectWorkflowStore } from "../../stores/project-workflow.store.js";
import {
  getBoardPmConfig,
  upsertBoardSettings,
  deleteBoardSettings,
} from "../../stores/board-settings.store.js";
import type { PmConfig } from "@potato-cannon/shared";

// =============================================================================
// Validation helpers
// =============================================================================

const VALID_PM_MODES = new Set(["passive", "watching", "executing"]);

interface ValidationError {
  field: string;
  message: string;
}

function validatePmConfig(body: Partial<PmConfig>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (body.mode !== undefined && !VALID_PM_MODES.has(body.mode)) {
    errors.push({
      field: "mode",
      message: `mode must be one of: passive, watching, executing`,
    });
  }

  if (body.polling !== undefined) {
    const { polling } = body;

    if (
      polling.intervalMinutes !== undefined &&
      (typeof polling.intervalMinutes !== "number" || polling.intervalMinutes < 1)
    ) {
      errors.push({
        field: "polling.intervalMinutes",
        message: "polling.intervalMinutes must be a number >= 1",
      });
    }

    if (
      polling.stuckThresholdMinutes !== undefined &&
      (typeof polling.stuckThresholdMinutes !== "number" ||
        polling.stuckThresholdMinutes < 1)
    ) {
      errors.push({
        field: "polling.stuckThresholdMinutes",
        message: "polling.stuckThresholdMinutes must be a number >= 1",
      });
    }

    if (
      polling.alertCooldownMinutes !== undefined &&
      (typeof polling.alertCooldownMinutes !== "number" ||
        polling.alertCooldownMinutes < 1)
    ) {
      errors.push({
        field: "polling.alertCooldownMinutes",
        message: "polling.alertCooldownMinutes must be a number >= 1",
      });
    }
  }

  return errors;
}

// =============================================================================
// Route helpers
// =============================================================================

/**
 * Verify that a workflow exists and belongs to the given project.
 * Returns the workflow on success, or sends a 404 and returns null.
 */
function resolveWorkflow(
  res: Response,
  projectId: string,
  workflowId: string,
) {
  const store = getProjectWorkflowStore();
  const workflow = store.getWorkflow(workflowId);
  if (!workflow || workflow.projectId !== projectId) {
    res.status(404).json({ error: "Workflow not found" });
    return null;
  }
  return workflow;
}

// =============================================================================
// Route registration
// =============================================================================

export function registerBoardSettingsRoutes(app: Express): void {
  // GET /api/projects/:projectId/workflows/:workflowId/settings
  // Returns the resolved PmConfig for the board (defaults applied).
  app.get(
    "/api/projects/:projectId/workflows/:workflowId/settings",
    (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;

        if (!resolveWorkflow(res, projectId, workflowId)) return;

        const config = getBoardPmConfig(workflowId);
        res.json({ pmConfig: config });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // PUT /api/projects/:projectId/workflows/:workflowId/settings/pm
  // Body: Partial<PmConfig>. Upserts PM config, returns resolved config.
  app.put(
    "/api/projects/:projectId/workflows/:workflowId/settings/pm",
    (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;

        if (!resolveWorkflow(res, projectId, workflowId)) return;

        const body = req.body as Partial<PmConfig>;
        const errors = validatePmConfig(body);
        if (errors.length > 0) {
          res.status(400).json({ error: "Validation failed", details: errors });
          return;
        }

        const settings = upsertBoardSettings(workflowId, body);
        const config = getBoardPmConfig(workflowId);
        res.json({ pmConfig: config, settings });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // DELETE /api/projects/:projectId/workflows/:workflowId/settings/pm
  // Removes board-level PM overrides, reverting to defaults.
  app.delete(
    "/api/projects/:projectId/workflows/:workflowId/settings/pm",
    (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;

        if (!resolveWorkflow(res, projectId, workflowId)) return;

        const deleted = deleteBoardSettings(workflowId);
        const config = getBoardPmConfig(workflowId);
        res.json({ ok: true, deleted, pmConfig: config });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );
}
