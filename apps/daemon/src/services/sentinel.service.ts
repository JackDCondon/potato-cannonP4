/**
 * Sentinel File Service
 *
 * Writes `.potato-context.json` to each project's root directory on state-change
 * events, giving external tools (like Claude Code) ambient awareness of what
 * Potato Cannon is focused on.
 *
 * Write failures are logged but NEVER propagate — the sentinel is advisory.
 */

import fs from 'fs/promises';
import path from 'path';
import { eventBus } from '../utils/event-bus.js';
import { getProjectById, getAllProjects } from '../stores/project.store.js';
import { listTickets, getTicket } from '../stores/ticket.store.js';
import {
  getActiveSessionForTicket,
} from '../stores/session.store.js';

const SENTINEL_FILENAME = '.potato-context.json';

interface PotatoContext {
  daemonPort: number;
  projectId: string;
  focusTicketId: string | null;
  focusPhase: string | null;
  sessionStatus: 'active' | 'idle';
  lastActivity: string;
  blockedTickets: string[];
  summary: string;
}

/**
 * Atomically write a file: write to .tmp then rename.
 * Prevents partial reads by consumers.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  try {
    await fs.rename(tmpPath, filePath);
  } catch {
    // Clean up orphaned tmp file on rename failure
    await fs.unlink(tmpPath).catch(() => {});
  }
}

/**
 * Build the sentinel context for a project.
 */
async function buildContext(
  projectId: string,
  daemonPort: number,
): Promise<PotatoContext | null> {
  const project = getProjectById(projectId);
  if (!project?.path) return null;

  const tickets = listTickets(projectId);

  // Find focus ticket: the one with an active session, or the most recently updated
  let focusTicketId: string | null = null;
  let focusPhase: string | null = null;
  let sessionStatus: 'active' | 'idle' = 'idle';
  const blockedTickets: string[] = [];

  for (const t of tickets) {
    const activeSession = getActiveSessionForTicket(t.id);
    if (activeSession) {
      focusTicketId = t.id;
      focusPhase = t.phase;
      sessionStatus = 'active';
      break;
    }
  }

  // If no active session, use the first non-terminal ticket
  if (!focusTicketId && tickets.length > 0) {
    const nonTerminal = tickets.find(
      (t) => t.phase !== 'Done' && t.phase !== 'Archived',
    );
    if (nonTerminal) {
      focusTicketId = nonTerminal.id;
      focusPhase = nonTerminal.phase;
    }
  }

  // Collect blocked tickets (those with unsatisfied dependencies)
  for (const t of tickets) {
    if (t.blockedBy && t.blockedBy.some((b: { satisfied: boolean }) => !b.satisfied)) {
      blockedTickets.push(t.id);
    }
  }

  // Build summary
  const activeCount = tickets.filter(
    (t) => t.phase !== 'Done' && t.phase !== 'Archived',
  ).length;
  const summary = focusTicketId
    ? `${activeCount} active ticket(s), focused on ${focusTicketId} (${focusPhase})`
    : `${activeCount} active ticket(s), no current focus`;

  return {
    daemonPort,
    projectId,
    focusTicketId,
    focusPhase,
    sessionStatus,
    lastActivity: new Date().toISOString(),
    blockedTickets,
    summary,
  };
}

/**
 * Write the sentinel file for a project.
 */
async function writeSentinel(
  projectId: string,
  daemonPort: number,
): Promise<void> {
  try {
    const context = await buildContext(projectId, daemonPort);
    if (!context) return;

    const project = getProjectById(projectId);
    if (!project?.path) return;

    const sentinelPath = path.join(project.path, SENTINEL_FILENAME);
    await atomicWrite(sentinelPath, JSON.stringify(context, null, 2) + '\n');
  } catch (error) {
    // Sentinel write failure must never crash or interrupt daemon operation
    console.warn(
      `[sentinel] Failed to write ${SENTINEL_FILENAME} for project ${projectId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Write the sentinel file for every registered project.
 * Call this once at daemon startup (after ghost sessions are cleared) to ensure
 * the sentinel reflects the current, accurate session state rather than a stale
 * value left over from a previous daemon run.
 */
export async function initSentinelForAllProjects(daemonPort: number): Promise<void> {
  const projects = getAllProjects();
  await Promise.allSettled(
    projects.map((p) => writeSentinel(p.id, daemonPort)),
  );
  if (projects.length > 0) {
    console.log(
      `[sentinel] Initialised .potato-context.json for ${projects.length} project(s)`,
    );
  }
}

/**
 * Register EventBus listeners that trigger sentinel writes.
 * Call this once during daemon startup.
 */
export function registerSentinelListeners(daemonPort: number): void {
  const trigger = (data: { projectId?: string }) => {
    if (data.projectId) {
      writeSentinel(data.projectId, daemonPort);
    }
  };

  eventBus.on('ticket:created', trigger);
  eventBus.on('ticket:updated', trigger);
  eventBus.on('session:started', trigger);
  eventBus.on('session:ended', trigger);
  // ticket:paused changes session status perception (PM-managed pauses) — refresh sentinel
  eventBus.on('ticket:paused', trigger);

  console.log('[sentinel] Registered .potato-context.json listeners');
}

/**
 * Ensure `.potato-context.json` is in the project's .gitignore.
 * Safe to call multiple times — only appends if not already present.
 */
export async function ensureSentinelInGitignore(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, '.gitignore');
  try {
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // .gitignore doesn't exist yet — we'll create it
    }

    // Check if already present
    const lines = content.split('\n');
    if (lines.some((line) => line.trim() === SENTINEL_FILENAME)) {
      return;
    }

    // Append with a blank line separator if content exists
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const newEntry = `${separator}\n# Potato Cannon live runtime state\n${SENTINEL_FILENAME}\n`;
    await fs.appendFile(gitignorePath, newEntry, 'utf-8');
  } catch (error) {
    console.warn(
      `[sentinel] Failed to update .gitignore at ${projectPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
