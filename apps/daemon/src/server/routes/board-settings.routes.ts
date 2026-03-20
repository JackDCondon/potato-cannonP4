import type { Express, Request, Response } from "express";
import { getProjectWorkflowStore } from "../../stores/project-workflow.store.js";
import {
  getBoardChatNotificationPolicy,
  getBoardPmConfig,
  upsertBoardSettings,
  upsertBoardChatNotificationPolicy,
  deleteBoardSettings,
} from "../../stores/board-settings.store.js";
import type {
  BoardNotificationPreset,
  ChatNotificationCategory,
  ChatNotificationPolicy,
  ChatNotificationPolicyInput,
  PmConfig,
} from "@potato-cannon/shared";

// =============================================================================
// Validation helpers
// =============================================================================

const VALID_PM_MODES = new Set(["passive", "watching", "executing"]);
const VALID_NOTIFICATION_PRESETS = new Set<BoardNotificationPreset>([
  "all",
  "important_only",
  "questions_only",
  "mute_all",
]);
const VALID_NOTIFICATION_CATEGORIES = new Set<ChatNotificationCategory>([
  "builder_updates",
  "pm_alerts",
  "lifecycle_events",
  "questions",
  "critical",
]);

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

  if (body.polling !== undefined && body.polling !== null && typeof body.polling === "object") {
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

function validateChatNotificationPolicy(
  body: ChatNotificationPolicyInput,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (
    body.preset !== undefined &&
    !VALID_NOTIFICATION_PRESETS.has(body.preset)
  ) {
    errors.push({
      field: "preset",
      message: "preset must be one of: all, important_only, questions_only, mute_all",
    });
  }

  if (
    body.categories !== undefined &&
    body.categories !== null &&
    typeof body.categories === "object"
  ) {
    for (const [key, value] of Object.entries(body.categories)) {
      if (!VALID_NOTIFICATION_CATEGORIES.has(key as ChatNotificationCategory)) {
        errors.push({
          field: `categories.${key}`,
          message: `unknown notification category: ${key}`,
        });
        continue;
      }
      if (typeof value !== "boolean") {
        errors.push({
          field: `categories.${key}`,
          message: `categories.${key} must be a boolean`,
        });
      }
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
  // Returns the resolved board settings for the board (defaults applied).
  app.get(
    "/api/projects/:projectId/workflows/:workflowId/settings",
    (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;

        if (!resolveWorkflow(res, projectId, workflowId)) return;

        const pmConfig = getBoardPmConfig(workflowId);
        const chatNotificationPolicy = getBoardChatNotificationPolicy(workflowId);
        res.json({ pmConfig, chatNotificationPolicy });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // PUT /api/projects/:projectId/workflows/:workflowId/settings/notifications
  // Body: Partial<ChatNotificationPolicy>. Upserts persisted phone notification policy.
  app.put(
    "/api/projects/:projectId/workflows/:workflowId/settings/notifications",
    (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;

        if (!resolveWorkflow(res, projectId, workflowId)) return;

        const body = req.body as ChatNotificationPolicyInput;
        const errors = validateChatNotificationPolicy(body);
        if (errors.length > 0) {
          res.status(400).json({ error: "Validation failed", details: errors });
          return;
        }

        const settings = upsertBoardChatNotificationPolicy(workflowId, body);
        const chatNotificationPolicy = getBoardChatNotificationPolicy(workflowId);
        res.json({ chatNotificationPolicy, settings });
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
