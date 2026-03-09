import type { Express, Request, Response } from "express";
import fs from "fs/promises";
import { LOG_FILE } from "../../config/paths.js";

const LOG_LINE_RE = /^\[([^\]]+)\] \[(INFO|WARN|ERROR|DEBUG)\] (.+)$/;

/**
 * Parse a raw log line into a structured entry.
 * Lines that don't match the expected format are returned as debug level.
 */
function parseLine(line: string): { timestamp: string; level: string; message: string } {
  const match = LOG_LINE_RE.exec(line);
  if (match) {
    return { timestamp: match[1], level: match[2].toLowerCase(), message: match[3] };
  }
  return { timestamp: new Date().toISOString(), level: "debug", message: line };
}

export function registerSystemRoutes(app: Express): void {
  /**
   * GET /api/system/logs?lines=500
   * Returns the last N lines of daemon.log as parsed LogEntry objects.
   * Capped at 2000 lines. Returns empty array if log file does not exist yet.
   */
  app.get("/api/system/logs", async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.lines ?? "500"), 10) || 500, 2000);

    try {
      const raw = await fs.readFile(LOG_FILE, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const tail = lines.slice(-limit);
      const entries = tail.map(parseLine);
      res.json({ entries });
    } catch {
      // Log file doesn't exist yet — return empty list
      res.json({ entries: [] });
    }
  });
}
