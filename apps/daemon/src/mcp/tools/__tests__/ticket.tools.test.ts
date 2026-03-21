import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketTools } from "../ticket.tools.js";

test("list_projects tool definition has scope=external", () => {
  const tool = ticketTools.find((t) => t.name === "list_projects");
  assert.ok(tool, "list_projects tool should exist");
  assert.equal(tool?.scope, "external");
});

test("list_projects tool has no required fields", () => {
  const tool = ticketTools.find((t) => t.name === "list_projects");
  assert.deepEqual(tool?.inputSchema.required, []);
});
