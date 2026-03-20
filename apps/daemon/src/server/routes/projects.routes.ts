import type { Express, Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import { execSync, spawnSync } from "child_process";
import {
  getAllProjectsMap,
  getProjectById,
  createProject,
  updateProject,
  updateProjectTemplate,
  deleteProject,
  deleteProjectScopedData,
} from "../../stores/project.store.js";
import {
  projectWorkflowGetDefault,
  projectWorkflowGet,
  projectWorkflowList,
  projectWorkflowUpdate,
  projectWorkflowDeleteForProject,
  projectWorkflowEnsureDefault,
} from "../../stores/project-workflow.store.js";
import {
  getTemplate,
  getDefaultTemplate,
  getTemplateWithFullPhasesForProject,
  getTemplateWithFullPhasesForContext,
  getTemplateChangelog,
  getAgentPromptForProject,
} from "../../stores/template.store.js";
import {
  copyTemplateToProject,
  copyTemplateToWorkflow,
  getWorkflowChangelog,
  getWorkflowTemplate,
  getProjectTemplate,
  hasProjectTemplate,
  hasProjectAgentOverride,
  getProjectAgentOverride,
  saveProjectAgentOverride,
  deleteProjectAgentOverride,
} from "../../stores/project-template.store.js";
import { listTickets, getTicket, updateTicket } from "../../stores/ticket.store.js";
import { getActiveSessionForTicket } from "../../stores/session.store.js";
import { deleteTicketWithLifecycle } from "../../services/ticket-deletion.service.js";
import {
  resolveTargetPhase,
  getPhaseConfig,
} from "../../services/session/phase-config.js";
import { getUpgradeType } from "../../utils/semver.js";
import type { Project } from "../../types/config.types.js";
import type { TicketPhase } from "../../types/ticket.types.js";
import type { SessionService } from "../../services/session/index.js";
import type { Worker } from "../../types/template.types.js";
import type { Complexity } from "@potato-cannon/shared";

let projects: Map<string, Project> = new Map();

function normalizeTemplateVersion(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return `${value}.0.0`;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? `${trimmed}.0.0` : trimmed;
}

export interface ProjectDeletionReport {
  deletedTickets: number;
  deletedWorkflows: number;
}

interface DeleteProjectWithLifecycleDeps {
  deleteTicketFn?: typeof deleteTicketWithLifecycle;
  listTicketsFn?: typeof listTickets;
  deleteWorkflowsFn?: typeof projectWorkflowDeleteForProject;
  deleteProjectFn?: typeof deleteProject;
  deleteProjectScopedDataFn?: typeof deleteProjectScopedData;
}

export async function deleteProjectWithLifecycle(
  projectId: string,
  sessionService: Pick<SessionService, "terminateTicketSession">,
  deps: DeleteProjectWithLifecycleDeps = {},
): Promise<ProjectDeletionReport> {
  const deleteTicketFn = deps.deleteTicketFn ?? deleteTicketWithLifecycle;
  const listTicketsFn = deps.listTicketsFn ?? listTickets;
  const deleteWorkflowsFn =
    deps.deleteWorkflowsFn ?? projectWorkflowDeleteForProject;
  const deleteProjectFn = deps.deleteProjectFn ?? deleteProject;
  const deleteProjectScopedDataFn =
    deps.deleteProjectScopedDataFn ?? deleteProjectScopedData;
  const tickets = listTicketsFn(projectId, { archived: null });

  for (const ticket of tickets) {
    await deleteTicketFn(projectId, ticket.id, {
      sessionService,
      emitEvent: false,
    });
  }

  const deletedWorkflows = deleteWorkflowsFn(projectId);
  deleteProjectFn(projectId);
  await deleteProjectScopedDataFn(projectId);

  return {
    deletedTickets: tickets.length,
    deletedWorkflows,
  };
}

export async function ensureProjectHasDefaultWorkflow(
  projectId: string,
  preferredTemplateName?: string,
): Promise<void> {
  const fallbackTemplateName =
    preferredTemplateName ?? (await getDefaultTemplate())?.name;
  projectWorkflowEnsureDefault(projectId, fallbackTemplateName);
}

function resolveCompatibilityWorkflow(projectId: string): {
  id: string;
  templateName: string;
  templateVersion: string;
} {
  const workflows = projectWorkflowList(projectId);
  const defaultWorkflow = projectWorkflowGetDefault(projectId);
  if (defaultWorkflow) {
    return defaultWorkflow;
  }
  if (workflows.length === 1) {
    return workflows[0];
  }
  throw new Error("WORKFLOW_COMPATIBILITY_TARGET_AMBIGUOUS");
}

function validateWorkflowScope(projectId: string, workflowId?: string | null): boolean {
  if (!workflowId) return true;
  const workflow = projectWorkflowGet(workflowId);
  return !!workflow && workflow.projectId === projectId;
}

/**
 * Validate agentType parameter to prevent path traversal.
 * Only allows alphanumeric characters, underscores, and hyphens.
 */
function isValidAgentType(agentType: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(agentType);
}

export async function refreshProjects(): Promise<Map<string, Project>> {
  projects = getAllProjectsMap();
  return projects;
}

export function getProjects(): Map<string, Project> {
  return projects;
}

/**
 * Migrate tickets from a disabled phase to the next enabled phase.
 * Tickets are moved sequentially. Automation is queued and spawned with delays.
 */
async function migrateTicketsFromDisabledPhase(
  projectId: string,
  disabledPhase: string,
  sessionService: SessionService,
): Promise<void> {
  const tickets = await listTickets(projectId, { phase: disabledPhase as TicketPhase });
  if (tickets.length === 0) {
    return;
  }

  console.log(
    `[migrateTicketsFromDisabledPhase] Migrating ${tickets.length} tickets from ${disabledPhase}`,
  );

  const project = getProjectById(projectId);
  if (!project) return;

  const automationQueue: Array<{ ticketId: string; phase: string }> = [];

  // Move tickets sequentially
  for (const ticket of tickets) {
    try {
      const targetPhase = await resolveTargetPhase(
        projectId,
        disabledPhase,
        ticket.workflowId,
      );
      await updateTicket(projectId, ticket.id, {
        phase: targetPhase as TicketPhase,
      });

      console.log(
        `[migrateTicketsFromDisabledPhase] Moved ticket ${ticket.id} from ${disabledPhase} to ${targetPhase}`,
      );

      // Queue automation if target phase has it and ticket has no active session
      const targetConfig = await getPhaseConfig(
        projectId,
        targetPhase,
        ticket.workflowId,
      );
      const hasAutomation =
        targetConfig &&
        targetConfig.workers &&
        targetConfig.workers.length > 0;

      if (hasAutomation && !getActiveSessionForTicket(ticket.id)) {
        automationQueue.push({ ticketId: ticket.id, phase: targetPhase });
      }
    } catch (error) {
      console.error(
        `[migrateTicketsFromDisabledPhase] Failed to migrate ticket ${ticket.id}:`,
        error,
      );
      // Continue with other tickets
    }
  }

  // Spawn queued automation with delays
  for (const item of automationQueue) {
    try {
      await sessionService.spawnForTicket(
        projectId,
        item.ticketId,
        item.phase as TicketPhase,
        project.path,
      );
      await new Promise((resolve) => setTimeout(resolve, 500)); // 500ms delay between spawns
    } catch (error) {
      console.error(
        `[migrateTicketsFromDisabledPhase] Failed to spawn automation for ${item.ticketId}:`,
        error,
      );
    }
  }
}

export function registerProjectRoutes(
  app: Express,
  sessionService: SessionService,
): void {
  app.get("/api/projects", async (_req: Request, res: Response) => {
    try {
      await refreshProjects();

      // Repair legacy projects that somehow have zero/default-less workflows.
      for (const project of projects.values()) {
        try {
          await ensureProjectHasDefaultWorkflow(project.id, project.template?.name);
        } catch (err) {
          console.error(
            `[projects] Failed to ensure default workflow for ${project.id}: ${(err as Error).message}`
          );
        }
      }

      // Migrate existing projects to local templates if needed
      for (const project of projects.values()) {
        if (!project.template) continue;

        try {
          if (!(await hasProjectTemplate(project.id))) {
            const copied = await copyTemplateToProject(project.id, project.template.name);
            updateProjectTemplate(project.id, project.template.name, copied.version);
            console.log(`[projects] Migrated template for project ${project.id}`);
          }
        } catch (err) {
          console.error(`[projects] Failed to migrate template for ${project.id}: ${(err as Error).message}`);
        }
      }

      // Auto-upgrade patch versions
      for (const project of projects.values()) {
        if (!project.template) continue;

        try {
          const localTemplate = await getProjectTemplate(project.id);
          const catalogTemplate = await getTemplate(project.template.name);

          if (localTemplate && catalogTemplate) {
            const currentVersion = localTemplate.version;
            const availableVersion = typeof catalogTemplate.version === "number"
              ? `${catalogTemplate.version}.0.0`
              : catalogTemplate.version;

            const upgradeType = getUpgradeType(currentVersion, availableVersion);

            if (upgradeType === "patch") {
              await copyTemplateToProject(project.id, project.template.name);
              updateProjectTemplate(project.id, project.template.name, availableVersion);
              console.log(`[projects] Auto-upgraded ${project.id} template to ${availableVersion}`);
            }
          }
        } catch {
          // Silently continue if auto-upgrade fails
        }
      }

      // Refresh again after auto-upgrades
      await refreshProjects();

      const list = Array.from(projects.values()).map((p) => ({
        id: p.id,
        slug: p.slug,
        displayName: p.displayName || p.id,
        path: p.path,
        registeredAt: p.registeredAt,
        icon: p.icon,
        color: p.color,
        template: p.template,
        disabledPhases: p.disabledPhases,
        disabledPhaseMigration: p.disabledPhaseMigration,
        swimlaneColors: p.swimlaneColors,
        folderId: p.folderId,
        vcsType: p.vcsType,
        p4Stream: p.p4Stream,
        agentWorkspaceRoot: p.agentWorkspaceRoot,
        helixSwarmUrl: p.helixSwarmUrl,
        suggestedP4Stream: p.suggestedP4Stream,
        providerOverride: p.providerOverride,
      }));
      res.json(list);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/projects", async (req: Request, res: Response) => {
    try {
      const {
        path: projectPath,
        displayName,
        template: templateName,
      } = req.body as {
        path?: string;
        displayName?: string;
        template?: string;
      };

      if (!projectPath) {
        res.status(400).json({ error: "Missing path" });
        return;
      }

      await fs.access(projectPath);

      // Use displayName if provided, otherwise derive from path or git remote
      let name = displayName || path.basename(projectPath);
      try {
        const remote = execSync("git remote get-url origin", {
          cwd: projectPath,
          encoding: "utf-8",
        }).trim();
        const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (match && !displayName) {
          // Use last segment of git remote as display name
          name = match[1].split("/").pop() || match[1];
        }
      } catch {
        // Not a git repo
      }

      // Detect Perforce stream for the project path
      let suggestedP4Stream: string | undefined;
      try {
        const p4InfoResult = spawnSync('p4', ['info'], {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (p4InfoResult.status === 0 && p4InfoResult.stdout) {
          const streamMatch = p4InfoResult.stdout.match(/^Client stream:\s+(.+)$/m);
          if (streamMatch) suggestedP4Stream = streamMatch[1].trim();
        }
      } catch { /* p4 not available or not configured */ }

      let templateToCopy = templateName;
      if (!templateToCopy) {
        const defaultTemplate = await getDefaultTemplate();
        templateToCopy = defaultTemplate?.name;
      }

      // Create project with auto-generated UUID
      const project = createProject({
        displayName: name,
        path: projectPath,
        templateName: templateToCopy,
      });

      await ensureProjectHasDefaultWorkflow(project.id, templateToCopy);

      if (templateToCopy) {
        try {
          const copiedTemplate = await copyTemplateToProject(project.id, templateToCopy);
          updateProjectTemplate(project.id, templateToCopy, copiedTemplate.version);
        } catch (error) {
          console.error(`Failed to copy template: ${(error as Error).message}`);
          // Still register project, just without template
        }
      }

      // Persist the detected stream suggestion so GET /api/projects can return it
      if (suggestedP4Stream) {
        updateProject(project.id, { suggestedP4Stream });
      }

      await refreshProjects();

      // Return the full project object so frontend has id and slug
      const refreshedProject = getProjectById(project.id);
      res.json(refreshedProject);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.delete("/api/projects/:id", async (req: Request, res: Response) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const summary = await deleteProjectWithLifecycle(id, sessionService);
      await refreshProjects();
      res.json({ ok: true, cleanup: summary });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // PATCH /api/projects/:id - Update project settings
  app.patch("/api/projects/:id", async (req: Request, res: Response) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const {
        displayName,
        icon,
        color,
        swimlaneColors,
        folderId,
        p4Stream,
        agentWorkspaceRoot,
        helixSwarmUrl,
        template,
        providerOverride,
        vcsType,
      } = req.body as {
        displayName?: string;
        icon?: string;
        color?: string;
        swimlaneColors?: Record<string, string>;
        folderId?: string | null;
        p4Stream?: string;
        agentWorkspaceRoot?: string;
        helixSwarmUrl?: string;
        template?: string;
        providerOverride?: string | null;
        vcsType?: 'git' | 'perforce';
      };

      const project = getProjectById(id);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      // Auto-assign template when p4Stream is set OR vcsType is explicitly 'perforce',
      // and no template was explicitly supplied by the caller
      const effectiveTemplate = template ?? (
        (p4Stream || vcsType === 'perforce') ? "product-development-p4" : undefined
      );

      const updates: Parameters<typeof updateProject>[1] = {
        displayName,
        icon,
        color,
        swimlaneColors,
        folderId,
        p4Stream,
        agentWorkspaceRoot,
        helixSwarmUrl,
        providerOverride,
        vcsType,
      };

      // Apply core field updates
      updateProject(id, updates);

      // Apply template separately if specified, to resolve version from catalog
      if (effectiveTemplate) {
        const catalogTemplate = await getTemplate(effectiveTemplate);
        if (catalogTemplate) {
          // Copy template files to project if not already present, then record version.
          // Do NOT write DB version unconditionally — if files already exist, preserve
          // the local version so upgrade-detection stays accurate.
          if (!(await hasProjectTemplate(id))) {
            try {
              const copied = await copyTemplateToProject(id, effectiveTemplate);
              updateProjectTemplate(id, effectiveTemplate, copied.version);
            } catch (err) {
              console.error(`[projects] Failed to copy template: ${(err as Error).message}`);
            }
          }
        }
      }

      await refreshProjects();
      const updatedProject = getProjectById(id);
      res.json(updatedProject);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // PATCH /api/projects/:id/disabled-phases - Toggle phase disabled state
  app.patch(
    "/api/projects/:id/disabled-phases",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const { phaseId, disabled } = req.body as {
          phaseId: string;
          disabled: boolean;
        };

        const project = getProjectById(id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }

        // Check for migration in progress
        if (project.disabledPhaseMigration) {
          res.status(409).json({ error: "Migration in progress, please wait" });
          return;
        }

        // Validate phase exists in template
        if (project.template) {
          const template = await getTemplateWithFullPhasesForProject(id);
          const phaseExists = template?.phases.some(
            (p) => p.name === phaseId || p.id === phaseId,
          );
          if (!phaseExists) {
            res.status(400).json({ error: "Invalid phase ID" });
            return;
          }
        }

        // Update disabledPhases array
        const disabledPhases = project.disabledPhases ?? [];
        const updated = disabled
          ? [...new Set([...disabledPhases, phaseId])]
          : disabledPhases.filter((p) => p !== phaseId);

        // If disabling and phase has tickets, need to migrate them
        if (disabled) {
          updateProject(id, {
            disabledPhaseMigration: true,
            disabledPhases: updated,
          });

          try {
            await migrateTicketsFromDisabledPhase(id, phaseId, sessionService);
          } finally {
            // Always clear migration flag, even on partial failure
            updateProject(id, { disabledPhaseMigration: false });
          }
        } else {
          updateProject(id, { disabledPhases: updated });
        }

        const result = getProjectById(id);
        await refreshProjects();
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // PUT /api/projects/:id/template - Apply template to project
  app.put("/api/projects/:id/template", async (req: Request, res: Response) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const { name } = req.body;

      const template = await getTemplate(name);
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }

      const project = updateProjectTemplate(id, name, template.version);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      await refreshProjects();
      res.json(project);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // GET /api/projects/:id/template-status - Check for template updates
  app.get(
    "/api/projects/:id/template-status",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const workflow = resolveCompatibilityWorkflow(id);
        const localTemplate = await getWorkflowTemplate(id, workflow.id);
        const currentVersion =
          normalizeTemplateVersion(localTemplate?.version) ??
          normalizeTemplateVersion(workflow.templateVersion);
        const catalogTemplate = await getTemplate(workflow.templateName);
        const availableVersion = normalizeTemplateVersion(catalogTemplate?.version);
        const upgradeType =
          currentVersion && availableVersion
            ? getUpgradeType(currentVersion, availableVersion)
            : null;

        res.json({
          current: currentVersion,
          available: availableVersion,
          upgradeType,
          workflowId: workflow.id,
          deprecated: true,
        });
      } catch (error) {
        if ((error as Error).message === "WORKFLOW_COMPATIBILITY_TARGET_AMBIGUOUS") {
          res.status(409).json({
            error:
              "Project-level template status is deprecated and could not resolve a single workflow target safely.",
            code: "WORKFLOW_COMPATIBILITY_TARGET_AMBIGUOUS",
          });
          return;
        }
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // GET /api/projects/:id/template-changelog - Get changelog for template updates
  app.get(
    "/api/projects/:id/template-changelog",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const workflow = resolveCompatibilityWorkflow(id);
        const changelog =
          (await getWorkflowChangelog(id, workflow.id)) ??
          (await getTemplateChangelog(workflow.templateName));
        res.json({ changelog, workflowId: workflow.id, deprecated: true });
      } catch (error) {
        if ((error as Error).message === "WORKFLOW_COMPATIBILITY_TARGET_AMBIGUOUS") {
          res.status(409).json({
            error:
              "Project-level template changelog is deprecated and could not resolve a single workflow target safely.",
            code: "WORKFLOW_COMPATIBILITY_TARGET_AMBIGUOUS",
          });
          return;
        }
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // POST /api/projects/:id/upgrade-template - Upgrade project template
  app.post(
    "/api/projects/:id/upgrade-template",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const workflow = resolveCompatibilityWorkflow(id);
        const localTemplate = await getWorkflowTemplate(id, workflow.id);
        const currentVersion =
          normalizeTemplateVersion(localTemplate?.version) ??
          normalizeTemplateVersion(workflow.templateVersion) ??
          "1.0.0";
        const catalogTemplate = await getTemplate(workflow.templateName);
        const availableVersion = normalizeTemplateVersion(catalogTemplate?.version);
        const upgradeType =
          currentVersion && availableVersion
            ? getUpgradeType(currentVersion, availableVersion)
            : null;

        if (!upgradeType || !availableVersion) {
          res.json({ message: "Already up to date", upgraded: false, deprecated: true });
          return;
        }

        const copied = await copyTemplateToWorkflow(id, workflow.id, workflow.templateName);
        projectWorkflowUpdate(workflow.id, {
          templateVersion: normalizeTemplateVersion(copied.version) ?? availableVersion,
        });

        await refreshProjects();
        res.json({
          upgraded: true,
          previousVersion: currentVersion,
          newVersion: normalizeTemplateVersion(copied.version) ?? availableVersion,
          upgradeType,
          workflowId: workflow.id,
          deprecated: true,
        });
      } catch (error) {
        if ((error as Error).message === "WORKFLOW_COMPATIBILITY_TARGET_AMBIGUOUS") {
          res.status(409).json({
            error:
              "Project-level template upgrade is deprecated and could not resolve a single workflow target safely.",
            code: "WORKFLOW_COMPATIBILITY_TARGET_AMBIGUOUS",
          });
          return;
        }
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // PATCH /api/projects/:projectId/tickets/:ticketId/complexity - Update ticket complexity
  app.patch(
    "/api/projects/:projectId/tickets/:ticketId/complexity",
    async (req: Request, res: Response) => {
      try {
        const { projectId, ticketId } = req.params;
        const { complexity } = req.body as { complexity: string };

        if (!['simple', 'standard', 'complex'].includes(complexity)) {
          res.status(400).json({ error: 'Invalid complexity value' });
          return;
        }

        const existing = await getTicket(projectId, ticketId);
        if (!existing) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }

        const ticket = await updateTicket(projectId, ticketId, { complexity: complexity as Complexity });
        res.json(ticket);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // GET /api/projects/:id/phases - Get phases from project's template
  app.get("/api/projects/:id/phases", async (req: Request, res: Response) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const project = getProjectById(id);

      if (!project?.template) {
        // No template assigned - return just Ideas and Done
        res.json(["Ideas", "Done"]);
        return;
      }

      const template = await getTemplateWithFullPhasesForProject(id);
      if (!template) {
        res.json(["Ideas", "Done"]);
        return;
      }

      const phaseNames = template.phases.map((p) => p.name);
      res.json(phaseNames);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // GET /api/projects/:id/agents/:agentType/override - Get agent override content
  app.get(
    "/api/projects/:id/agents/:agentType/override",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const agentType = decodeURIComponent(req.params.agentType);
        const workflowId = typeof req.query.workflowId === "string"
          ? req.query.workflowId
          : null;

        if (!isValidAgentType(agentType)) {
          res.status(400).json({ error: "Invalid agent type" });
          return;
        }

        const project = getProjectById(id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }

        if (!validateWorkflowScope(id, workflowId)) {
          res.status(400).json({
            error: "workflowId must reference a workflow in this project",
            code: "WORKFLOW_SCOPE_MISMATCH",
          });
          return;
        }

        const agentPath = `agents/${agentType}.md`;

        if (!(await hasProjectAgentOverride(id, agentPath, workflowId))) {
          res.status(404).json({ error: "Override not found" });
          return;
        }

        const content = await getProjectAgentOverride(id, agentPath, workflowId);
        res.json({ content });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // PUT /api/projects/:id/agents/:agentType/override - Create or update agent override
  app.put(
    "/api/projects/:id/agents/:agentType/override",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const agentType = decodeURIComponent(req.params.agentType);
        const workflowId = typeof req.query.workflowId === "string"
          ? req.query.workflowId
          : null;
        const { content } = req.body as { content?: string };

        if (!isValidAgentType(agentType)) {
          res.status(400).json({ error: "Invalid agent type" });
          return;
        }

        if (!content) {
          res.status(400).json({ error: "Content is required" });
          return;
        }

        const project = getProjectById(id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }

        if (!validateWorkflowScope(id, workflowId)) {
          res.status(400).json({
            error: "workflowId must reference a workflow in this project",
            code: "WORKFLOW_SCOPE_MISMATCH",
          });
          return;
        }

        const agentPath = `agents/${agentType}.md`;

        // Verify base agent exists before creating override
        try {
          await getAgentPromptForProject(id, agentPath, workflowId, { includeOverride: false });
        } catch {
          res.status(400).json({ error: "Agent type does not exist in template" });
          return;
        }

        await saveProjectAgentOverride(id, agentPath, content, workflowId);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // DELETE /api/projects/:id/agents/:agentType/override - Remove agent override
  app.delete(
    "/api/projects/:id/agents/:agentType/override",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const agentType = decodeURIComponent(req.params.agentType);
        const workflowId = typeof req.query.workflowId === "string"
          ? req.query.workflowId
          : null;

        if (!isValidAgentType(agentType)) {
          res.status(400).json({ error: "Invalid agent type" });
          return;
        }

        const project = getProjectById(id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }

        if (!validateWorkflowScope(id, workflowId)) {
          res.status(400).json({
            error: "workflowId must reference a workflow in this project",
            code: "WORKFLOW_SCOPE_MISMATCH",
          });
          return;
        }

        const agentPath = `agents/${agentType}.md`;
        await deleteProjectAgentOverride(id, agentPath, workflowId);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // GET /api/projects/:id/agents/:agentType/default - Get default agent prompt
  app.get(
    "/api/projects/:id/agents/:agentType/default",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const agentType = decodeURIComponent(req.params.agentType);
        const workflowId = typeof req.query.workflowId === "string"
          ? req.query.workflowId
          : null;

        if (!isValidAgentType(agentType)) {
          res.status(400).json({ error: "Invalid agent type" });
          return;
        }

        const project = getProjectById(id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }

        const agentPath = `agents/${agentType}.md`;

        try {
          const content = await getAgentPromptForProject(
            id,
            agentPath,
            workflowId,
            { includeOverride: false },
          );
          res.json({ content });
          return;
        } catch {
          // Fall through to 404
        }

        res.status(404).json({ error: "Agent not found in template" });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  // GET /api/projects/:id/phases/:phase/workers - Get worker tree for a phase
  app.get(
    "/api/projects/:id/phases/:phase/workers",
    async (req: Request, res: Response) => {
      try {
        const id = decodeURIComponent(req.params.id);
        const phaseName = decodeURIComponent(req.params.phase);
        const workflowId = typeof req.query.workflowId === "string"
          ? req.query.workflowId
          : null;

        const project = getProjectById(id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }

        if (!project.template) {
          res.json({ workers: [] });
          return;
        }

        const template = await getTemplateWithFullPhasesForContext(id, workflowId);
        if (!template) {
          res.json({ workers: [] });
          return;
        }

        const phase = template.phases.find((p) => p.name === phaseName);
        if (!phase) {
          res.status(404).json({ error: "Phase not found" });
          return;
        }

        // Transform workers to include override status
        async function transformWorkers(
          workers: Worker[] | undefined
        ): Promise<Array<{
          id: string;
          type: string;
          description?: string;
          agentType?: string;
          model?: string;
          hasOverride?: boolean;
          maxAttempts?: number;
          workers?: Array<unknown>;
        }>> {
          if (!workers) return [];

          const result = [];
          for (const worker of workers) {
            const node: {
              id: string;
              type: string;
              description?: string;
              agentType?: string;
              model?: string;
              hasOverride?: boolean;
              skipOnFirstIteration?: boolean;
              maxAttempts?: number;
              workers?: Array<unknown>;
            } = {
              id: worker.id,
              type: worker.type,
              description: worker.description,
            };

            if (worker.type === "agent" && worker.source) {
              // Extract agent type from source path (e.g., "agents/refinement.md" -> "refinement")
              const match = worker.source.match(/agents\/([^.]+)\.md$/);
              if (match) {
                node.agentType = match[1];
                // Check if override exists
                const agentPath = `agents/${match[1]}.md`;
                node.hasOverride = await hasProjectAgentOverride(id, agentPath, workflowId);
              }
              // Model is typically in the worker config but may need template lookup
              // For now, we'll leave model as undefined - can be added later if available
              if (worker.skipOnFirstIteration) {
                node.skipOnFirstIteration = true;
              }
            }

            if (worker.type === "ralphLoop" || worker.type === "taskLoop") {
              node.maxAttempts = worker.maxAttempts;
              if (worker.workers) {
                node.workers = await transformWorkers(worker.workers);
              }
            }

            result.push(node);
          }
          return result;
        }

        const workers = await transformWorkers(phase.workers);
        res.json({ workers });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );
}
