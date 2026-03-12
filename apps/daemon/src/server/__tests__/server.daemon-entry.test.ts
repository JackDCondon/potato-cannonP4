import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDaemonEntryPath } from "../server.js";

describe("resolveDaemonEntryPath", () => {
  it("returns the dist index entrypoint from server module url", () => {
    const serverModuleUrl = new URL("../server.js", import.meta.url).href;
    const expected = path.join(
      path.dirname(fileURLToPath(serverModuleUrl)),
      "..",
      "index.js",
    );

    const resolved = resolveDaemonEntryPath(serverModuleUrl);

    assert.strictEqual(path.normalize(resolved), path.normalize(expected));
  });
});
