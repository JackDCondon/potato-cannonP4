import type { Express, Request, Response } from "express";
import {
  getProjectWorkflowStore,
} from "../../stores/project-workflow.store.js";

export function registerWorkflowRoutes(app: Express): void {
  // GET /api/projects/:projectId/workflows — list all workflows for a project
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

  // POST /api/projects/:projectId/workflows — create a new workflow
  app.post(
    "/api/projects/:projectId/workflows",
    (req: Request, res: Response) => {
      try {
        const { projectId } = req.params;
        const { displayName, templateName } = req.body as {
          displayName?: string;
          templateName?: string;
        };

        if (!displayName || !displayName.trim()) {
          res.status(400).json({ error: "displayName is required" });
          return;
        }

        if (!templateName || !templateName.trim()) {
          res.status(400).json({ error: "templateName is required" });
          return;
        }

        const store = getProjectWorkflowStore();
        const workflow = store.createWorkflow({
          projectId,
          name: displayName.trim(),
          templateName: templateName.trim(),
        });

        res.status(201).json(workflow);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // PATCH /api/projects/:projectId/workflows/:workflowId — update a workflow
  app.patch(
    "/api/projects/:projectId/workflows/:workflowId",
    (req: Request, res: Response) => {
      try {
        const { workflowId } = req.params;
        const { displayName, templateName, isDefault } = req.body as {
          displayName?: string;
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

        if (displayName !== undefined) {
          if (!displayName.trim()) {
            res.status(400).json({ error: "displayName cannot be empty" });
            return;
          }
          updates.name = displayName.trim();
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
                "Cannot clear isDefault — set another workflow as default first",
            });
            return;
          }
          updates.isDefault = isDefault;
        }

        const updated = store.updateWorkflow(workflowId, updates);
        res.json(updated);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // DELETE /api/projects/:projectId/workflows/:workflowId — delete a workflow
  app.delete(
    "/api/projects/:projectId/workflows/:workflowId",
    (req: Request, res: Response) => {
      try {
        const { projectId, workflowId } = req.params;
        const store = getProjectWorkflowStore();

        const workflow = store.getWorkflow(workflowId);
        if (!workflow) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        if (workflow.isDefault) {
          res
            .status(400)
            .json({ error: "Cannot delete the default workflow" });
          return;
        }

        const all = store.listWorkflows(projectId);
        if (all.length <= 1) {
          res
            .status(400)
            .json({ error: "Cannot delete the last workflow in a project" });
          return;
        }

        const deleted = store.deleteWorkflow(workflowId);
        if (!deleted) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );
}
