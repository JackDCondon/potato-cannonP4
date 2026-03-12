import type { Express, Request, Response } from "express";
import { getProjectWorkflowStore } from "../../stores/project-workflow.store.js";
import { listTicketsForWorkflow } from "../../stores/ticket.store.js";
import { deleteTicketWithLifecycle } from "../../services/ticket-deletion.service.js";
import type { SessionService } from "../../services/session/index.js";
import {
  copyTemplateToWorkflow,
  getWorkflowChangelog,
  getWorkflowTemplate,
} from "../../stores/project-template.store.js";
import { getTemplate, getTemplateChangelog } from "../../stores/template.store.js";
import { getUpgradeType } from "../../utils/semver.js";

export function getWorkflowDeleteConfirmation(workflowId: string): string {
  return `delete-workflow:${workflowId}`;
}

function normalizeVersion(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return `${value}.0.0`;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? `${trimmed}.0.0` : trimmed;
}

export async function getWorkflowTemplateStatus(
  projectId: string,
  workflowId: string,
  deps?: {
    store?: ReturnType<typeof getProjectWorkflowStore>;
    getWorkflowTemplateFn?: typeof getWorkflowTemplate;
    getTemplateFn?: typeof getTemplate;
  }
): Promise<{
  current: string | null;
  available: string | null;
  upgradeType: "major" | "minor" | "patch" | null;
}> {
  const store = deps?.store ?? getProjectWorkflowStore();
  const getWorkflowTemplateFn = deps?.getWorkflowTemplateFn ?? getWorkflowTemplate;
  const getTemplateFn = deps?.getTemplateFn ?? getTemplate;
  const workflow = store.getWorkflow(workflowId);
  if (!workflow || workflow.projectId !== projectId) {
    throw new Error("Workflow not found");
  }

  const localTemplate = await getWorkflowTemplateFn(projectId, workflowId);
  const current =
    normalizeVersion(localTemplate?.version) ?? normalizeVersion(workflow.templateVersion);
  const catalog = await getTemplateFn(workflow.templateName);
  const available = normalizeVersion(catalog?.version);
  const upgradeType =
    current && available ? getUpgradeType(current, available) : null;

  return { current, available, upgradeType };
}

export function registerWorkflowRoutes(
  app: Express,
  sessionService: SessionService,
): void {
  // GET /api/projects/:projectId/workflows - list all workflows for a project
  app.get(
    "/api/projects/:projectId/workflows",
    (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const store = getProjectWorkflowStore();
        const workflows = store.listWorkflows(projectId);
        res.json(workflows);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // POST /api/projects/:projectId/workflows - create a new workflow
  app.post(
    "/api/projects/:projectId/workflows",
    async (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const { name, templateName } = req.body as {
          name?: string;
          templateName?: string;
        };

        if (!name || !name.trim()) {
          res.status(400).json({ error: "name is required" });
          return;
        }

        if (!templateName || !templateName.trim()) {
          res.status(400).json({ error: "templateName is required" });
          return;
        }

        const store = getProjectWorkflowStore();
        let workflow = store.createWorkflow({
          projectId,
          name: name.trim(),
          templateName: templateName.trim(),
        });
        const localTemplate = await copyTemplateToWorkflow(
          projectId,
          workflow.id,
          workflow.templateName
        );
        workflow =
          store.updateWorkflow(workflow.id, {
            templateVersion: normalizeVersion(localTemplate.version) ?? "1.0.0",
          }) ?? workflow;

        res.status(201).json(workflow);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // PATCH /api/projects/:projectId/workflows/:workflowId - update a workflow
  app.patch(
    "/api/projects/:projectId/workflows/:workflowId",
    async (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;
        const { name, templateName, isDefault } = req.body as {
          name?: string;
          templateName?: string;
          isDefault?: boolean;
        };

        const store = getProjectWorkflowStore();
        const existing = store.getWorkflow(workflowId);

        if (!existing) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        const updates: { name?: string; templateName?: string; isDefault?: boolean } = {};

        if (name !== undefined) {
          if (!name.trim()) {
            res.status(400).json({ error: "name cannot be empty" });
            return;
          }
          updates.name = name.trim();
        }

        if (templateName !== undefined) {
          if (!templateName.trim()) {
            res.status(400).json({ error: "templateName cannot be empty" });
            return;
          }
          updates.templateName = templateName.trim();
        }

        if (isDefault !== undefined) {
          if (isDefault === false) {
            res.status(400).json({
              error:
                "Cannot clear isDefault - set another workflow as default first",
            });
            return;
          }
          updates.isDefault = isDefault;
        }

        let updated = store.updateWorkflow(workflowId, updates);
        if (!updated) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        if (templateName !== undefined && templateName.trim()) {
          const localTemplate = await copyTemplateToWorkflow(
            projectId,
            workflowId,
            updated.templateName
          );
          updated =
            store.updateWorkflow(workflowId, {
              templateVersion: normalizeVersion(localTemplate.version) ?? "1.0.0",
            }) ?? updated;
        }
        res.json(updated);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  app.get(
    "/api/projects/:projectId/workflows/:workflowId/template-status",
    async (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;
        const status = await getWorkflowTemplateStatus(projectId, workflowId);
        res.json(status);
      } catch (error) {
        if ((error as Error).message === "Workflow not found") {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  app.get(
    "/api/projects/:projectId/workflows/:workflowId/template-changelog",
    async (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;
        const store = getProjectWorkflowStore();
        const workflow = store.getWorkflow(workflowId);
        if (!workflow || workflow.projectId !== projectId) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        const local = await getWorkflowChangelog(projectId, workflowId);
        const changelog = local ?? (await getTemplateChangelog(workflow.templateName));
        res.json({ changelog });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  app.post(
    "/api/projects/:projectId/workflows/:workflowId/upgrade-template",
    async (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;
        const store = getProjectWorkflowStore();
        const workflow = store.getWorkflow(workflowId);
        if (!workflow || workflow.projectId !== projectId) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        const status = await getWorkflowTemplateStatus(projectId, workflowId);
        if (!status.upgradeType || !status.available) {
          res.json({ message: "Already up to date", upgraded: false });
          return;
        }

        const copied = await copyTemplateToWorkflow(
          projectId,
          workflowId,
          workflow.templateName
        );
        const updated = store.updateWorkflow(workflowId, {
          templateVersion: normalizeVersion(copied.version) ?? status.available,
        });

        res.json({
          upgraded: true,
          previousVersion: status.current,
          newVersion:
            normalizeVersion(copied.version) ??
            updated?.templateVersion ??
            status.available,
          upgradeType: status.upgradeType,
        });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // GET /api/projects/:projectId/workflows/:workflowId/delete-preview
  app.get(
    "/api/projects/:projectId/workflows/:workflowId/delete-preview",
    (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;
        const store = getProjectWorkflowStore();
        const workflow = store.getWorkflow(workflowId);
        if (!workflow || workflow.projectId !== projectId) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        const preview = store.getWorkflowDeletePreview(projectId, workflowId);
        res.json({
          workflowId,
          ticketCount: preview.ticketCount,
          sampleTicketIds: preview.sampleTicketIds,
          requiresForce: preview.ticketCount > 0,
          expectedConfirmation: getWorkflowDeleteConfirmation(workflowId),
        });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // DELETE /api/projects/:projectId/workflows/:workflowId - delete a workflow
  app.delete(
    "/api/projects/:projectId/workflows/:workflowId",
    async (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;
        const store = getProjectWorkflowStore();

        const workflow = store.getWorkflow(workflowId);
        if (!workflow || workflow.projectId !== projectId) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        if (workflow.isDefault) {
          res.status(400).json({ error: "Cannot delete the default workflow" });
          return;
        }

        const all = store.listWorkflows(projectId);
        if (all.length <= 1) {
          res.status(400).json({ error: "Cannot delete the last workflow in a project" });
          return;
        }

        const preview = store.getWorkflowDeletePreview(projectId, workflowId);
        if (preview.ticketCount > 0) {
          const { force, confirmation } = req.body as {
            force?: boolean;
            confirmation?: string;
          };
          const expectedConfirmation = getWorkflowDeleteConfirmation(workflowId);
          if (force !== true || confirmation !== expectedConfirmation) {
            res.status(400).json({
              error:
                "Deleting a workflow with tickets requires force=true and a matching confirmation token",
              expectedConfirmation,
              ticketCount: preview.ticketCount,
            });
            return;
          }

          const tickets = listTicketsForWorkflow(projectId, workflowId);
          for (const ticket of tickets) {
            await deleteTicketWithLifecycle(projectId, ticket.id, {
              sessionService,
              emitEvent: false,
            });
          }
        }

        const deleted = store.deleteWorkflow(workflowId);
        if (!deleted) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        res.json({ ok: true, deletedTickets: preview.ticketCount });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );
}
