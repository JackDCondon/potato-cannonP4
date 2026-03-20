import type { Express, Request, Response } from "express";
import path from "path";
import multer from "multer";
import { eventBus } from "../../utils/event-bus.js";
import { TASKS_DIR } from "../../config/paths.js";
import {
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  setCurrentHistoryMetadata,
  isTerminalPhase,
  archiveTicket,
  restoreTicket,
  listTicketImages,
  saveTicketImage,
  deleteTicketImage,
  listArtifacts,
  getArtifactContent,
  saveArtifact,
  loadConversations,
  appendConversation,
} from "../../stores/ticket.store.js";
import {
  ticketDependencyGetDependents,
  ticketDependencyGetWithSatisfaction,
} from "../../stores/ticket-dependency.store.js";
import { projectWorkflowGet } from "../../stores/project-workflow.store.js";
import { getWorkflowWithFullPhases, WorkflowContextError } from "../../stores/template.store.js";
import { DEFAULT_PHASES } from "../../types/index.js";
import {
  readQuestion,
  writeResponse,
  clearPendingInteraction,
} from "../../stores/chat.store.js";
import { getActiveSessionForTicket } from "../../stores/session.store.js";
import { getMessages } from "../../stores/conversation.store.js";
import type { SessionService } from "../../services/session/index.js";
import { deleteTicketWithLifecycle } from "../../services/ticket-deletion.service.js";
import { chatService } from "../../services/chat.service.js";
import {
  TicketLifecycleConflictError,
  StaleTicketInputError,
} from "../../services/session/session.service.js";
import type { Project } from "../../types/config.types.js";
import type { Ticket, TicketPhase } from "../../types/ticket.types.js";
import { resolveTargetPhase, getPhaseConfig } from "../../services/session/phase-config.js";
import type { TemplatePhase } from "@potato-cannon/shared";
import { brainstormGetTicketCounts, brainstormGetUsedEpicColors, updateBrainstorm } from "../../stores/brainstorm.store.js";
import { EPIC_BADGE_COLORS } from "@potato-cannon/shared";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

async function resolveTemplatePhases(
  projectId: string,
  workflowId: string | null | undefined,
  cache?: Map<string, TemplatePhase[] | null>,
): Promise<TemplatePhase[] | null> {
  if (!workflowId) {
    throw new WorkflowContextError(
      "WORKFLOW_ID_REQUIRED",
      `workflowId is required for project ${projectId}`,
    );
  }

  const cacheKey = workflowId ?? "__project_default__";
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
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
  const phases = (template?.phases as TemplatePhase[] | undefined) ?? null;
  cache?.set(cacheKey, phases);
  return phases;
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

export function mapLifecycleConflict(error: unknown): {
  status: 409;
  body: {
    code: "TICKET_LIFECYCLE_CONFLICT";
    message: string;
    currentPhase: string;
    currentGeneration: number;
    retryable: true;
  };
} | null {
  if (!(error instanceof TicketLifecycleConflictError)) {
    return null;
  }

  return {
    status: 409,
    body: {
      code: "TICKET_LIFECYCLE_CONFLICT",
      message: error.message,
      currentPhase: error.currentPhase,
      currentGeneration: error.currentGeneration,
      retryable: true,
    },
  };
}

export function mapStaleTicketInput(error: unknown): {
  status: 409;
  body: {
    code: "STALE_TICKET_INPUT";
    message: string;
    reason: string;
    retryable: false;
    currentGeneration: number;
    providedGeneration?: number;
    expectedQuestionId?: string;
    providedQuestionId?: string;
  };
} | null {
  if (!(error instanceof StaleTicketInputError)) {
    return null;
  }

  return {
    status: 409,
    body: {
      code: "STALE_TICKET_INPUT",
      message: error.message,
      reason: error.reason,
      retryable: false,
      currentGeneration: error.currentGeneration,
      providedGeneration: error.providedGeneration,
      expectedQuestionId: error.expectedQuestionId,
      providedQuestionId: error.providedQuestionId,
    },
  };
}

export function registerTicketRoutes(
  app: Express,
  sessionService: SessionService,
  getProjects: () => Map<string, Project>,
  getLifecycleFlags: () => {
    strictStaleResume409: boolean;
    strictStaleDrop: boolean;
  } = () => ({ strictStaleResume409: true, strictStaleDrop: true }),
): void {
  async function isQuestionStaleForCurrentPhase(
    projectId: string,
    ticket: Ticket,
    pendingQuestion: Awaited<ReturnType<typeof readQuestion>>,
  ): Promise<boolean> {
    if (!pendingQuestion) return false;

    if (isTerminalPhase(ticket.phase)) {
      return true;
    }

    const phaseConfig = await getPhaseConfig(
      projectId,
      ticket.phase,
      ticket.workflowId,
    );
    if (!phaseConfig?.workers || phaseConfig.workers.length === 0) {
      return true;
    }

    const askedPhase = pendingQuestion.phase ?? pendingQuestion.phaseAtAsk;
    if (askedPhase && askedPhase !== ticket.phase) {
      return true;
    }

    return false;
  }

  // List tickets
  app.get("/api/tickets/:project", async (req: Request, res: Response) => {
    try {
      const projectId = decodeURIComponent(req.params.project);
      const phase = (req.query.phase as TicketPhase) || null;
      const archivedParam = req.query.archived as string | undefined;
      const workflowId = (req.query.workflowId as string) || null;

      // Parse archived parameter: "true" = only archived, "false" or absent = non-archived
      let archived: boolean | undefined;
      if (archivedParam === "true") {
        archived = true;
      } else if (archivedParam === "false") {
        archived = false;
      }
      // If archivedParam is undefined, archived stays undefined (default = false in store)

      const includeDependencies = true;
      const tickets = await listTickets(projectId, {
        phase,
        archived,
        workflowId,
        includeDependencies,
      });

      if (includeDependencies && tickets.length > 0) {
        const phaseCache = new Map<string, TemplatePhase[] | null>();
        for (const ticket of tickets) {
          const templatePhases = await resolveTemplatePhases(
            projectId,
            ticket.workflowId,
            phaseCache,
          );
          ticket.blockedBy = templatePhases
            ? ticketDependencyGetWithSatisfaction(ticket.id, templatePhases)
            : [];
        }
      }

      res.json(tickets);
    } catch (error) {
      const workflowError = mapWorkflowContextError(error);
      if (workflowError) {
        res.status(workflowError.status).json(workflowError.body);
        return;
      }
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Create ticket
  app.post("/api/tickets/:project", async (req: Request, res: Response) => {
    try {
      const projectId = decodeURIComponent(req.params.project);
      const { title, description, workflowId, brainstormId } = req.body as {
        title?: string;
        description?: string;
        workflowId?: string;
        brainstormId?: string;
      };

      if (!title) {
        res.status(400).json({ error: "Missing title" });
        return;
      }

      const ticket = await createTicket(projectId, { title, description, workflowId, brainstormId });
      eventBus.emit("ticket:created", { projectId, ticket });

      // Auto-transition brainstorm to epic status on first ticket creation (idempotent)
      // Wrapped in try/catch so transition failures don't mask successful ticket creation
      if (brainstormId) {
        try {
          const counts = brainstormGetTicketCounts(brainstormId);
          if (counts.ticketCount === 1) {
            // First ticket created from this brainstorm — transition to epic PM mode
            // Auto-assign a color: pick a random unused color, fall back to full set if all taken
            let autoColor: string | undefined;
            try {
              const usedColors = brainstormGetUsedEpicColors(projectId);
              const usedSet = new Set(usedColors);
              const available = (EPIC_BADGE_COLORS as readonly string[]).filter(c => !usedSet.has(c));
              const pool = available.length > 0 ? available : (EPIC_BADGE_COLORS as readonly string[]);
              autoColor = pool[Math.floor(Math.random() * pool.length)];
            } catch (colorError) {
              console.warn("Failed to auto-assign epic color, proceeding without color", colorError);
            }
            const updated = await updateBrainstorm(projectId, brainstormId, { status: "epic", pmEnabled: true, ...(autoColor ? { color: autoColor } : {}) });
            eventBus.emit("brainstorm:updated", { projectId, brainstorm: updated });
          }
        } catch (transitionError) {
          console.error("Failed to transition brainstorm to epic PM", transitionError);
        }
      }

      res.json(ticket);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get ticket
  app.get("/api/tickets/:project/:id", async (req: Request, res: Response) => {
    try {
      const projectId = decodeURIComponent(req.params.project);
      const ticketId = req.params.id;
      const ticket = await getTicket(projectId, ticketId);
      const templatePhases = await resolveTemplatePhases(
        projectId,
        ticket.workflowId,
      );
      ticket.blockedBy = templatePhases
        ? ticketDependencyGetWithSatisfaction(ticket.id, templatePhases)
        : [];
      res.json(ticket);
    } catch (error) {
      const workflowError = mapWorkflowContextError(error);
      if (workflowError) {
        res.status(workflowError.status).json(workflowError.body);
        return;
      }
      res.status(404).json({ error: "Ticket not found" });
    }
  });

  // Update ticket
  app.put("/api/tickets/:project/:id", async (req: Request, res: Response) => {
    try {
      const projectId = decodeURIComponent(req.params.project);
      const ticketId = req.params.id;
      const updates = req.body as {
        phase?: TicketPhase;
        sessionId?: string;
        overrideDependencies?: boolean;
      };

      const oldTicket = await getTicket(projectId, ticketId);
      const oldPhase = oldTicket.phase;

      // Resolve target phase if moving to a potentially disabled phase
      let resolvedPhase = updates.phase;
      if (updates.phase && updates.phase !== oldPhase) {
        resolvedPhase = (await resolveTargetPhase(
          projectId,
          updates.phase,
          oldTicket.workflowId,
        )) as TicketPhase;
        if (resolvedPhase !== updates.phase) {
          console.log(
            `[updateTicket] Phase ${updates.phase} is disabled, resolved to ${resolvedPhase}`,
          );
        }
      }

      let ticket: Ticket;
      let lifecycleResult:
        | { ticket: Awaited<ReturnType<typeof getTicket>>; executionGeneration: number }
        | null = null;
      if (resolvedPhase && resolvedPhase !== oldPhase) {
        try {
          lifecycleResult = await sessionService.invalidateTicketLifecycle(
            projectId,
            ticketId,
            {
              targetPhase: resolvedPhase,
              expectedPhase: oldPhase,
              expectedGeneration: oldTicket.executionGeneration ?? 0,
            },
          );
          ticket = lifecycleResult.ticket;
        } catch (error) {
          const conflict = mapLifecycleConflict(error);
          if (conflict) {
            res.status(conflict.status).json(conflict.body);
            return;
          }
          throw error;
        }
      } else {
        ticket = await updateTicket(projectId, ticketId, {
          ...updates,
          phase: resolvedPhase,
        });
      }

      if (resolvedPhase && resolvedPhase !== oldPhase && updates.overrideDependencies) {
        const phases = await resolveTemplatePhases(projectId, oldTicket.workflowId);
        if (phases) {
          const unsatisfiedDeps = ticketDependencyGetWithSatisfaction(
            ticketId,
            phases,
          ).filter((dep) => !dep.satisfied);

          setCurrentHistoryMetadata(ticketId, {
            overriddenDependencies: unsatisfiedDeps,
          });
          ticket = await getTicket(projectId, ticketId);
        }
      }

      eventBus.emit("ticket:updated", { projectId, ticket });

      if (resolvedPhase && resolvedPhase !== oldPhase) {
        const dependents = ticketDependencyGetDependents(ticketId);
        for (const dependent of dependents) {
          try {
            const dependentTicket = await getTicket(projectId, dependent.ticketId);
            eventBus.emit("ticket:updated", { projectId, ticket: dependentTicket });
          } catch {
            // Ignore dependent rows that no longer resolve.
          }
        }

        eventBus.emit("ticket:moved", {
          projectId,
          ticketId,
          from: oldPhase,
          to: resolvedPhase,
        });

        // Check if target phase has automation (workers defined in template)
        const phaseConfig = await getPhaseConfig(
          projectId,
          resolvedPhase,
          ticket.workflowId ?? oldTicket.workflowId,
        );
        const hasAutomation = phaseConfig?.workers && phaseConfig.workers.length > 0;

        if (hasAutomation) {
          const projects = getProjects();
          const project = projects.get(projectId);
          if (project) {
            const activeSession = getActiveSessionForTicket(ticketId);
            if (activeSession) {
              console.log(
                `Ticket ${ticketId} already has an active session, skipping spawn`,
              );
            } else {
              console.log(
                `Ticket ${ticketId} moved to ${resolvedPhase}, spawning Claude (generation ${
                  lifecycleResult?.executionGeneration ?? "unknown"
                })...`,
              );
              sessionService
                .spawnForTicket(
                  projectId,
                  ticketId,
                  resolvedPhase,
                  project.path,
                )
                .catch((error: Error) => {
                  console.error(
                    `[spawnForTicket] Failed to spawn session: ${error.message}`,
                  );
                });
            }
          }
        }
      }

      res.json(ticket);
    } catch (error) {
      const workflowError = mapWorkflowContextError(error);
      if (workflowError) {
        res.status(workflowError.status).json(workflowError.body);
        return;
      }
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Delete ticket
  app.delete(
    "/api/tickets/:project/:id",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const cleanup = await deleteTicketWithLifecycle(projectId, ticketId, {
          sessionService,
        });
        res.json({ ok: true, cleanup });
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

  // Archive ticket
  app.patch(
    "/api/tickets/:project/:id/archive",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;

        const result = await archiveTicket(projectId, ticketId);
        eventBus.emit("ticket:archived", {
          projectId,
          ticketId,
          ticket: result.ticket,
          cleanup: result.cleanup,
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Restore ticket
  app.patch(
    "/api/tickets/:project/:id/restore",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;

        const ticket = await restoreTicket(projectId, ticketId);
        eventBus.emit("ticket:restored", { projectId, ticketId, ticket });
        res.json(ticket);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // List ticket images
  app.get(
    "/api/tickets/:project/:id/images",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const images = await listTicketImages(projectId, ticketId);
        res.json(images);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Upload image
  app.post(
    "/api/tickets/:project/:id/images",
    upload.single("image"),
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;

        if (!req.file) {
          res.status(400).json({ error: "No image uploaded" });
          return;
        }

        const filename = req.file.originalname || `image-${Date.now()}.png`;
        const image = await saveTicketImage(
          projectId,
          ticketId,
          filename,
          req.file.buffer,
        );

        res.json(image);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Serve ticket image
  app.get(
    "/api/tickets/:project/:id/images/:name",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const filename = req.params.name;

        const safeProjectId = projectId.replace(/\//g, "__");
        const imagePath = path.join(
          TASKS_DIR,
          safeProjectId,
          ticketId,
          "images",
          filename,
        );

        res.sendFile(imagePath);
      } catch (error) {
        res.status(404).json({ error: "Image not found" });
      }
    },
  );

  // Delete image
  app.delete(
    "/api/tickets/:project/:id/images/:name",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const filename = req.params.name;
        await deleteTicketImage(projectId, ticketId, filename);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // List artifacts
  app.get(
    "/api/tickets/:project/:id/artifacts",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const artifacts = await listArtifacts(projectId, ticketId);
        res.json(artifacts);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Get artifact content
  app.get(
    "/api/tickets/:project/:id/artifacts/:filename",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const filename = req.params.filename;

        const content = await getArtifactContent(projectId, ticketId, filename);
        res.type("text/plain").send(content);
      } catch (error) {
        res.status(404).json({ error: "Artifact not found" });
      }
    },
  );

  // Update artifact content (manual edit)
  app.put(
    "/api/tickets/:project/:id/artifacts/:filename",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const filename = req.params.filename;
        const { content } = req.body;

        if (typeof content !== "string") {
          res.status(400).json({ error: "content is required and must be a string" });
          return;
        }

        const result = await saveArtifact(projectId, ticketId, filename, content);

        // Notify listeners so the frontend can update artifact list
        eventBus.emit("ticket:updated", { projectId, ticketId });

        res.json({
          ok: true,
          filename: result.filename,
          isNewVersion: result.isNewVersion,
        });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Get conversations
  app.get(
    "/api/tickets/:project/:id/conversations",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const conversations = await loadConversations(projectId, ticketId);
        res.json(conversations);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Add conversation
  app.post(
    "/api/tickets/:project/:id/conversations",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const entry = req.body;

        if (!entry.id) {
          res.status(400).json({ error: "Missing conversation id" });
          return;
        }

        const conversations = await appendConversation(
          projectId,
          ticketId,
          entry,
        );
        res.json(conversations);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Get pending question for ticket
  app.get(
    "/api/tickets/:project/:id/pending",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;

        let question = await readQuestion(projectId, ticketId);
        if (question) {
          const ticket = await getTicket(projectId, ticketId);
          const stale = await isQuestionStaleForCurrentPhase(
            projectId,
            ticket,
            question,
          );
          if (stale) {
            await clearPendingInteraction(projectId, ticketId);
            question = null;
          }
        }

        res.json({ question });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Submit response to pending question
  app.post(
    "/api/tickets/:project/:id/input",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const { strictStaleResume409 } = getLifecycleFlags();
        const { message, questionId, ticketGeneration } = req.body as {
          message?: string;
          questionId?: string;
          ticketGeneration?: number;
        };

        if (!message) {
          res.status(400).json({ error: "Missing message" });
          return;
        }

        const pendingQuestion = await readQuestion(projectId, ticketId);
        const ticket = await getTicket(projectId, ticketId);
        const currentGeneration = ticket.executionGeneration ?? 0;
        const stalePhaseQuestion = await isQuestionStaleForCurrentPhase(
          projectId,
          ticket,
          pendingQuestion,
        );

        if (stalePhaseQuestion) {
          await clearPendingInteraction(projectId, ticketId);
          const stale = mapStaleTicketInput(
            new StaleTicketInputError(
              "Ticket input is stale for the current phase",
              currentGeneration,
              ticketGeneration,
              pendingQuestion?.questionId,
              questionId,
            ),
          );
          res.status(stale!.status).json(stale!.body);
          return;
        }

        if (
          !pendingQuestion ||
          !pendingQuestion.questionId ||
          pendingQuestion.ticketGeneration === undefined
        ) {
          if (typeof questionId === "string") {
            const reconciliation = await chatService.reconcileWebAnswer(
              { projectId, ticketId },
              questionId,
              message,
            );
            if (reconciliation.found) {
              res.json({
                success: true,
                idempotent: reconciliation.stale,
                queueResolved: reconciliation.accepted,
              });
              return;
            }
          }

          if (!strictStaleResume409) {
            await writeResponse(projectId, ticketId, { answer: message });
            res.json({ success: true });
            return;
          }
          await clearPendingInteraction(projectId, ticketId);
          const stale = mapStaleTicketInput(
            new StaleTicketInputError(
              "No pending lifecycle-aware question for this ticket",
              currentGeneration,
              ticketGeneration,
              pendingQuestion?.questionId,
              questionId,
            ),
          );
          res.status(stale!.status).json(stale!.body);
          return;
        }

        if (typeof questionId !== "string" || typeof ticketGeneration !== "number") {
          if (!strictStaleResume409) {
            await writeResponse(projectId, ticketId, {
              answer: message,
              questionId: pendingQuestion.questionId,
              ticketGeneration: pendingQuestion.ticketGeneration,
            });
            res.json({ success: true });
            return;
          }
          await clearPendingInteraction(projectId, ticketId);
          const stale = mapStaleTicketInput(
            new StaleTicketInputError(
              "Ticket input is missing question identity or generation",
              currentGeneration,
              ticketGeneration,
              pendingQuestion.questionId,
              questionId,
            ),
          );
          res.status(stale!.status).json(stale!.body);
          return;
        }

        if (
          questionId !== pendingQuestion.questionId ||
          ticketGeneration !== pendingQuestion.ticketGeneration ||
          ticketGeneration !== currentGeneration
        ) {
          const reconciliation = await chatService.reconcileWebAnswer(
            { projectId, ticketId },
            questionId,
            message,
          );
          if (reconciliation.found) {
            res.json({
              success: true,
              idempotent: reconciliation.stale,
              queueResolved: reconciliation.accepted,
            });
            return;
          }

          if (!strictStaleResume409) {
            await writeResponse(projectId, ticketId, { answer: message });
            res.json({ success: true });
            return;
          }
          await clearPendingInteraction(projectId, ticketId);
          const stale = mapStaleTicketInput(
            new StaleTicketInputError(
              "Ticket input no longer matches the active lifecycle",
              currentGeneration,
              ticketGeneration,
              pendingQuestion.questionId,
              questionId,
            ),
          );
          res.status(stale!.status).json(stale!.body);
          return;
        }

        await writeResponse(projectId, ticketId, {
          answer: message,
          questionId,
          ticketGeneration,
        });
        const reconciliation = await chatService.reconcileWebAnswer(
          { projectId, ticketId },
          questionId,
          message,
        );

        // Check if there's an active session for this ticket.
        // If not, this is a response to a suspended session — spawn a resumed session.
        const activeSession = getActiveSessionForTicket(ticketId);

        if (!activeSession) {
          const projects = getProjects();
          const project = projects.get(projectId);

          if (project) {
            try {
              const newSessionId = await sessionService.resumeSuspendedTicket(
                projectId,
                ticketId,
                message,
                {
                  questionId,
                  ticketGeneration,
                },
              );
              console.log(`[input] Spawned resumed session ${newSessionId} for suspended ticket ${ticketId}`);
              res.json({
                success: true,
                sessionId: newSessionId,
                resumed: true,
                queueResolved: reconciliation.accepted,
                idempotent: reconciliation.stale,
              });
              return;
            } catch (err) {
              const stale = mapStaleTicketInput(err);
              if (stale) {
                res.status(stale.status).json(stale.body);
                return;
              }
              console.error(`[input] Failed to resume suspended ticket: ${(err as Error).message}`);
              // Fall through — response is already written, blocking session may pick it up
            }
          }
        }

        res.json({
          success: true,
          queueResolved: reconciliation.accepted,
          idempotent: reconciliation.stale,
        });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Get ticket messages (unified chat history)
  app.get(
    "/api/tickets/:project/:id/messages",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;

        const ticket = await getTicket(projectId, ticketId);
        if (!ticket.conversationId) {
          res.json({ messages: [] });
          return;
        }

        const rawMessages = getMessages(ticket.conversationId);

        // Map message id to conversationId for frontend compatibility
        // The frontend uses conversationId for deduplication
        // Also extract artifact from metadata for artifact messages
        const messages = rawMessages.map((msg) => ({
          ...msg,
          conversationId: msg.id,
          // Extract artifact from metadata for frontend compatibility
          artifact: msg.metadata?.artifact as { filename: string; description?: string } | undefined,
        }));

        res.json({ messages });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    },
  );

  // Restart ticket to a specific phase
  // Resume a paused ticket
  app.post(
    "/api/tickets/:project/:id/resume",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;

        const ticket = getTicket(projectId, ticketId);
        if (!ticket) {
          res.status(404).json({ error: "Ticket not found" });
          return;
        }

        if (!ticket.paused) {
          res.status(400).json({ error: "Ticket is not paused" });
          return;
        }

        await sessionService.resumePausedTicket(projectId, ticketId);

        const updatedTicket = getTicket(projectId, ticketId);
        res.json({ ticket: updatedTicket });
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes("not found")) {
          res.status(404).json({ error: message });
        } else {
          res.status(500).json({ error: message });
        }
      }
    },
  );

  app.post(
    "/api/tickets/:project/:id/restart",
    async (req: Request, res: Response) => {
      try {
        const projectId = decodeURIComponent(req.params.project);
        const ticketId = req.params.id;
        const { targetPhase } = req.body as { targetPhase?: string };

        if (!targetPhase) {
          res.status(400).json({ error: "Missing targetPhase" });
          return;
        }

        const { restartToPhase } = await import(
          "../../services/ticket-restart.service.js"
        );

        const result = await restartToPhase(
          projectId,
          ticketId,
          targetPhase,
          sessionService,
        );

        // Emit events for UI updates
        eventBus.emit("ticket:restarted", {
          projectId,
          ticketId,
          targetPhase,
          ticket: result.ticket,
        });
        eventBus.emit("ticket:updated", { projectId, ticket: result.ticket });

        res.json(result);
      } catch (error) {
        const conflict = mapLifecycleConflict(error);
        if (conflict) {
          res.status(conflict.status).json(conflict.body);
          return;
        }
        const message = (error as Error).message;
        if (message.includes("not found")) {
          res.status(404).json({ error: message });
        } else if (message.includes("archived") || message.includes("history")) {
          res.status(400).json({ error: message });
        } else {
          res.status(500).json({ error: message });
        }
      }
    },
  );

  // Phases reference
  app.get("/api/phases", (_req: Request, res: Response) => {
    res.json(DEFAULT_PHASES);
  });
}
