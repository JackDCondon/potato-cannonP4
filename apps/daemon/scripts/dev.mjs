import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(__dirname, "..");
const daemonEntry = path.join(daemonDir, "dist", "index.js");
const binPath = path.join(daemonDir, "bin", "potato-cannon.js");
const tscBinPath = path.join(daemonDir, "node_modules", "typescript", "bin", "tsc");

const children = new Set();
let shuttingDown = false;

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  });

  children.add(child);
  child.on("exit", () => {
    children.delete(child);
  });

  return child;
}

async function stopExistingDaemon() {
  console.log("Stopping any existing daemon...");

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, "stop"], {
      cwd: daemonDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });

  const lockPath = path.join(
    process.env.USERPROFILE || "",
    ".potato-cannon",
    "daemon.lock.lock",
  );
  const pidPath = path.join(
    process.env.USERPROFILE || "",
    ".potato-cannon",
    "daemon.pid",
  );

  await rm(pidPath, { force: true }).catch(() => {});
  await rm(lockPath, { force: true, recursive: true }).catch(() => {});
}

async function waitForBuildOutput() {
  if (existsSync(daemonEntry)) {
    return;
  }

  console.log("Waiting for dist/index.js to be compiled...");
  while (!shuttingDown && !existsSync(daemonEntry)) {
    await delay(500);
  }
}

function wireProcessFailure(name, child) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const reason =
      code !== null
        ? `${name} exited with code ${code}`
        : `${name} exited with signal ${signal}`;
    console.error(reason);
    shutdown(code ?? 1);
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore shutdown errors
    }
  }

  setTimeout(() => process.exit(exitCode), 100);
}

async function main() {
  const tscWatch = startProcess(process.execPath, [tscBinPath, "-b", "-w"], {
    cwd: daemonDir,
  });
  wireProcessFailure("TypeScript watch", tscWatch);

  await waitForBuildOutput();
  if (shuttingDown) {
    return;
  }

  await stopExistingDaemon();
  console.log("Starting daemon with debounced file watch...");

  const DEBOUNCE_MS = 2000;
  let daemonChild = null;
  let restartTimer = null;
  let restarting = false;

  function spawnDaemon() {
    daemonChild = spawn(process.execPath, ["dist/index.js"], {
      cwd: daemonDir,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "development" },
    });
    children.add(daemonChild);
    daemonChild.on("exit", (code, signal) => {
      children.delete(daemonChild);
      daemonChild = null;
      if (shuttingDown || restarting) return;
      const reason = code !== null
        ? `Daemon exited with code ${code}`
        : `Daemon exited with signal ${signal}`;
      console.error(`${reason} — restarting in 2s...`);
      restarting = true;
      setTimeout(() => {
        restarting = false;
        if (!shuttingDown) spawnDaemon();
      }, 2000);
    });
  }

  function restartDaemon() {
    if (shuttingDown) return;
    restarting = true;
    if (daemonChild) {
      daemonChild.once("exit", () => {
        restarting = false;
        spawnDaemon();
      });
      daemonChild.kill("SIGTERM");
    } else {
      restarting = false;
      spawnDaemon();
    }
  }

  spawnDaemon();

  const distDir = path.join(daemonDir, "dist");
  let changedFiles = new Set();

  watch(distDir, { recursive: true }, (_eventType, filename) => {
    if (shuttingDown) return;
    if (!filename?.endsWith(".js")) return;
    changedFiles.add(filename);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      const files = [...changedFiles];
      changedFiles = new Set();
      console.log(
        `[watch] File change detected — restarting daemon... (${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")})`
      );
      restartDaemon();
    }, DEBOUNCE_MS);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main().catch((error) => {
  console.error("Failed to start daemon dev workflow:", error);
  shutdown(1);
});
