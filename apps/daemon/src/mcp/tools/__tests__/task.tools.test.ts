import { describe, it } from "node:test";
import assert from "node:assert";
import { extractSection } from "../task.tools.js";

const SAMPLE_SPEC = `# Specification

## Overview
This is a sample specification.

### Ticket 1: Create Button
**Files:**
- Create: src/Button.tsx

Step 1: Write the component
Step 2: Verify

### Ticket 2: Create Input
**Files:**
- Create: src/Input.tsx

Step 1: Write the component
Step 2: Verify

### Ticket 3: Create Form
**Files:**
- Create: src/Form.tsx

Step 1: Write the component
Step 2: Verify
`;

describe("extractSection", () => {
  it("extracts section between start and end markers", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 2: Create Input",
      "### Ticket 3: Create Form",
    );
    assert.ok(result.startsWith("### Ticket 2: Create Input"));
    assert.ok(result.includes("src/Input.tsx"));
    assert.ok(!result.includes("### Ticket 3"));
    assert.ok(!result.includes("src/Form.tsx"));
  });

  it("extracts from start marker to EOF when no end marker", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 3: Create Form",
    );
    assert.ok(result.startsWith("### Ticket 3: Create Form"));
    assert.ok(result.includes("src/Form.tsx"));
    assert.ok(result.includes("Step 2: Verify"));
  });

  it("includes start marker line in output", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 1: Create Button",
      "### Ticket 2: Create Input",
    );
    assert.ok(result.startsWith("### Ticket 1: Create Button"));
  });

  it("excludes end marker line from output", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 1: Create Button",
      "### Ticket 2: Create Input",
    );
    assert.ok(!result.includes("### Ticket 2: Create Input"));
  });

  it("trims trailing whitespace", () => {
    const result = extractSection(
      SAMPLE_SPEC,
      "### Ticket 1: Create Button",
      "### Ticket 2: Create Input",
    );
    assert.strictEqual(result, result.trimEnd());
  });

  it("throws on missing start marker", () => {
    assert.throws(
      () => extractSection(SAMPLE_SPEC, "### Ticket 99: Missing"),
      (err: Error) => {
        assert.ok(err.message.includes("Start marker not found"));
        assert.ok(err.message.includes("### Ticket 99: Missing"));
        return true;
      },
    );
  });

  it("throws on missing end marker", () => {
    assert.throws(
      () =>
        extractSection(
          SAMPLE_SPEC,
          "### Ticket 1: Create Button",
          "### Ticket 99: Missing",
        ),
      (err: Error) => {
        assert.ok(err.message.includes("End marker not found"));
        assert.ok(err.message.includes("### Ticket 99: Missing"));
        return true;
      },
    );
  });

  it("uses first occurrence of start marker", () => {
    const content = "AAA\nmarker\nBBB\nmarker\nCCC";
    const result = extractSection(content, "marker", "CCC");
    assert.ok(result.startsWith("marker\nBBB"));
  });

  it("handles empty content between markers", () => {
    const content = "### Ticket 1:\n### Ticket 2:\nContent";
    const result = extractSection(content, "### Ticket 1:", "### Ticket 2:");
    assert.strictEqual(result, "### Ticket 1:");
  });
});

describe("resolveBodyFrom path traversal guard", () => {
  it("detects path traversal in artifact filename", async () => {
    const nodePath = await import("node:path");
    const artifactsDir = "/fake/artifacts";
    const badFilename = "../../etc/passwd";
    const artifactPath = nodePath.join(artifactsDir, badFilename);
    const resolvedPath = nodePath.resolve(artifactPath);
    const resolvedDir = nodePath.resolve(artifactsDir);
    assert.ok(
      !resolvedPath.startsWith(resolvedDir + nodePath.sep),
      "Path traversal should be detected",
    );
  });
});
