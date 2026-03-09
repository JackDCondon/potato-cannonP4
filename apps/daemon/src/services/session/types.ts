import type { WriteStream } from 'fs';
import type { IPty } from 'node-pty';
import type { SessionMeta } from '../../types/session.types.js';

export interface ActiveSession {
  process: IPty;
  meta: SessionMeta;
  logStream: WriteStream;
  exitPromise: Promise<void>;
  exitResolver: () => void;
  forceKilled?: boolean;
}

export interface RemoteControlState {
  pending: boolean;
  url?: string;
}
