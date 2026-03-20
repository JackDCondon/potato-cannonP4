import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const pnpmDir = path.join(repoRoot, "node_modules", ".pnpm");

if (!fs.existsSync(pnpmDir)) {
  process.exit(0);
}

for (const entry of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("node-pty@")) {
    continue;
  }

  const helperPath = path.join(
    pnpmDir,
    entry.name,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper",
  );

  if (!fs.existsSync(helperPath)) {
    continue;
  }

  const currentMode = fs.statSync(helperPath).mode;
  const executableMode = currentMode | 0o111;
  if (executableMode !== currentMode) {
    fs.chmodSync(helperPath, executableMode);
  }
}
