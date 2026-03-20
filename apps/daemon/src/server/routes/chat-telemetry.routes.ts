import type { Express, Request, Response } from "express";

export interface ChatTelemetrySnapshot {
  queueDepth: number;
  activeQuestion: {
    id: string;
    questionId?: string;
    projectId: string;
    ticketId?: string;
    ageSeconds: number;
  } | null;
  providerEventCounts: Array<{
    providerId: string;
    eventType: string;
    count: number;
  }>;
  perTicketQueueDepth: Array<{
    projectId: string;
    ticketId: string;
    count: number;
  }>;
  deadLetterCount: number;
}

export function getChatTelemetrySnapshot(): ChatTelemetrySnapshot {
  return {
    queueDepth: 0,
    activeQuestion: null,
    providerEventCounts: [],
    perTicketQueueDepth: [],
    deadLetterCount: 0,
  };
}

export function registerChatTelemetryRoutes(app: Express): void {
  app.get("/api/chat/telemetry", (_req: Request, res: Response) => {
    try {
      res.json(getChatTelemetrySnapshot());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
}
