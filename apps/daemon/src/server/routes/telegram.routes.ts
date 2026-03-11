import type { Express, Request, Response } from 'express';
import type { GlobalConfig } from '../../types/config.types.js';

export function registerTelegramRoutes(
  app: Express,
  getGlobalConfig: () => GlobalConfig | null,
  saveConfig: (config: GlobalConfig) => Promise<void>
): void {
  // Get telegram config
  app.get('/api/config/telegram', (_req: Request, res: Response) => {
    const globalConfig = getGlobalConfig();
    const config = globalConfig?.telegram;
    res.json({
      configured: !!(config?.botToken && config?.userId),
      hasForumGroup: !!config?.forumGroupId,
      mode: config?.mode || 'auto',
      threadedWorkflow: config?.threadedWorkflow ?? false,
      includeTicketContext: config?.includeTicketContext ?? true,
      flowControl: {
        maxPendingPerTicket: config?.flowControl?.maxPendingPerTicket ?? 1,
        maxPendingGlobal: config?.flowControl?.maxPendingGlobal ?? 2,
      },
    });
  });

  // Update forum group
  app.put('/api/config/telegram/forum', async (req: Request, res: Response) => {
    try {
      const { forumGroupId } = req.body as { forumGroupId?: string };
      const globalConfig = getGlobalConfig();

      if (!globalConfig) {
        res.status(500).json({ error: 'No global config' });
        return;
      }

      if (!globalConfig.telegram) {
        globalConfig.telegram = {
          botToken: '',
          userId: '',
          mode: 'auto',
          threadedWorkflow: false,
          includeTicketContext: true,
          flowControl: {
            maxPendingPerTicket: 1,
            maxPendingGlobal: 2,
          },
        };
      }

      globalConfig.telegram.forumGroupId = forumGroupId || '';
      await saveConfig(globalConfig);

      res.json({
        ok: true,
        forumGroupId: globalConfig.telegram.forumGroupId,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Update Telegram flow controls and message/thread settings
  app.put('/api/config/telegram/flow-control', async (req: Request, res: Response) => {
    try {
      const {
        maxPendingPerTicket,
        maxPendingGlobal,
        threadedWorkflow,
        includeTicketContext,
      } = req.body as {
        maxPendingPerTicket?: number;
        maxPendingGlobal?: number;
        threadedWorkflow?: boolean;
        includeTicketContext?: boolean;
      };
      const globalConfig = getGlobalConfig();

      if (!globalConfig) {
        res.status(500).json({ error: 'No global config' });
        return;
      }

      if (!globalConfig.telegram) {
        globalConfig.telegram = {
          botToken: '',
          userId: '',
          mode: 'auto',
          threadedWorkflow: false,
          includeTicketContext: true,
          flowControl: {
            maxPendingPerTicket: 1,
            maxPendingGlobal: 2,
          },
        };
      }

      const nextPerTicket = Number.isFinite(maxPendingPerTicket) && (maxPendingPerTicket as number) >= 1
        ? Math.floor(maxPendingPerTicket as number)
        : (globalConfig.telegram.flowControl?.maxPendingPerTicket ?? 1);
      const nextGlobal = Number.isFinite(maxPendingGlobal) && (maxPendingGlobal as number) >= 1
        ? Math.floor(maxPendingGlobal as number)
        : (globalConfig.telegram.flowControl?.maxPendingGlobal ?? 2);
      globalConfig.telegram.flowControl = {
        maxPendingPerTicket: nextPerTicket,
        maxPendingGlobal: nextGlobal,
      };
      if (typeof threadedWorkflow === 'boolean') {
        globalConfig.telegram.threadedWorkflow = threadedWorkflow;
      }
      if (typeof includeTicketContext === 'boolean') {
        globalConfig.telegram.includeTicketContext = includeTicketContext;
      }
      await saveConfig(globalConfig);

      res.json({
        ok: true,
        flowControl: globalConfig.telegram.flowControl,
        threadedWorkflow: globalConfig.telegram.threadedWorkflow ?? false,
        includeTicketContext: globalConfig.telegram.includeTicketContext ?? true,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Telegram webhook - now handled by TelegramProvider polling
  // Webhook support can be added later if needed
  app.post('/telegram/webhook', async (_req: Request, res: Response) => {
    res.json({ ok: true, message: 'Webhook endpoint deprecated - using polling mode' });
  });
}
