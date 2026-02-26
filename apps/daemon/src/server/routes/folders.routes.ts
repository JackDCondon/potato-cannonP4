import type { Express, Request, Response } from "express";
import {
  getAllFolders,
  getFolderById,
  createFolder,
  renameFolder,
  deleteFolder,
} from "../../stores/folder.store.js";
import { eventBus } from "../../utils/event-bus.js";

export function registerFolderRoutes(app: Express): void {
  // GET /api/folders - List all folders
  app.get("/api/folders", (_req: Request, res: Response) => {
    try {
      const folders = getAllFolders();
      res.json(folders);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // POST /api/folders - Create a new folder
  app.post("/api/folders", (req: Request, res: Response) => {
    try {
      const { name } = req.body as { name?: string };

      if (!name || !name.trim()) {
        res.status(400).json({ error: "Folder name is required" });
        return;
      }

      const trimmed = name.trim();

      if (trimmed.length > 100) {
        res.status(400).json({ error: "Folder name must be 100 characters or less" });
        return;
      }

      const folder = createFolder(trimmed);
      eventBus.emit("folder:updated", {});
      res.json(folder);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("UNIQUE constraint failed")) {
        res.status(400).json({ error: "A folder with this name already exists" });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // PATCH /api/folders/:id - Rename a folder
  app.patch("/api/folders/:id", (req: Request, res: Response) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const { name } = req.body as { name?: string };

      if (!name || !name.trim()) {
        res.status(400).json({ error: "Folder name is required" });
        return;
      }

      const trimmed = name.trim();

      if (trimmed.length > 100) {
        res.status(400).json({ error: "Folder name must be 100 characters or less" });
        return;
      }

      const existing = getFolderById(id);
      if (!existing) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }

      const folder = renameFolder(id, trimmed);
      eventBus.emit("folder:updated", {});
      res.json(folder);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("UNIQUE constraint failed")) {
        res.status(400).json({ error: "A folder with this name already exists" });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // DELETE /api/folders/:id - Delete an empty folder
  app.delete("/api/folders/:id", (req: Request, res: Response) => {
    try {
      const id = decodeURIComponent(req.params.id);

      const existing = getFolderById(id);
      if (!existing) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }

      deleteFolder(id);
      eventBus.emit("folder:updated", {});
      res.json({ ok: true });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("Cannot delete folder that contains projects")) {
        res.status(400).json({ error: "Cannot delete a folder that still contains projects" });
        return;
      }
      res.status(500).json({ error: message });
    }
  });
}
