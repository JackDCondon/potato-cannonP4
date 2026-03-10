import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  console.log("Starting daemon with file watch...");

  const daemonWatch = startProcess(process.execPath, ["--watch", "dist/index.js"], {
    cwd: daemonDir,
    env: { ...process.env, NODE_ENV: "development" },
  });
  wireProcessFailure("Daemon watch", daemonWatch);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main().catch((error) => {
  console.error("Failed to start daemon dev workflow:", error);
  shutdown(1);
});
