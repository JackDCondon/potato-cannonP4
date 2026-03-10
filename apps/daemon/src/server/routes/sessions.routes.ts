import type { Express, Request, Response } from 'express';
import { eventBus } from '../../utils/event-bus.js';
import type { SessionService } from '../../services/session/index.js';
import { getActiveSessionForTicket, getSessionsByTicket } from '../../stores/session.store.js';

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
  app.get('/api/projects/:projectId/tickets/:ticketId/sessions', (req: Request, res: Response) => {
    try {
      const { ticketId } = req.params;
      const sessions = getSessionsByTicket(ticketId);
      const result = sessions.map(s => ({
        ...s,
        status: !s.endedAt ? 'running' : (s.exitCode === 0 || s.exitCode == null) ? 'completed' : 'failed',
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
