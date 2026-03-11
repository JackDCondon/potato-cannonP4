export interface TelegramConfig {
  botToken: string;
  userId: string;
  forumGroupId?: string;
  mode: 'auto' | 'webhook' | 'polling';
}

export interface SlackConfig {
  appToken: string;   // xapp-... (Socket Mode)
  botToken: string;   // xoxb-... (Web API)
  channelId?: string; // Explicit channel override. Auto-discovered if unset.
}

export interface ProvidersConfig {
  telegram?: TelegramConfig;
  slack?: SlackConfig;
}

export interface DaemonConfig {
  port: number;
  lifecycleHardening?: {
    strictStaleDrop?: boolean;
    strictStaleResume409?: boolean;
  };
}

export interface GlobalConfig {
  // Keep old structure for backward compatibility
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  // New structure
  providers?: ProvidersConfig;
  daemon: DaemonConfig;
}

export interface Project {
  id: string;
  slug: string;  // URL-safe identifier
  displayName: string;
  path: string;
  registeredAt: string;
  icon?: string;
  color?: string;
  template?: {
    name: string;
    version: string; // Semver format "1.0.0"
  };
  disabledPhases?: string[];           // array of phase names that are disabled
  disabledPhaseMigration?: boolean;    // true while migration is in progress
  swimlaneColors?: Record<string, string>;  // phase name -> hex color
  branchPrefix?: string;  // Custom branch prefix (default: 'potato')
  folderId?: string | null;  // FK to folders table
  p4Stream?: string;           // Perforce stream depot path (e.g. //depot/main)
  suggestedP4Stream?: string;  // AI-detected P4 stream (populated on project creation)
  agentWorkspaceRoot?: string; // Root directory for P4 agent workspaces
  helixSwarmUrl?: string;      // Helix Swarm review server URL
}

export interface DaemonInfo {
  url: string;
  port: number;
  pid: number;
  startedAt: string;
}
