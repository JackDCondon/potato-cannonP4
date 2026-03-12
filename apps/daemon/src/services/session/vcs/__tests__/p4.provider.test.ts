import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import path from "path";

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
});

describe("normalizeP4Stream", () => {
  it("removes trailing slash from stream path", () => {
    assert.strictEqual(normalizeP4Stream("//streams/JcInventory/"), "//streams/JcInventory");
  });

  it("removes multiple trailing slashes but preserves leading depot prefix", () => {
    assert.strictEqual(normalizeP4Stream("//streams/JcInventory///"), "//streams/JcInventory");
  });
});
