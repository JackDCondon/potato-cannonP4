import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  filterToolsByDisallowList,
  AGENT_SOURCE_PATTERN,
} from "../mcp-tools-filter.js";

describe("filterToolsByDisallowList", () => {
  test("removes tools matching disallowTools list", () => {
    const tools = [
      { name: "create_task" },
      { name: "ralph_loop_dock" },
      { name: "chat_notify" },
      { name: "attach_artifact" },
    ];
    const disallowList = ["create_task", "attach_artifact"];
    const result = filterToolsByDisallowList(tools, disallowList);
    assert.deepEqual(
      result.map((t) => t.name),
      ["ralph_loop_dock", "chat_notify"],
    );
  });

  test("returns all tools when disallowList is empty", () => {
    const tools = [{ name: "create_task" }, { name: "ralph_loop_dock" }];
    const result = filterToolsByDisallowList(tools, []);
    assert.equal(result.length, 2);
  });

  test("returns empty array when all tools are disallowed", () => {
    const tools = [{ name: "create_task" }, { name: "ralph_loop_dock" }];
    const result = filterToolsByDisallowList(tools, ["create_task", "ralph_loop_dock"]);
    assert.equal(result.length, 0);
  });

  test("handles tools not in disallowList", () => {
    const tools = [{ name: "chat_ask" }, { name: "get_ticket" }];
    const result = filterToolsByDisallowList(tools, ["ralph_loop_dock"]);
    assert.equal(result.length, 2);
  });

  test("is case-sensitive when matching tool names", () => {
    const tools = [{ name: "create_task" }];
    // Disallow list uses different case - should NOT match
    const result = filterToolsByDisallowList(tools, ["Create_Task"]);
    assert.equal(result.length, 1);
  });
});

describe("AGENT_SOURCE_PATTERN", () => {
  test("accepts valid agent paths", () => {
    assert.ok(AGENT_SOURCE_PATTERN.test("agents/builder.md"));
    assert.ok(AGENT_SOURCE_PATTERN.test("agents/refinement.md"));
    assert.ok(AGENT_SOURCE_PATTERN.test("agents/verify-spec-agent.md"));
    assert.ok(AGENT_SOURCE_PATTERN.test("agents/my-agent_v2.md"));
  });

  test("rejects paths with directory traversal", () => {
    assert.ok(!AGENT_SOURCE_PATTERN.test("agents/../secrets.md"));
    assert.ok(!AGENT_SOURCE_PATTERN.test("../agents/builder.md"));
    assert.ok(!AGENT_SOURCE_PATTERN.test("agents/../../etc/passwd"));
  });

  test("rejects paths without agents/ prefix", () => {
    assert.ok(!AGENT_SOURCE_PATTERN.test("builder.md"));
    assert.ok(!AGENT_SOURCE_PATTERN.test("other/builder.md"));
  });

  test("rejects paths with special characters", () => {
    assert.ok(!AGENT_SOURCE_PATTERN.test("agents/builder$.md"));
    assert.ok(!AGENT_SOURCE_PATTERN.test("agents/build er.md"));
  });
});
