import type { WriteStream } from 'fs';
import type { IPty } from 'node-pty';
import type { SessionMeta } from '../../types/session.types.js';

export interface SessionCallbackIdentity {
  sessionId: string;
  executionGeneration?: number | null;
}

export interface PhaseEntryTaskSummary {
  totalInPhase: number;
  actionableInPhase: number;
  pendingCount: number;
  inProgressCount: number;
  failedCount: number;
  completedCount: number;
  cancelledCount: number;
  sampleTasks: Array<{
    id: string;
    description: string;
    status: string;
  }>;
}

export interface PhaseEntryContext {
  mode: "fresh_entry" | "re_entry";
  taskSummary: PhaseEntryTaskSummary;
}

export interface ActiveSession {
  process: IPty;
  meta: SessionMeta;
  callbackIdentity?: SessionCallbackIdentity;
  logStream: WriteStream;
  exitPromise: Promise<void>;
  exitResolver: () => void;
  forceKilled?: boolean;
}

export interface RemoteControlState {
  pending: boolean;
  url?: string;
}
