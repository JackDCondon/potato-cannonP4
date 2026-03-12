import type { Express, Request, Response } from "express";
import { getTicket } from "../../stores/ticket.store.js";
import {
  ticketDependencyCreate,
  ticketDependencyDelete,
  ticketDependencyGetWithSatisfaction,
} from "../../stores/ticket-dependency.store.js";
import { projectWorkflowGet } from "../../stores/project-workflow.store.js";
import {
  getWorkflowWithFullPhases,
  WorkflowContextError,
} from "../../stores/template.store.js";
import { eventBus } from "../../utils/event-bus.js";
import type { DependencyTier, TemplatePhase } from "@potato-cannon/shared";

const VALID_TIERS: DependencyTier[] = ["artifact-ready", "code-ready"];

/**
 * Resolve template phases for a ticket's workflow.
 * Uses the ticket's workflowId to look up the workflow, then loads the
 * full-phases template (with synthetic Ideas/Blocked/Done injected).
 *
 * The daemon's internal Phase type is structurally compatible with
 * TemplatePhase at runtime (difference is null vs undefined on optional
 * fields), so the cast is safe.
 */
async function resolveTemplatePhases(
  projectId: string,
  workflowId: string | null | undefined,
): Promise<TemplatePhase[] | null> {
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

  return (template?.phases as TemplatePhase[] | undefined) ?? null;
}

function mapWorkflowContextError(error: unknown): {
  status: 400 | 404 | 409;
  body: { code: string; error: string; message: string; retryable: false };
} | null {
  const isStructuredWorkflowError =
    error instanceof WorkflowContextError ||
    (!!error &&
      typeof error === "object" &&
      typeof (error as { code?: unknown }).code === "string");
  const message = (error as Error | undefined)?.message ?? "";
  const looksLikeWorkflowContextFailure =
    typeof message === "string" && /workflow/i.test(message);

  if (!isStructuredWorkflowError && !looksLikeWorkflowContextFailure) {
    return null;
  }

  const code =
    (error as { code?: string }).code ??
    "WORKFLOW_CONTEXT_ERROR";

  const statusByCode: Record<string, 400 | 404 | 409> = {
    WORKFLOW_ID_REQUIRED: 400,
    WORKFLOW_NOT_FOUND: 404,
    WORKFLOW_SCOPE_MISMATCH: 409,
    WORKFLOW_TEMPLATE_NOT_FOUND: 404,
    WORKFLOW_CONTEXT_ERROR: 409,
  };

  return {
    status: statusByCode[code] ?? 400,
    body: {
      code,
      error: message,
      message,
      retryable: false,
    },
  };
}

export function registerDependencyRoutes(app: Express): void {
  // GET /api/tickets/:project/:id/dependencies
  app.get(
    "/api/tickets/:project/:id/dependencies",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;

        const ticket = await getTicket(projectId, ticketId);
        if (!ticket) {
          res.status(404).json({ error: "Ticket not found" });
          return;
        }

        const phases = await resolveTemplatePhases(projectId, ticket.workflowId);
        if (!phases) {
          res.status(400).json({ error: "Could not resolve template phases for ticket" });
          return;
        }

        const dependencies = ticketDependencyGetWithSatisfaction(ticketId, phases);
        res.json(dependencies);
      } catch (error) {
        const workflowError = mapWorkflowContextError(error);
        if (workflowError) {
          res.status(workflowError.status).json(workflowError.body);
          return;
        }
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // POST /api/tickets/:project/:id/dependencies
  app.post(
    "/api/tickets/:project/:id/dependencies",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const { dependsOn, tier } = req.body as {
          dependsOn?: string;
          tier?: DependencyTier;
        };

        if (!dependsOn) {
          res.status(400).json({ error: "Missing dependsOn" });
          return;
        }
        if (!tier || !VALID_TIERS.includes(tier)) {
          res.status(400).json({
            error: `Invalid tier. Must be one of: ${VALID_TIERS.join(", ")}`,
          });
          return;
        }

        const dependency = ticketDependencyCreate(ticketId, dependsOn, tier);

        // Emit updates for both tickets
        const ticket = await getTicket(projectId, ticketId);
        eventBus.emit("ticket:updated", { projectId, ticket });
        const depTicket = await getTicket(projectId, dependsOn);
        if (depTicket) {
          eventBus.emit("ticket:updated", { projectId, ticket: depTicket });
        }

        res.status(201).json(dependency);
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes("cycle") || message.includes("UNIQUE constraint")) {
          res.status(409).json({ error: message });
          return;
        }
        if (
          message.includes("no workflow_id") ||
          message.includes("same workflow") ||
          message.includes("has no workflow")
        ) {
          res.status(400).json({ error: message });
          return;
        }
        if (message.includes("not found")) {
          res.status(404).json({ error: message });
          return;
        }
        res.status(500).json({ error: message });
      }
    },
  );

  // DELETE /api/tickets/:project/:id/dependencies
  app.delete(
    "/api/tickets/:project/:id/dependencies",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const dependsOn = req.query.dependsOn as string | undefined;

        if (!dependsOn) {
          res.status(400).json({ error: "Missing dependsOn query parameter" });
          return;
        }

        const deleted = ticketDependencyDelete(ticketId, dependsOn);
        if (!deleted) {
          res.status(404).json({ error: "Dependency not found" });
          return;
        }

        // Emit updates for both tickets
        const ticket = await getTicket(projectId, ticketId);
        if (ticket) {
          eventBus.emit("ticket:updated", { projectId, ticket });
        }
        const depTicket = await getTicket(projectId, dependsOn);
        if (depTicket) {
          eventBus.emit("ticket:updated", { projectId, ticket: depTicket });
        }

        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );
}
