import fs from "fs/promises";
import type Database from "better-sqlite3";
import {
  GLOBAL_DIR,
  CONFIG_FILE,
  TASKS_DIR,
  SESSIONS_DIR,
  BRAINSTORMS_DIR,
  PID_FILE,
  DAEMON_INFO_FILE,
} from "../config/paths.js";
import type {
  GlobalConfig,
  DaemonInfo,
  TelegramConfig,
  SlackConfig,
  DaemonConfig,
  LifecycleContinuityConfig,
  AiConfig,
  AiProviderConfig,
} from "../types/index.js";
import { getDatabase } from "./db.js";

// ============================================================================
// SQLite-backed key-value config store
// ============================================================================

interface ConfigRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface ConfigEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface ConfigStore {
  /**
   * Get a config value by key.
   * Returns null if key doesn't exist.
   */
  get<T = unknown>(key: string): T | null;

  /**
   * Set a config value. Creates or updates the key.
   */
  set(key: string, value: unknown): void;

  /**
   * Delete a config key.
   * Returns true if key existed and was deleted, false otherwise.
   */
  delete(key: string): boolean;

  /**
   * Get all config entries as a key-value object.
   */
  getAll(): Record<string, unknown>;

  /**
   * Get Telegram configuration.
   */
  getTelegramConfig(): TelegramConfig | null;

  /**
   * Set Telegram configuration.
   */
  setTelegramConfig(config: TelegramConfig): void;

  /**
   * Get daemon configuration (port, etc).
   */
  getDaemonConfig(): DaemonConfig | null;

  /**
   * Set daemon configuration.
   */
  setDaemonConfig(config: DaemonConfig): void;

  /**
   * Get Slack configuration.
   */
  getSlackConfig(): SlackConfig | null;

  /**
   * Set Slack configuration.
   */
  setSlackConfig(config: SlackConfig): void;
}

/**
 * Create a ConfigStore instance with dependency injection for testing.
 */
export function createConfigStore(db: Database.Database): ConfigStore {
  const getStmt = db.prepare<[string], ConfigRow>(
    "SELECT key, value, updated_at FROM config WHERE key = ?"
  );

  const upsertStmt = db.prepare<[string, string, string]>(
    `INSERT INTO config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const deleteStmt = db.prepare<[string]>("DELETE FROM config WHERE key = ?");

  const getAllStmt = db.prepare<[], ConfigRow>(
    "SELECT key, value, updated_at FROM config"
  );

  return {
    get<T = unknown>(key: string): T | null {
      const row = getStmt.get(key);
      if (!row) return null;

      try {
        return JSON.parse(row.value) as T;
      } catch {
        // If parsing fails, return the raw string
        return row.value as unknown as T;
      }
    },

    set(key: string, value: unknown): void {
      const now = new Date().toISOString();
      const serialized = JSON.stringify(value);
      upsertStmt.run(key, serialized, now);
    },

    delete(key: string): boolean {
      const result = deleteStmt.run(key);
      return result.changes > 0;
    },

    getAll(): Record<string, unknown> {
      const rows = getAllStmt.all();
      const result: Record<string, unknown> = {};

      for (const row of rows) {
        try {
          result[row.key] = JSON.parse(row.value);
        } catch {
          result[row.key] = row.value;
        }
      }

      return result;
    },

    getTelegramConfig(): TelegramConfig | null {
      return this.get<TelegramConfig>("telegram");
    },

    setTelegramConfig(config: TelegramConfig): void {
      this.set("telegram", config);
    },

    getDaemonConfig(): DaemonConfig | null {
      return this.get<DaemonConfig>("daemon");
    },

    setDaemonConfig(config: DaemonConfig): void {
      this.set("daemon", config);
    },

    getSlackConfig(): SlackConfig | null {
      return this.get<SlackConfig>("slack");
    },

    setSlackConfig(config: SlackConfig): void {
      this.set("slack", config);
    },
  };
}

// Singleton instance
let configStoreInstance: ConfigStore | null = null;

/**
 * Get the singleton ConfigStore instance.
 * Must call initDatabase() first.
 */
export function getConfigStore(): ConfigStore {
  if (!configStoreInstance) {
    configStoreInstance = createConfigStore(getDatabase());
  }
  return configStoreInstance;
}

// ============================================================================
// File-based config (legacy, kept for backward compatibility)
// ============================================================================

const DEFAULT_CONFIG: GlobalConfig = {
  telegram: {
    botToken: "",
    userId: "",
    forumGroupId: "",
    mode: "auto",
    threadedWorkflow: false,
    includeTicketContext: true,
    flowControl: {
      maxPendingPerTicket: 1,
      maxPendingGlobal: 2,
    },
  },
  daemon: {
    port: 8443,
    perforce: {
      mcpServerPath: "",
    },
    chatFlow: {
      maxPendingPerContext: 1,
      maxPendingGlobal: 2,
      includeContextInMessages: true,
      preferProviderThreads: true,
    },
    lifecycleHardening: {
      strictStaleDrop: false,
      strictStaleResume409: false,
    },
    lifecycleContinuity: {
      enabled: true,
      allowResumeSameSwimlane: true,
      maxConversationTurns: 12,
      maxSessionEvents: 12,
      maxCharsPerItem: 800,
      maxPromptChars: 16000,
    },
  },
  ai: {
    defaultProvider: "anthropic",
    providers: [
      {
        id: "anthropic",
        models: {
          low: "haiku",
          mid: "sonnet",
          high: "opus",
        },
      },
    ],
  },
};

export const DEFAULT_AI_CONFIG: AiConfig = {
  defaultProvider: "anthropic",
  providers: [
    {
      id: "anthropic",
      models: {
        low: "haiku",
        mid: "sonnet",
        high: "opus",
      },
    },
  ],
};

export const DEFAULT_LIFECYCLE_CONTINUITY_CONFIG: Required<LifecycleContinuityConfig> = {
  enabled: true,
  allowResumeSameSwimlane: true,
  maxConversationTurns: 12,
  maxSessionEvents: 12,
  maxCharsPerItem: 800,
  maxPromptChars: 16000,
};

export function normalizeLifecycleContinuityConfig(config: GlobalConfig): void {
  config.daemon = config.daemon || { port: 8443 };
  config.daemon.lifecycleContinuity = config.daemon.lifecycleContinuity || {};

  if (typeof config.daemon.lifecycleContinuity.enabled !== "boolean") {
    config.daemon.lifecycleContinuity.enabled = DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.enabled;
  }
  if (typeof config.daemon.lifecycleContinuity.allowResumeSameSwimlane !== "boolean") {
    config.daemon.lifecycleContinuity.allowResumeSameSwimlane =
      DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.allowResumeSameSwimlane;
  }

  const maxConversationTurns = config.daemon.lifecycleContinuity.maxConversationTurns;
  if (
    typeof maxConversationTurns !== "number" ||
    !Number.isFinite(maxConversationTurns) ||
    maxConversationTurns < 1
  ) {
    config.daemon.lifecycleContinuity.maxConversationTurns =
      DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxConversationTurns;
  }

  const maxSessionEvents = config.daemon.lifecycleContinuity.maxSessionEvents;
  if (
    typeof maxSessionEvents !== "number" ||
    !Number.isFinite(maxSessionEvents) ||
    maxSessionEvents < 1
  ) {
    config.daemon.lifecycleContinuity.maxSessionEvents =
      DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxSessionEvents;
  }

  const maxCharsPerItem = config.daemon.lifecycleContinuity.maxCharsPerItem;
  if (
    typeof maxCharsPerItem !== "number" ||
    !Number.isFinite(maxCharsPerItem) ||
    maxCharsPerItem < 1
  ) {
    config.daemon.lifecycleContinuity.maxCharsPerItem =
      DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxCharsPerItem;
  }

  const maxPromptChars = config.daemon.lifecycleContinuity.maxPromptChars;
  if (
    typeof maxPromptChars !== "number" ||
    !Number.isFinite(maxPromptChars) ||
    maxPromptChars < 1
  ) {
    config.daemon.lifecycleContinuity.maxPromptChars =
      DEFAULT_LIFECYCLE_CONTINUITY_CONFIG.maxPromptChars;
  }
}

function normalizeTelegramConfig(config: GlobalConfig): void {
  config.telegram = config.telegram || {
    botToken: "",
    userId: "",
    forumGroupId: "",
    mode: "auto",
  };
  if (typeof config.telegram.threadedWorkflow !== "boolean") {
    config.telegram.threadedWorkflow = false;
  }
  if (typeof config.telegram.includeTicketContext !== "boolean") {
    config.telegram.includeTicketContext = true;
  }
  config.telegram.flowControl = config.telegram.flowControl || {};
  const perTicket = config.telegram.flowControl.maxPendingPerTicket;
  const global = config.telegram.flowControl.maxPendingGlobal;
  if (typeof perTicket !== "number" || !Number.isFinite(perTicket) || perTicket < 1) {
    config.telegram.flowControl.maxPendingPerTicket = 1;
  }
  if (typeof global !== "number" || !Number.isFinite(global) || global < 1) {
    config.telegram.flowControl.maxPendingGlobal = 2;
  }
}

function normalizeDaemonConfig(config: GlobalConfig): void {
  config.daemon = config.daemon || { port: 8443 };
  config.daemon.perforce = config.daemon.perforce || {};
  if (typeof config.daemon.perforce.mcpServerPath !== "string") {
    config.daemon.perforce.mcpServerPath = "";
  }
  config.daemon.chatFlow = config.daemon.chatFlow || {};
  if (
    typeof config.daemon.chatFlow.maxPendingPerContext !== "number" ||
    !Number.isFinite(config.daemon.chatFlow.maxPendingPerContext) ||
    config.daemon.chatFlow.maxPendingPerContext < 1
  ) {
    config.daemon.chatFlow.maxPendingPerContext = 1;
  }
  if (
    typeof config.daemon.chatFlow.maxPendingGlobal !== "number" ||
    !Number.isFinite(config.daemon.chatFlow.maxPendingGlobal) ||
    config.daemon.chatFlow.maxPendingGlobal < 1
  ) {
    config.daemon.chatFlow.maxPendingGlobal = 2;
  }
  if (typeof config.daemon.chatFlow.includeContextInMessages !== "boolean") {
    config.daemon.chatFlow.includeContextInMessages = true;
  }
  if (typeof config.daemon.chatFlow.preferProviderThreads !== "boolean") {
    config.daemon.chatFlow.preferProviderThreads = true;
  }
  config.daemon.lifecycleHardening = config.daemon.lifecycleHardening || {};
  if (typeof config.daemon.lifecycleHardening.strictStaleDrop !== "boolean") {
    config.daemon.lifecycleHardening.strictStaleDrop = false;
  }
  if (typeof config.daemon.lifecycleHardening.strictStaleResume409 !== "boolean") {
    config.daemon.lifecycleHardening.strictStaleResume409 = false;
  }
  normalizeLifecycleContinuityConfig(config);
}

export function normalizeAiConfig(config: GlobalConfig): void {
  const ai: Partial<AiConfig> = config.ai ?? {};
  const providersRaw: unknown[] = Array.isArray(ai.providers) ? ai.providers : [];

  const normalizedProviders: AiProviderConfig[] = providersRaw
    .filter(
      (provider): provider is { id: string; models?: Partial<AiProviderConfig["models"]> } =>
        typeof provider === "object" &&
        provider !== null &&
        typeof (provider as { id?: unknown }).id === "string" &&
        (provider as { id: string }).id.trim().length > 0
    )
    .map((provider) => ({
      id: provider.id,
      models: {
        low:
          typeof provider.models?.low === "string" && provider.models.low.trim().length > 0
            ? provider.models.low
            : "haiku",
        mid:
          typeof provider.models?.mid === "string" && provider.models.mid.trim().length > 0
            ? provider.models.mid
            : "sonnet",
        high:
          typeof provider.models?.high === "string" && provider.models.high.trim().length > 0
            ? provider.models.high
            : "opus",
      },
    }));

  config.ai = {
    defaultProvider:
      typeof ai.defaultProvider === "string" && ai.defaultProvider.trim().length > 0
        ? ai.defaultProvider
        : DEFAULT_AI_CONFIG.defaultProvider,
    providers:
      normalizedProviders.length > 0
        ? normalizedProviders
        : DEFAULT_AI_CONFIG.providers.map((provider) => ({
            id: provider.id,
            models: { ...provider.models },
          })),
  };
}

export async function ensureGlobalDir(): Promise<void> {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  await fs.mkdir(TASKS_DIR, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.mkdir(BRAINSTORMS_DIR, { recursive: true });
}

export async function loadGlobalConfig(): Promise<GlobalConfig | null> {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf-8");
    const config = JSON.parse(data) as GlobalConfig;

    // Migrate old telegram config to providers.telegram
    if (config && config.telegram && !config.providers?.telegram) {
      config.providers = config.providers || {};
      config.providers.telegram = config.telegram;
    }

    // Migrate slack config to providers.slack
    if (config && config.slack && !config.providers?.slack) {
      config.providers = config.providers || {};
      config.providers.slack = config.slack;
    }

    normalizeDaemonConfig(config);
    normalizeTelegramConfig(config);
    normalizeAiConfig(config);

    return config;
  } catch {
    return null;
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await ensureGlobalDir();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function createDefaultConfig(): Promise<GlobalConfig> {
  await saveGlobalConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

// ============================================================================
// Daemon runtime files (PID, info) - always file-based
// ============================================================================

export async function readPid(): Promise<number | null> {
  try {
    const pid = await fs.readFile(PID_FILE, "utf-8");
    return parseInt(pid.trim(), 10);
  } catch {
    return null;
  }
}

export async function writePid(pid: number): Promise<void> {
  await ensureGlobalDir();
  await fs.writeFile(PID_FILE, String(pid));
}

export async function removePid(): Promise<void> {
  try {
    await fs.unlink(PID_FILE);
  } catch {
    // Ignore
  }
}

export async function writeDaemonInfo(info: DaemonInfo): Promise<void> {
  await ensureGlobalDir();
  await fs.writeFile(DAEMON_INFO_FILE, JSON.stringify(info, null, 2));
}

export async function readDaemonInfo(): Promise<DaemonInfo | null> {
  try {
    const data = await fs.readFile(DAEMON_INFO_FILE, "utf-8");
    return JSON.parse(data) as DaemonInfo;
  } catch {
    return null;
  }
}

export async function removeDaemonInfo(): Promise<void> {
  try {
    await fs.unlink(DAEMON_INFO_FILE);
  } catch {
    // Ignore
  }
}
