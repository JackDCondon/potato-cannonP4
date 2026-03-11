import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

function findExecutable(command: string): string[] {
  try {
    return execSync(command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
      .trim()
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve the absolute path to a named executable, cross-platform.
 *
 * Resolution order:
 *   Windows: `where` (prefers .exe), then common fallback paths
 *   Unix:    `which`, then ~/.local/bin, /usr/local/bin, /usr/bin
 *
 * Returns null if the executable cannot be found.
 */
export function resolveExecutable(name: string): string | null {
  if (process.platform === "win32") {
    // Try Windows 'where' first
    const results = findExecutable(`where ${name}`);

    // Prefer .exe if available (native/standalone installer)
    const exePath = results.find((p) => /\.exe$/i.test(p));
    if (exePath && existsSync(exePath)) return exePath;

    // .cmd or first result - note: .cmd files require shell:true in spawnSync
    const first = results[0];
    if (first && existsSync(first)) return first;

    // Common Windows fallback paths
    const appData = process.env.APPDATA;
    if (appData) {
      const cmdPath = path.join(appData, "npm", `${name}.cmd`);
      if (existsSync(cmdPath)) return cmdPath;
    }
    const p4ExePath = `C:\\Program Files\\Perforce\\${name}.exe`;
    if (existsSync(p4ExePath)) return p4ExePath;

    return null;
  }

  // Unix: try 'which' first
  const found = findExecutable(`which ${name}`)[0];
  if (found) return found;

  // Unix common fallback paths
  const home = process.env.HOME || "";
  const candidates = [
    path.join(home, ".local", "bin", name),
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Resolve the Node.js executable path.
 * Falls back to process.execPath if 'node' cannot be found on PATH.
 */
export function resolveNode(): string {
  return resolveExecutable("node") ?? process.execPath;
}

/**
 * Resolve the Claude CLI executable path, cross-platform.
 * On Windows, npm installs claude as a .cmd wrapper; we find the underlying
 * Node.js script and run it directly via node to avoid cmd.exe escaping issues.
 */
export function resolveClaude(nodeExecutable: string): {
  claudePath: string;
  claudePrependArgs: string[];
} {
  if (process.platform === "win32") {
    // Try Windows 'where' command to find claude on PATH
    const results = findExecutable("where claude");

    // Prefer .exe if available (native/standalone installer)
    const exePath = results.find((p) => /\.exe$/i.test(p));
    if (exePath && existsSync(exePath)) {
      return { claudePath: exePath, claudePrependArgs: [] };
    }

    // .cmd found (npm global install) - find the underlying JS entry point
    const cmdPath = results[0];
    if (cmdPath && existsSync(cmdPath)) {
      const npmBinDir = path.dirname(cmdPath);
      const jsPath = path.join(
        npmBinDir,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js"
      );
      if (existsSync(jsPath)) {
        return { claudePath: nodeExecutable, claudePrependArgs: [jsPath] };
      }
    }

    // Fallback: check APPDATA/npm (common npm global install location)
    const appData = process.env.APPDATA;
    if (appData) {
      const jsPath = path.join(
        appData,
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js"
      );
      if (existsSync(jsPath)) {
        return { claudePath: nodeExecutable, claudePrependArgs: [jsPath] };
      }
    }

    // Last resort - hope claude.exe is findable by the OS
    return { claudePath: "claude", claudePrependArgs: [] };
  }

  // Unix lookup
  const found = findExecutable("which claude")[0];
  if (found) {
    return { claudePath: found, claudePrependArgs: [] };
  }

  // Unix fallback
  const linuxFallback = path.join(
    process.env.HOME || "",
    ".local",
    "bin",
    "claude"
  );
  return {
    claudePath: existsSync(linuxFallback) ? linuxFallback : "claude",
    claudePrependArgs: [],
  };
}