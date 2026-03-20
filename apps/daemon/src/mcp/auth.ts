import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type AuthOptions = {
  env?: NodeJS.ProcessEnv;
  tokenFilePath?: string;
};

export function getDefaultMcpAuthTokenPath(): string {
  return path.join(os.homedir(), ".potato-cannon", "mcp-auth-token");
}

export function getMcpAuthToken(options: AuthOptions = {}): string | null {
  const env = options.env ?? process.env;
  const envToken = env.POTATO_MCP_AUTH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const tokenFilePath =
    options.tokenFilePath ??
    env.POTATO_MCP_AUTH_TOKEN_FILE?.trim() ??
    getDefaultMcpAuthTokenPath();
  try {
    const fileToken = fs.readFileSync(tokenFilePath, "utf8").trim();
    return fileToken || null;
  } catch {
    return null;
  }
}

export function buildMcpAuthHeaders(options: AuthOptions = {}): Record<string, string> {
  const token = getMcpAuthToken(options);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function isValidMcpAuthHeader(
  authHeader: string | string[] | undefined,
  expectedToken: string | null,
): boolean {
  if (!expectedToken) {
    return true;
  }

  const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  return headerValue === `Bearer ${expectedToken}`;
}
