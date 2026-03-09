import fs from 'fs';
import { LOG_FILE } from '../config/paths.js';
import { eventBus } from './event-bus.js';

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 3;

export class Logger {
  private logFile: string;
  private stream: fs.WriteStream | null = null;

  constructor(logFile: string = LOG_FILE) {
    this.logFile = logFile;
  }

  async init(): Promise<void> {
    await this.checkRotation();
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });

    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args: unknown[]): void => {
      const msg = this.format('INFO', args);
      this.write(msg, 'INFO', args);
      originalLog.apply(console, args);
    };

    console.warn = (...args: unknown[]): void => {
      const msg = this.format('WARN', args);
      this.write(msg, 'WARN', args);
      originalWarn.apply(console, args);
    };

    console.error = (...args: unknown[]): void => {
      const msg = this.format('ERROR', args);
      this.write(msg, 'ERROR', args);
      originalError.apply(console, args);
    };
  }

  private format(level: string, args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const message = args
      .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ');
    return `[${timestamp}] [${level}] ${message}\n`;
  }

  private write(msg: string, level: 'INFO' | 'WARN' | 'ERROR', rawArgs: unknown[]): void {
    if (this.stream) {
      this.stream.write(msg);
      this.checkRotation();
    }
    // Emit live log entry for frontend log viewer (best-effort, no throw)
    try {
      const message = rawArgs
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ');
      eventBus.emit('log:entry', {
        level: level.toLowerCase(),
        message,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // ignore
    }
  }

  private async checkRotation(): Promise<void> {
    try {
      const stats = fs.statSync(this.logFile);
      if (stats.size >= MAX_SIZE) {
        await this.rotate();
      }
    } catch {
      // File doesn't exist yet
    }
  }

  private async rotate(): Promise<void> {
    if (this.stream) {
      this.stream.end();
    }

    for (let i = MAX_FILES; i >= 1; i--) {
      const older = `${this.logFile}.${i}`;
      const newer = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`;
      try {
        if (i === MAX_FILES) {
          fs.unlinkSync(older);
        }
        fs.renameSync(newer, older);
      } catch {
        // File doesn't exist
      }
    }

    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
    }
  }
}
