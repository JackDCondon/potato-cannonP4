import { describe, it } from "node:test";
import assert from "node:assert";
import { formatScopeContext } from "../prompts.js";
import type { ScopeContextDeps } from "../prompts.js";

const PLAN_SUMMARY = "Build auth system";

function makeDeps(
  overrides: Partial<ScopeContextDeps> = {},
): ScopeContextDeps {
  return {
    getBrainstorm: () => ({ planSummary: PLAN_SUMMARY }),
    getSiblingTickets: () => [
      { id: "AUTH-2", title: "Auth UI", phase: "Build", complexity: "standard" },
      { id: "AUTH-3", title: "Auth Tests", phase: "Refinement", complexity: "simple" },
    ],
    ...overrides,
  };
}

describe("formatScopeContext output", () => {
  it("returns empty string when ticket has no brainstormId", () => {
    const result = formatScopeContext(
      { id: "AUTH-1" },
      makeDeps(),
    );
    assert.strictEqual(result, "");
  });

  it("returns empty string when brainstorm has no planSummary", () => {
    const deps = makeDeps({
      getBrainstorm: () => ({ planSummary: null }),
    });
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      deps,
    );
    assert.strictEqual(result, "");
  });

  it("returns empty string when brainstorm is not found", () => {
    const deps = makeDeps({
      getBrainstorm: () => null,
    });
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      deps,
    );
    assert.strictEqual(result, "");
  });

  it("returns empty string when no siblings exist after filtering self", () => {
    const deps = makeDeps({
      // Only returns the current ticket — after filter(t => t.id !== ticket.id) nothing remains
      getSiblingTickets: () => [
        { id: "AUTH-1", title: "Lonely ticket", phase: "Build", complexity: "standard" },
      ],
    });
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      deps,
    );
    assert.strictEqual(result, "");
  });

  it("contains ## Scope Context header", () => {
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      makeDeps(),
    );
    assert.ok(result.includes("## Scope Context"), "should contain ## Scope Context header");
  });

  it("contains epic goal from planSummary", () => {
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      makeDeps(),
    );
    assert.ok(
      result.includes(`**Epic goal:** ${PLAN_SUMMARY}`),
      "should include epic goal from planSummary",
    );
  });

  it("contains sibling ticket info in markdown table rows", () => {
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      makeDeps(),
    );
    assert.ok(result.includes("AUTH-2"), "should include sibling ticket AUTH-2");
    assert.ok(result.includes("Auth UI"), "should include sibling title Auth UI");
    assert.ok(result.includes("AUTH-3"), "should include sibling ticket AUTH-3");
    assert.ok(result.includes("Auth Tests"), "should include sibling title Auth Tests");
  });

  it("excludes the current ticket from sibling table", () => {
    const deps = makeDeps({
      getSiblingTickets: () => [
        { id: "AUTH-1", title: "Current ticket", phase: "Build", complexity: "standard" },
        { id: "AUTH-2", title: "Auth UI", phase: "Build", complexity: "standard" },
      ],
    });
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      deps,
    );
    // AUTH-1 is the current ticket — it should not appear in the table
    // AUTH-2 should appear
    assert.ok(result.includes("AUTH-2"), "sibling AUTH-2 should be included");
    // Current ticket row: the title "Current ticket" should not appear (it was filtered)
    assert.ok(
      !result.includes("Current ticket"),
      "current ticket should be excluded from sibling table",
    );
  });

  it("escapes pipe characters in title to prevent table corruption", () => {
    const deps = makeDeps({
      getSiblingTickets: () => [
        {
          id: "AUTH-2",
          title: "Auth | Login | Logout",
          phase: "Build",
          complexity: "standard",
        },
      ],
    });
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      deps,
    );
    assert.ok(
      result.includes("Auth \\| Login \\| Logout"),
      "pipe characters in title should be escaped as \\|",
    );
  });

  it("escapes pipe characters in complexity to prevent table corruption", () => {
    const deps = makeDeps({
      getSiblingTickets: () => [
        {
          id: "AUTH-2",
          title: "Auth UI",
          phase: "Build",
          complexity: "complex|high",
        },
      ],
    });
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      deps,
    );
    assert.ok(
      result.includes("complex\\|high"),
      "pipe characters in complexity should be escaped as \\|",
    );
  });

  it("includes markdown table header row", () => {
    const result = formatScopeContext(
      { id: "AUTH-1", brainstormId: "bs-1" },
      makeDeps(),
    );
    assert.ok(
      result.includes("| ID | Title | Phase | Complexity |"),
      "should contain markdown table header",
    );
  });
});
