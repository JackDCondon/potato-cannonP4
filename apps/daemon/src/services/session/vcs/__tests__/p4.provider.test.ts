import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import path from "path";

import { createVCSProvider } from "../factory.js";
import { P4Provider, normalizeP4Stream } from "../p4.provider.js";

const ORIGINAL_P4_MCP = process.env.POTATO_P4_MCP_SERVER_PATH;

afterEach(() => {
  if (ORIGINAL_P4_MCP === undefined) {
    delete process.env.POTATO_P4_MCP_SERVER_PATH;
  } else {
    process.env.POTATO_P4_MCP_SERVER_PATH = ORIGINAL_P4_MCP;
  }
});

describe("P4Provider.getMcpServers", () => {
  it("uses POTATO_P4_MCP_SERVER_PATH when configured and file exists", () => {
    process.env.POTATO_P4_MCP_SERVER_PATH = path.resolve(
      "src/services/session/vcs/p4.provider.ts",
    );

    const provider = new P4Provider({
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "/tmp/p4-workspaces",
      projectSlug: "demo-project",
    });

    const servers = provider.getMcpServers("node", "proj-1", "POT-123");
    assert.ok(servers["perforce-p4"], "expected perforce-p4 MCP server to be configured");
    assert.strictEqual(
      servers["perforce-p4"].args[0],
      process.env.POTATO_P4_MCP_SERVER_PATH,
      "expected configured global path to be used",
    );
    assert.strictEqual(
      servers["perforce-p4"].env?.P4CLIENT,
      "potato-demo-project-POT-123",
      "expected workspace-scoped P4CLIENT",
    );
  });

  it("injects P4PORT and P4USER into MCP env when configured", () => {
    process.env.POTATO_P4_MCP_SERVER_PATH = path.resolve(
      "src/services/session/vcs/p4.provider.ts",
    );

    const provider = new P4Provider({
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "/tmp/p4-workspaces",
      projectSlug: "demo-project",
      p4Port: "ssl:p4.example.com:1666",
      p4User: "alice",
    });

    const servers = provider.getMcpServers("node", "proj-1", "POT-123");
    assert.strictEqual(servers["perforce-p4"].env?.P4PORT, "ssl:p4.example.com:1666");
    assert.strictEqual(servers["perforce-p4"].env?.P4USER, "alice");
  });
});

describe("P4Provider p4Args helper", () => {
  it("returns cmd unchanged when p4Port and p4User are absent", () => {
    const provider = new (P4Provider as any)({
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "/tmp",
      projectSlug: "test",
    });

    assert.deepStrictEqual(provider.p4Args(["clients", "-e", "ws"]), ["clients", "-e", "ws"]);
  });

  it("prepends -p and -u flags when both are set", () => {
    const provider = new (P4Provider as any)({
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "/tmp",
      projectSlug: "test",
      p4Port: "ssl:p4.example.com:1666",
      p4User: "alice",
    });

    assert.deepStrictEqual(provider.p4Args(["clients", "-e", "ws"]), [
      "-p",
      "ssl:p4.example.com:1666",
      "-u",
      "alice",
      "clients",
      "-e",
      "ws",
    ]);
  });

  it("prepends only -p when only p4Port is set", () => {
    const provider = new (P4Provider as any)({
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "/tmp",
      projectSlug: "test",
      p4Port: "ssl:p4.example.com:1666",
    });

    assert.deepStrictEqual(provider.p4Args(["sync"]), ["-p", "ssl:p4.example.com:1666", "sync"]);
  });
});

describe("createVCSProvider with p4 overrides", () => {
  it("passes p4Port and p4User when p4UseEnvVars is false", () => {
    const provider = createVCSProvider({
      id: "proj1",
      slug: "proj1",
      displayName: "Proj",
      path: "/repo",
      registeredAt: "",
      vcsType: "perforce",
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "/workspaces",
      p4UseEnvVars: false,
      p4Port: "ssl:p4.example.com:1666",
      p4User: "alice",
    }) as any;

    assert.strictEqual(provider.config.p4Port, "ssl:p4.example.com:1666");
    assert.strictEqual(provider.config.p4User, "alice");
  });

  it("does not pass p4Port or p4User when p4UseEnvVars is true", () => {
    const provider = createVCSProvider({
      id: "proj1",
      slug: "proj1",
      displayName: "Proj",
      path: "/repo",
      registeredAt: "",
      vcsType: "perforce",
      p4Stream: "//depot/main",
      agentWorkspaceRoot: "/workspaces",
      p4UseEnvVars: true,
      p4Port: "ssl:p4.example.com:1666",
      p4User: "alice",
    }) as any;

    assert.strictEqual(provider.config.p4Port, undefined);
    assert.strictEqual(provider.config.p4User, undefined);
  });
});

describe("normalizeP4Stream", () => {
  it("removes trailing slash from stream path", () => {
    assert.strictEqual(normalizeP4Stream("//streams/JcInventory/"), "//streams/JcInventory");
  });

  it("removes multiple trailing slashes but preserves leading depot prefix", () => {
    assert.strictEqual(normalizeP4Stream("//streams/JcInventory///"), "//streams/JcInventory");
  });
});
