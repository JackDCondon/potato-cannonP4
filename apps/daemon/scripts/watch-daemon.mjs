/**
 * Debounced daemon watcher — replaces `node --watch dist/index.js`.
 *
 * Usage:  node scripts/watch-daemon.mjs
 * Run from apps/daemon/ (cwd must contain dist/).
 *
 * Watches dist/ recursively but debounces restarts by 2 seconds so a tsc
 * rebuild that touches many files only triggers one restart.
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEBOUNCE_MS = 2000;
const distDir = path.resolve("dist");
const entryFile = path.join(distDir, "index.js");

let child = null;
let restartTimer = null;
let restarting = false;
let shuttingDown = false;

function spawnDaemon() {
  console.log(`[watch] Starting dist/index.js (pid will follow)...`);
  child = spawn(process.execPath, [entryFile], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "development" },
  });
  console.log(`[watch] Daemon started (pid ${child.pid})`);

  child.on("exit", (code, signal) => {
    child = null;
    if (shuttingDown || restarting) return;
    const reason = code !== null
      ? `Daemon exited with code ${code}`
      : `Daemon exited with signal ${signal}`;
    console.error(`[watch] ${reason}`);
    process.exit(code ?? 1);
  });
}

function restartDaemon(files) {
  if (shuttingDown) return;
  restarting = true;
  const detail = files.length
    ? ` (${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")})`
    : "";
  console.log(`[watch] File change detected — restarting daemon...${detail}`);
  if (child) {
    child.once("exit", () => {
      restarting = false;
      spawnDaemon();
    });
    child.kill("SIGTERM");
  } else {
    restarting = false;
    spawnDaemon();
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

spawnDaemon();

let changedFiles = new Set();

watch(distDir, { recursive: true }, (_eventType, filename) => {
  if (shuttingDown) return;
  if (!filename?.endsWith(".js")) return;
  changedFiles.add(filename);
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    const files = [...changedFiles];
    changedFiles = new Set();
    restartDaemon(files);
  }, DEBOUNCE_MS);
});
