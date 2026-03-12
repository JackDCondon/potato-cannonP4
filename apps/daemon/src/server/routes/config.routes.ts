import type { Express, Request, Response } from "express";
import type { GlobalConfig } from "../../types/config.types.js";
import { DEFAULT_AI_CONFIG } from "../../stores/config.store.js";

function normalizeAiResponse(config: GlobalConfig | null): {
  defaultProvider: string;
  providers: Array<{ id: string; models: { low: string; mid: string; high: string } }>;
} {
  const ai = config?.ai;
  if (!ai || !Array.isArray(ai.providers) || ai.providers.length === 0) {
    return {
      defaultProvider: DEFAULT_AI_CONFIG.defaultProvider,
      providers: DEFAULT_AI_CONFIG.providers,
    };
  }

  return {
    defaultProvider: ai.defaultProvider || DEFAULT_AI_CONFIG.defaultProvider,
    providers: ai.providers.map((provider) => ({
      id: provider.id,
      models: {
        low: provider.models.low,
        mid: provider.models.mid,
        high: provider.models.high,
      },
    })),
  };
}

export function registerConfigRoutes(
  app: Express,
  getGlobalConfig: () => GlobalConfig | null,
  saveConfig: (config: GlobalConfig) => Promise<void>,
): void {
  app.get("/api/config/global", (_req: Request, res: Response) => {
    const config = getGlobalConfig();
    res.json({
      perforce: {
        mcpServerPath: config?.daemon?.perforce?.mcpServerPath || "",
      },
      ai: normalizeAiResponse(config),
    });
  });

  app.put("/api/config/global/perforce", async (req: Request, res: Response) => {
    try {
      const globalConfig = getGlobalConfig();
      if (!globalConfig) {
        res.status(500).json({ error: "No global config" });
        return;
      }

      const rawPath = (req.body as { mcpServerPath?: unknown })?.mcpServerPath;
      if (rawPath !== undefined && typeof rawPath !== "string") {
        res.status(400).json({ error: "mcpServerPath must be a string" });
        return;
      }

      const mcpServerPath = (rawPath ?? "").trim();
      globalConfig.daemon = globalConfig.daemon || { port: 8443 };
      globalConfig.daemon.perforce = globalConfig.daemon.perforce || {};
      globalConfig.daemon.perforce.mcpServerPath = mcpServerPath;

      await saveConfig(globalConfig);

      res.json({
        ok: true,
        perforce: { mcpServerPath },
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.put("/api/config/global/ai", async (req: Request, res: Response) => {
    try {
      const globalConfig = getGlobalConfig();
      if (!globalConfig) {
        res.status(500).json({ error: "No global config" });
        return;
      }

      const payload = req.body as {
        defaultProvider?: unknown;
        providers?: unknown;
      };

      if (typeof payload.defaultProvider !== "string" || payload.defaultProvider.trim().length === 0) {
        res.status(400).json({ error: "defaultProvider must be a non-empty string" });
        return;
      }
      if (!Array.isArray(payload.providers) || payload.providers.length === 0) {
        res.status(400).json({ error: "providers must be a non-empty array" });
        return;
      }

      const normalizedProviders = payload.providers.map((provider) => {
        const candidate = provider as {
          id?: unknown;
          models?: { low?: unknown; mid?: unknown; high?: unknown };
        };

        if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
          throw new Error("each provider.id must be a non-empty string");
        }
        if (
          typeof candidate.models?.low !== "string" ||
          candidate.models.low.trim().length === 0 ||
          typeof candidate.models?.mid !== "string" ||
          candidate.models.mid.trim().length === 0 ||
          typeof candidate.models?.high !== "string" ||
          candidate.models.high.trim().length === 0
        ) {
          throw new Error(`provider "${candidate.id}" must include models.low, models.mid, and models.high`);
        }

        return {
          id: candidate.id,
          models: {
            low: candidate.models.low,
            mid: candidate.models.mid,
            high: candidate.models.high,
          },
        };
      });

      const uniqueIds = new Set(normalizedProviders.map((provider) => provider.id));
      if (uniqueIds.size !== normalizedProviders.length) {
        res.status(400).json({ error: "provider ids must be unique" });
        return;
      }

      if (!uniqueIds.has(payload.defaultProvider)) {
        res.status(400).json({ error: "defaultProvider must match one of the provider ids" });
        return;
      }

      globalConfig.ai = {
        defaultProvider: payload.defaultProvider,
        providers: normalizedProviders,
      };

      await saveConfig(globalConfig);

      res.json({
        ok: true,
        ai: globalConfig.ai,
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
}
