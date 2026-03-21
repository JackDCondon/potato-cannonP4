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

test("get_project_overview tool schema has optional projectId", () => {
  const tool = ticketTools.find((t) => t.name === "get_project_overview");
  assert.ok(tool?.inputSchema.properties.projectId, "should have projectId property");
  assert.ok(!tool?.inputSchema.required.includes("projectId"), "projectId should be optional");
});

test("list_tickets tool schema has optional projectId", () => {
  const tool = ticketTools.find((t) => t.name === "list_tickets");
  assert.ok(tool?.inputSchema.properties.projectId, "should have projectId property");
});

test("create_ticket tool schema has optional projectId", () => {
  const tool = ticketTools.find((t) => t.name === "create_ticket");
  assert.ok(tool?.inputSchema.properties.projectId, "should have projectId property");
});
