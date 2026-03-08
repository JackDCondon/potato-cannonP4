/**
 * VCS abstraction layer — public API barrel.
 * Re-exports all types and provider implementations for external use.
 */

export type {
  IVCSProvider,
  McpServerConfig,
  WorkspaceCleanupResult,
  WorkspaceInfo,
} from "./types.js";

export { GitProvider } from "./git.provider.js";
export { P4Provider } from "./p4.provider.js";
export type { P4ProviderConfig } from "./p4.provider.js";
export { createVCSProvider } from "./factory.js";
