import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildMcpAuthHeaders,
  getMcpAuthToken,
  isValidMcpAuthHeader,
} from "../auth.js";

test("getMcpAuthToken prefers env token over file token", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "potato-mcp-auth-"));
  const tokenFilePath = path.join(tempDir, "token.txt");
  fs.writeFileSync(tokenFilePath, "file-secret\n", "utf8");

  const token = getMcpAuthToken({
    env: { POTATO_MCP_AUTH_TOKEN: "env-secret" },
    tokenFilePath,
  });

  assert.equal(token, "env-secret");
});

test("getMcpAuthToken reads token from file when env token is absent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "potato-mcp-auth-"));
  const tokenFilePath = path.join(tempDir, "token.txt");
  fs.writeFileSync(tokenFilePath, "file-secret\n", "utf8");

  const token = getMcpAuthToken({
    env: {},
    tokenFilePath,
  });

  assert.equal(token, "file-secret");
});

test("buildMcpAuthHeaders returns bearer header when token is configured", () => {
  const headers = buildMcpAuthHeaders({
    env: { POTATO_MCP_AUTH_TOKEN: "env-secret" },
  });

  assert.deepEqual(headers, { Authorization: "Bearer env-secret" });
});

test("isValidMcpAuthHeader accepts exact bearer token matches only", () => {
  assert.equal(isValidMcpAuthHeader("Bearer secret-token", "secret-token"), true);
  assert.equal(isValidMcpAuthHeader("Bearer wrong-token", "secret-token"), false);
  assert.equal(isValidMcpAuthHeader(undefined, "secret-token"), false);
  assert.equal(isValidMcpAuthHeader("secret-token", "secret-token"), false);
  assert.equal(isValidMcpAuthHeader(undefined, null), true);
});
