import type { Express, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { eventBus } from '../../utils/event-bus.js';
import type { SessionService } from '../../services/session/index.js';
import { getActiveSessionForTicket, getSessionsByTicket } from '../../stores/session.store.js';
import { SESSIONS_DIR } from '../../config/paths.js';
import type { ContinuityMode, ContinuityPacketScope, ContinuityReason } from '../../services/session/continuity.types.js';

type ContinuityFields = {
  continuityMode?: ContinuityMode;
  continuityReason?: ContinuityReason;
  continuityScope?: ContinuityPacketScope;
  continuitySummary?: string;
  continuitySourceSessionId?: string;
};

export function continuityFromMetadata(metadata: unknown): ContinuityFields {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  const candidate = metadata as Record<string, unknown>;
  return {
    continuityMode:
      typeof candidate.continuityMode === 'string'
        ? (candidate.continuityMode as ContinuityMode)
        : undefined,
    continuityReason:
      typeof candidate.continuityReason === 'string'
        ? (candidate.continuityReason as ContinuityReason)
        : undefined,
    continuityScope:
      typeof candidate.continuityScope === 'string'
        ? (candidate.continuityScope as ContinuityPacketScope)
        : undefined,
    continuitySummary:
      typeof candidate.continuitySummary === 'string'
        ? candidate.continuitySummary
        : undefined,
    continuitySourceSessionId:
      typeof candidate.continuitySourceSessionId === 'string'
        ? candidate.continuitySourceSessionId
        : undefined,
  };
}

export async function continuityFromSessionLog(
  sessionId: string,
): Promise<ContinuityFields> {
  try {
    const logPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    const content = await fs.readFile(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { type?: string; meta?: Record<string, unknown> };
      if (parsed.type !== 'session_start' || !parsed.meta) {
        continue;
      }
      const continuity = continuityFromMetadata(parsed.meta);
      if (continuity.continuityMode || continuity.continuityReason || continuity.continuitySummary) {
        return continuity;
      }
    }
    return {};
  } catch {
    return {};
  }
}

export function registerSessionRoutes(app: Express, sessionService: SessionService): void {
  // List sessions
  app.get('/api/sessions', async (_req: Request, res: Response) => {
    try {
      const sessions = await sessionService.listSessions();
      res.json(sessions);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get all sessions for a ticket, ordered by startedAt ascending
  app.get('/api/projects/:projectId/tickets/:ticketId/sessions', async (req: Request, res: Response) => {
    try {
      const { ticketId } = req.params;
      const sessions = getSessionsByTicket(ticketId);
      const result = await Promise.all(sessions.map(async (s) => {
        const fromMetadata = continuityFromMetadata(s.metadata);
        const continuity =
          fromMetadata.continuityMode || fromMetadata.continuityReason || fromMetadata.continuitySummary
            ? fromMetadata
            : await continuityFromSessionLog(s.id);

        return {
          ...s,
          status: !s.endedAt ? 'running' : (s.exitCode === 0 || s.exitCode == null) ? 'completed' : 'failed',
          ...continuity,
        };
      }));
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get session log
  app.get('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id;
      const log = await sessionService.getSessionLog(sessionId);
      res.json(log);
    } catch (error) {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // Live session output (SSE)
  app.get('/api/sessions/:id/live', (req: Request, res: Response) => {
    const sessionId = req.params.id;

    if (!sessionService.isActive(sessionId)) {
      res.status(404).json({ error: 'Session not active' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const handler = (data: { sessionId: string; event: unknown }) => {
      if (data.sessionId === sessionId) {
        try {
          res.write(`data: ${JSON.stringify(data.event)}\n\n`);
        } catch {
          eventBus.off('session:output', handler);
        }
      }
    };

    eventBus.on('session:output', handler);

    res.on('close', () => {
      eventBus.off('session:output', handler);
    });
    res.on('error', () => {
      eventBus.off('session:output', handler);
    });
  });

  // Stop session
  app.post('/api/sessions/:id/stop', (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const stopped = sessionService.stopSession(sessionId);
    res.json({ ok: stopped });
  });

  // Get remote control state for a ticket
  app.get('/api/tickets/:projectId/:ticketId/remote-control', (req: Request, res: Response) => {
    const { ticketId } = req.params;

    const activeSession = getActiveSessionForTicket(ticketId);
    if (!activeSession) {
      return res.json({ pending: false, url: null });
    }

    const state = sessionService.getRemoteControlState(activeSession.id);
    res.json({
      sessionId: activeSession.id,
      pending: state?.pending ?? false,
      url: state?.url ?? null,
    });
  });

  // Start remote control for a ticket's active session
  app.post('/api/tickets/:projectId/:ticketId/remote-control/start', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    const { ticketTitle } = req.body as { ticketTitle?: string };

    const activeSession = getActiveSessionForTicket(ticketId);
    if (!activeSession) {
      return res.status(409).json({ error: 'No active session for this ticket' });
    }

    const started = sessionService.startRemoteControl(activeSession.id, ticketTitle ?? ticketId);
    if (!started) {
      return res.status(409).json({ error: 'Cannot start remote control — session not running or RC already active' });
    }

    res.json({ ok: true, sessionId: activeSession.id });
  });
}
