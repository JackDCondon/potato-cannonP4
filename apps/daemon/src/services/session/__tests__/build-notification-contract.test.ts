import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "../../../../");

function loadTemplate(relativePath: string): string {
  const absolutePath = path.join(packageRoot, relativePath);
  return fs.readFileSync(absolutePath, "utf8");
}

describe("build notification template contract", () => {
  it("enforces builder start/finish milestone wording with task name", () => {
    const builderTemplate = loadTemplate("templates/workflows/product-development/agents/builder.md");

    assert.match(
      builderTemplate,
      /\[Builder Agent\]: I'm getting started on task: \{Task Name\}/,
      "builder template must emit task-name based start notification",
    );

    assert.match(
      builderTemplate,
      /\[Builder Agent\]: Finished coding \{Task Name\}/,
      "builder template must emit task-name based finish notification",
    );
  });

  it("enforces verify-spec start/finish milestone wording", () => {
    const specTemplate = loadTemplate("templates/workflows/product-development/agents/verify-spec.md");

    assert.match(
      specTemplate,
      /\[Verify Spec Agent\]: Starting spec review of \{Task Name\}/,
      "verify-spec template must emit start milestone notification",
    );

    assert.match(
      specTemplate,
      /\[Verify Spec Agent\]: Finished spec review of \{Task Name\} - PASS\|FAIL/,
      "verify-spec template must emit finish milestone notification with PASS|FAIL",
    );
  });

  it("enforces verify-quality start/finish milestone wording", () => {
    const qualityTemplate = loadTemplate("templates/workflows/product-development/agents/verify-quality.md");

    assert.match(
      qualityTemplate,
      /\[Code Review Agent\]: Starting code review of \{Task Name\}/,
      "verify-quality template must emit start milestone notification",
    );

    assert.match(
      qualityTemplate,
      /\[Code Review Agent\]: Finished code review of \{Task Name\} - Making #\{N\} suggestions/,
      "verify-quality template must emit finish milestone notification with suggestion count",
    );
  });
});
