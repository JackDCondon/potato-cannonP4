import type { Express, Request, Response } from "express";
import type { GlobalConfig } from "../../types/config.types.js";

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
}
