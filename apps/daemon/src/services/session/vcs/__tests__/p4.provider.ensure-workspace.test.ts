import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

type SpawnCall = {
  command: string;
  args: string[];
  cwd?: string;
};

const spawnCalls: SpawnCall[] = [];
const behavior = {
  clientsStdout: "",
  createStatus: 0,
  syncStatus: 0,
};

await mock.module("child_process", {
  namedExports: {
    execSync: () => "",
    spawnSync: (command: string, args: string[], opts?: { cwd?: string }) => {
      spawnCalls.push({ command, args, cwd: opts?.cwd });

      if (args[0] === "clients" && args[1] === "-e") {
        return { status: 0, stdout: behavior.clientsStdout, stderr: "" };
      }
      if (args[0] === "client" && args[1] === "-i") {
        return {
          status: behavior.createStatus,
          stdout: "",
          stderr: behavior.createStatus === 0 ? "" : "create failed",
        };
      }
      if (args[0] === "-c" && args[2] === "sync") {
        return {
          status: behavior.syncStatus,
          stdout: "",
          stderr: behavior.syncStatus === 0 ? "" : "sync failed",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  },
});

await mock.module("fs/promises", {
  namedExports: {
    mkdir: async () => {},
    rm: async () => {},
  },
});

const { P4Provider } = await import("../p4.provider.js");

describe("P4Provider.ensureWorkspace", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    behavior.clientsStdout = "";
    behavior.createStatus = 0;
    behavior.syncStatus = 0;
  });

  it("syncs existing workspace before reuse", async () => {
    behavior.clientsStdout = "Client potato-demo-T-1 2026/03/12 root C:/ws";

    const provider = new P4Provider({
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "C:/workspaces",
      projectSlug: "demo",
    });

    await provider.ensureWorkspace("T-1");

    assert.ok(
      spawnCalls.some((call) => call.args[0] === "-c" && call.args[1] === "potato-demo-T-1" && call.args[2] === "sync"),
      "expected p4 sync for existing workspace",
    );
    assert.strictEqual(
      spawnCalls.some((call) => call.args[0] === "client" && call.args[1] === "-i"),
      false,
      "did not expect workspace recreation when workspace already exists",
    );
  });

  it("creates then syncs new workspace", async () => {
    const provider = new P4Provider({
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "C:/workspaces",
      projectSlug: "demo",
    });

    await provider.ensureWorkspace("T-2");

    assert.ok(
      spawnCalls.some((call) => call.args[0] === "client" && call.args[1] === "-i"),
      "expected p4 client creation for new workspace",
    );
    assert.ok(
      spawnCalls.some((call) => call.args[0] === "-c" && call.args[1] === "potato-demo-T-2" && call.args[2] === "sync"),
      "expected p4 sync after workspace creation",
    );
  });
});

