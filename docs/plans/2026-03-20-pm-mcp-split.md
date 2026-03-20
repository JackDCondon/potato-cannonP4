# PM MCP Split Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

## Goal

Split the single `potato-cannon` MCP server into `potato-ticket` (ticket agents) and `potato-pm` (PM additions), and add `move_ticket`, `update_ticket`, and `set_ticket_complexity` tools so the PM agent can manage epic state directly.

## Architecture

Each Claude session gets one or two proxy processes. Ticket agent sessions get one (`potato-ticket`). PM sessions get both (`potato-ticket` + `potato-pm`), so the PM has the full ticket toolset plus its own management layer. A new `POTATO_MCP_SCOPE` env var tells each proxy instance which server name to advertise and which tool subset to fetch from the daemon.

## Tech Stack

TypeScript, Node.js, MCP SDK, Express, better-sqlite3, node-pty, Claude Code CLI

## Key Decisions
- **Additive PM server (not replacement):** PM gets `potato-ticket` + `potato-pm` instead of one combined server — keeps tool lists short for ticket agents, avoids context bloat, and prevents ticket agents from ever seeing `move_ticket`.
- **`mcpServer` tag on ToolDefinition (not file split):** Add `mcpServer?: "pm"` to the type and tag PM-only tools in-place rather than splitting/renaming files — minimal diff, easy to audit which tools are PM-only.
- **`move_ticket` via internal HTTP call:** Calls `PUT /api/tickets/:project/:id` on the daemon using `ctx.daemonUrl` — reuses identical lifecycle/session-invalidation logic as the UI, no divergent code paths.
- **`update_ticket` and `set_ticket_complexity` via store:** These are simple metadata updates with no lifecycle effects, so they call `updateTicket()` directly like all other tool handlers.
- **Server rename `potato-cannon` → `potato-ticket`:** All existing sessions and disallowed-tool references using the old name will need updating — handled in Task 6 (session.service.ts).

---

## Task 1: Add `mcpServer` field to ToolDefinition + update mcp.routes.ts filtering

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/types/mcp.types.ts`
- Modify: `apps/daemon/src/server/routes/mcp.routes.ts`

**Purpose:** Establishes the filter mechanism all subsequent tasks rely on. Tools tagged `mcpServer: "pm"` will only appear in PM server responses.

**Not In Scope:** Tagging any tools yet — just the infrastructure.

**Step 1: Write the failing test**

Create `apps/daemon/src/server/routes/__tests__/mcp-server-filter.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";

// Simulate the filtering logic that mcp.routes.ts will use
function filterByMcpServer(tools: { name: string; mcpServer?: "pm" }[], server: "ticket" | "pm" | undefined) {
  if (server === "ticket") return tools.filter((t) => t.mcpServer !== "pm");
  if (server === "pm") return tools.filter((t) => t.mcpServer === "pm");
  return tools; // no filter = all (backward compat)
}

describe("mcpServer filter", () => {
  const tools = [
    { name: "get_ticket" },
    { name: "get_epic_status", mcpServer: "pm" as const },
    { name: "move_ticket", mcpServer: "pm" as const },
  ];

  it("ticket server excludes pm tools", () => {
    const result = filterByMcpServer(tools, "ticket");
    assert.deepStrictEqual(result.map((t) => t.name), ["get_ticket"]);
  });

  it("pm server returns only pm tools", () => {
    const result = filterByMcpServer(tools, "pm");
    assert.deepStrictEqual(result.map((t) => t.name), ["get_epic_status", "move_ticket"]);
  });

  it("no server returns all tools", () => {
    const result = filterByMcpServer(tools, undefined);
    assert.strictEqual(result.length, 3);
  });
});
```

**Step 2: Run test to verify failure**

```bash
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/server/routes/__tests__/mcp-server-filter.test.js
```
Expected: FAIL (filterByMcpServer not implemented yet)

**Step 3: Update mcp.types.ts**

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** Scope tag for filtering. 'session' = session-proxy only. Default (undefined) = both. */
  scope?: 'session' | 'external' | 'both';
  /** MCP server tag. 'pm' = potato-pm server only. Default (undefined) = potato-ticket server. */
  mcpServer?: 'pm';
}
```

**Step 4: Update mcp.routes.ts** — extend the `?scope=` handling to also handle `?mcpServer=`:

```typescript
// In registerMcpRoutes, replace the tools filtering section:
const scope = req.query.scope as string | undefined;
const mcpServer = req.query.mcpServer as "ticket" | "pm" | undefined;
const { agentSource, projectId } = req.query as {
  agentSource?: string;
  projectId?: string;
};

let tools = scope === "external"
  ? allTools.filter((t) => t.scope !== "session")
  : [...allTools];

// Apply mcpServer filtering
if (mcpServer === "ticket") {
  tools = tools.filter((t) => t.mcpServer !== "pm");
} else if (mcpServer === "pm") {
  tools = tools.filter((t) => t.mcpServer === "pm");
}
// (no mcpServer = all tools, backward compat)
```

**Step 5: Run test to verify pass**

```bash
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/server/routes/__tests__/mcp-server-filter.test.js
```
Expected: PASS

**Step 6: TypeScript check**

```bash
cd apps/daemon && pnpm typecheck
```
Expected: no errors

**Step 7: Commit**

```
git add apps/daemon/src/types/mcp.types.ts apps/daemon/src/server/routes/mcp.routes.ts apps/daemon/src/server/routes/__tests__/mcp-server-filter.test.ts
git commit -m "feat: add mcpServer field to ToolDefinition + mcpServer filtering in GET /mcp/tools"
```

---

## Task 2: Tag PM-only tools with `mcpServer: "pm"`

**Depends on:** Task 1
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/mcp/tools/ticket.tools.ts` (3 tools)
- Modify: `apps/daemon/src/mcp/tools/dependency.tools.ts` (3 tools)
- Modify: `apps/daemon/src/mcp/tools/scope.tools.ts` (1 tool)
- Modify: `apps/daemon/src/mcp/tools/epic.tools.ts` (2 tools)

**Purpose:** Makes PM-only tools invisible to ticket agents. No logic changes — metadata only.

**Not In Scope:** Moving tools between files, changing handler logic.

**Gotchas:** `set_plan_summary` in scope.tools.ts stays in ticket server (architects use it). Only `get_dependents` gets the PM tag.

**Step 1: Tag tools — ticket.tools.ts**

Add `mcpServer: "pm" as const` to `list_tickets`, `create_ticket`, `add_ticket_comment`:

```typescript
// list_tickets definition:
{
  name: "list_tickets",
  mcpServer: "pm" as const,
  description: "List tickets for the current project...",
  // ...
},

// create_ticket definition:
{
  name: "create_ticket",
  mcpServer: "pm" as const,
  description: "Create a new ticket...",
  // ...
},

// add_ticket_comment definition:
{
  name: "add_ticket_comment",
  mcpServer: "pm" as const,
  description: "Add a comment/note to the ticket...",
  // ...
},
```

**Step 2: Tag tools — dependency.tools.ts**

Add `mcpServer: "pm" as const` to `get_dependencies`, `add_dependency`, `delete_dependency`.

**Step 3: Tag tools — scope.tools.ts**

Add `mcpServer: "pm" as const` to `get_dependents` only. Leave `set_plan_summary` untagged.

**Step 4: Tag tools — epic.tools.ts**

Add `mcpServer: "pm" as const` to `get_epic_status` and `set_epic_pm_mode`.

**Step 5: Verify TypeScript**

```bash
cd apps/daemon && pnpm typecheck
```
Expected: no errors (mcpServer field is optional, `as const` ensures literal type)

**Step 6: Verify tag counts**

```bash
grep -r "mcpServer.*pm" apps/daemon/src/mcp/tools/
```
Expected: 9 matches across 4 files

**Step 7: Commit**

```
git add apps/daemon/src/mcp/tools/ticket.tools.ts apps/daemon/src/mcp/tools/dependency.tools.ts apps/daemon/src/mcp/tools/scope.tools.ts apps/daemon/src/mcp/tools/epic.tools.ts
git commit -m "feat: tag PM-only tools with mcpServer: pm"
```

---

## Task 3: Create pm.tools.ts with move_ticket, update_ticket, set_ticket_complexity

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/daemon/src/mcp/tools/pm.tools.ts`
- Create: `apps/daemon/src/mcp/tools/__tests__/pm.tools.test.ts`

**Purpose:** Gives the PM agent the ability to move tickets through workflow phases (lifecycle-safe), update metadata, and set complexity — all actions a PM needs that ticket agents don't.

**Not In Scope:** Moving existing tools here; those are tagged in Task 2.

**Gotchas:** `move_ticket` must call the HTTP route (not the store directly) so `invalidateTicketLifecycle` runs and sessions are stopped/started correctly. The handler uses `ctx.daemonUrl` which is always set by `mcp.routes.ts`.

**Step 1: Write tests**

Create `apps/daemon/src/mcp/tools/__tests__/pm.tools.test.ts`:

```typescript
import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";

const mockFetch = mock.fn(async (_url: string, _opts?: RequestInit) => ({
  ok: true,
  json: async () => ({ id: "GAM-7", phase: "Build" }),
} as Response));

const mockUpdateTicket = mock.fn(async () => ({
  id: "GAM-7",
  title: "New Title",
  complexity: "complex",
}));

// @ts-expect-error global fetch mock
global.fetch = mockFetch;

mock.module("../../stores/ticket.store.js", {
  namedExports: { updateTicket: mockUpdateTicket },
});

const { pmHandlers } = await import("../pm.tools.js");

const ctx = {
  projectId: "my-project",
  brainstormId: "brain_1",
  daemonUrl: "http://localhost:8443",
};

describe("move_ticket", () => {
  beforeEach(() => mockFetch.mock.resetCalls());

  it("calls PUT /api/tickets/:project/:id with phase", async () => {
    const result = await pmHandlers.move_ticket(ctx, {
      ticketId: "GAM-7",
      targetPhase: "Build",
    });
    assert.ok(result.content[0].text.includes("Build"));
    assert.ok(mockFetch.mock.calls[0].arguments[0].includes("/api/tickets/my-project/GAM-7"));
    const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body as string);
    assert.strictEqual(body.phase, "Build");
  });

  it("returns error when fetch fails", async () => {
    mockFetch.mock.mockImplementationOnce(async () => ({
      ok: false,
      statusText: "Bad Request",
      json: async () => ({ error: "dependency not satisfied" }),
    } as Response));

    const result = await pmHandlers.move_ticket(ctx, {
      ticketId: "GAM-7",
      targetPhase: "Build",
    });
    assert.ok(result.content[0].text.includes("Error"));
  });

  it("requires ticketId and targetPhase", async () => {
    const result = await pmHandlers.move_ticket(ctx, {});
    assert.ok(result.content[0].text.includes("Error"));
  });
});

describe("update_ticket", () => {
  beforeEach(() => mockUpdateTicket.mock.resetCalls());

  it("calls updateTicket with title", async () => {
    const result = await pmHandlers.update_ticket(ctx, {
      ticketId: "GAM-7",
      title: "New Title",
    });
    assert.ok(result.content[0].text.includes("updated"));
    assert.deepStrictEqual(mockUpdateTicket.mock.calls[0].arguments[2], { title: "New Title" });
  });

  it("rejects if no fields provided", async () => {
    const result = await pmHandlers.update_ticket(ctx, { ticketId: "GAM-7" });
    assert.ok(result.content[0].text.includes("Error"));
    assert.strictEqual(mockUpdateTicket.mock.callCount(), 0);
  });
});

describe("set_ticket_complexity", () => {
  beforeEach(() => mockUpdateTicket.mock.resetCalls());

  it("calls updateTicket with complexity", async () => {
    const result = await pmHandlers.set_ticket_complexity(ctx, {
      ticketId: "GAM-7",
      complexity: "complex",
    });
    assert.ok(result.content[0].text.includes("complex"));
    assert.deepStrictEqual(mockUpdateTicket.mock.calls[0].arguments[2], { complexity: "complex" });
  });

  it("rejects invalid complexity values", async () => {
    const result = await pmHandlers.set_ticket_complexity(ctx, {
      ticketId: "GAM-7",
      complexity: "super-hard",
    });
    assert.ok(result.content[0].text.includes("Error"));
    assert.strictEqual(mockUpdateTicket.mock.callCount(), 0);
  });
});
```

**Step 2: Run tests to verify failure**

```bash
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/mcp/tools/__tests__/pm.tools.test.js
```
Expected: FAIL (module doesn't exist yet)

**Step 3: Implement pm.tools.ts**

```typescript
import { updateTicket } from "../../stores/ticket.store.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";
import type { Complexity } from "@potato-cannon/shared";

// =============================================================================
// Tool Definitions
// =============================================================================

export const pmTools: ToolDefinition[] = [
  {
    name: "move_ticket",
    mcpServer: "pm" as const,
    description:
      "Move a ticket to a different workflow phase. Triggers the same lifecycle logic as advancing via the UI: stops any running session, updates phase history, and starts the next session automatically when the phase has automated workers.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "The ticket ID to move (e.g. 'GAM-7').",
        },
        targetPhase: {
          type: "string",
          description: "The phase to move the ticket to (e.g. 'Build', 'Review', 'Done').",
        },
        overrideDependencies: {
          type: "boolean",
          description: "If true, move the ticket even if dependencies are unsatisfied. Default: false.",
        },
      },
      required: ["ticketId", "targetPhase"],
    },
  },
  {
    name: "update_ticket",
    mcpServer: "pm" as const,
    description:
      "Update a ticket's title or description. Use this to refine ticket scope as the epic evolves.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "The ticket ID to update.",
        },
        title: {
          type: "string",
          description: "New title for the ticket.",
        },
        description: {
          type: "string",
          description: "New description for the ticket.",
        },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "set_ticket_complexity",
    mcpServer: "pm" as const,
    description:
      "Set the complexity of a ticket. Complexity influences model tier selection for build agents.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: {
          type: "string",
          description: "The ticket ID to update.",
        },
        complexity: {
          type: "string",
          enum: ["simple", "standard", "complex"],
          description: "The complexity level.",
        },
      },
      required: ["ticketId", "complexity"],
    },
  },
];

// =============================================================================
// Handlers
// =============================================================================

export const pmHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  move_ticket: async (ctx, args) => {
    const ticketId = args.ticketId as string | undefined;
    const targetPhase = args.targetPhase as string | undefined;
    const overrideDependencies = (args.overrideDependencies as boolean | undefined) ?? false;

    if (!ticketId || !targetPhase) {
      return {
        content: [{ type: "text", text: "Error: ticketId and targetPhase are required" }],
      };
    }

    const response = await fetch(
      `${ctx.daemonUrl}/api/tickets/${encodeURIComponent(ctx.projectId)}/${ticketId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: targetPhase, overrideDependencies }),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      return {
        content: [
          {
            type: "text",
            text: `Error moving ticket ${ticketId} to '${targetPhase}': ${(error as { error?: string }).error || response.statusText}`,
          },
        ],
      };
    }

    const ticket = await response.json();
    return {
      content: [
        {
          type: "text",
          text: `Ticket ${ticketId} moved to phase '${(ticket as { phase: string }).phase}'`,
        },
      ],
    };
  },

  update_ticket: async (ctx, args) => {
    const ticketId = args.ticketId as string | undefined;
    const title = args.title as string | undefined;
    const description = args.description as string | undefined;

    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required" }] };
    }
    if (!title && !description) {
      return {
        content: [{ type: "text", text: "Error: at least one of title or description is required" }],
      };
    }

    const updates: { title?: string; description?: string } = {};
    if (title) updates.title = title;
    if (description) updates.description = description;

    await updateTicket(ctx.projectId, ticketId, updates);
    return {
      content: [{ type: "text", text: `Ticket ${ticketId} updated successfully` }],
    };
  },

  set_ticket_complexity: async (ctx, args) => {
    const ticketId = args.ticketId as string | undefined;
    const complexity = args.complexity as string | undefined;

    if (!ticketId) {
      return { content: [{ type: "text", text: "Error: ticketId is required" }] };
    }

    const validComplexities: Complexity[] = ["simple", "standard", "complex"];
    if (!complexity || !validComplexities.includes(complexity as Complexity)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: complexity must be one of: ${validComplexities.join(", ")}`,
          },
        ],
      };
    }

    await updateTicket(ctx.projectId, ticketId, { complexity: complexity as Complexity });
    return {
      content: [
        { type: "text", text: `Ticket ${ticketId} complexity set to '${complexity}'` },
      ],
    };
  },
};
```

**Step 4: Run tests to verify pass**

```bash
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/mcp/tools/__tests__/pm.tools.test.js
```
Expected: PASS (all 7 assertions)

**Step 5: TypeScript check**

```bash
cd apps/daemon && pnpm typecheck
```
Expected: no errors

**Step 6: Commit**

```
git add apps/daemon/src/mcp/tools/pm.tools.ts apps/daemon/src/mcp/tools/__tests__/pm.tools.test.ts
git commit -m "feat: add pm.tools.ts with move_ticket, update_ticket, set_ticket_complexity"
```

---

## Task 4: Register PM tools in index.ts

**Depends on:** Task 2, Task 3
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/mcp/tools/index.ts`

**Purpose:** Makes the new PM tools available to the daemon's MCP route handlers.

**Step 1: Write the failing test**

```bash
cd apps/daemon && pnpm build && node -e "
import('./dist/mcp/tools/index.js').then(m => {
  const pmToolNames = m.allTools.filter(t => t.mcpServer === 'pm').map(t => t.name);
  console.log('PM tools:', pmToolNames.join(', '));
  if (!pmToolNames.includes('move_ticket')) throw new Error('move_ticket missing');
  if (!pmToolNames.includes('update_ticket')) throw new Error('update_ticket missing');
  if (!pmToolNames.includes('set_ticket_complexity')) throw new Error('set_ticket_complexity missing');
  if (!pmToolNames.includes('get_epic_status')) throw new Error('get_epic_status missing');
  console.log('All PM tools registered');
});
"
```
Expected: FAIL (pm.tools not imported yet — Module not found error)

**Step 2: Update index.ts**

```typescript
import { ticketTools, ticketHandlers } from "./ticket.tools.js";
import { chatTools, chatHandlers } from "./chat.tools.js";
import { taskTools, taskHandlers } from "./task.tools.js";
import { ralphTools, ralphHandlers } from "./ralph.tools.js";
import { artifactTools, artifactHandlers } from "./artifact.tools.js";
import { dependencyTools, dependencyHandlers } from "./dependency.tools.js";
import { scopeTools, scopeHandlers } from "./scope.tools.js";
import { epicTools, epicHandlers } from "./epic.tools.js";
import { pmTools, pmHandlers } from "./pm.tools.js";
import type {
  ToolDefinition,
  McpContext,
  McpToolResult,
} from "../../types/mcp.types.js";

export const allTools: ToolDefinition[] = [
  ...ticketTools,
  ...chatTools,
  ...taskTools,
  ...ralphTools,
  ...artifactTools,
  ...dependencyTools,
  ...scopeTools,
  ...epicTools,
  ...pmTools,
];

export const allHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  ...ticketHandlers,
  ...chatHandlers,
  ...taskHandlers,
  ...ralphHandlers,
  ...artifactHandlers,
  ...dependencyHandlers,
  ...scopeHandlers,
  ...epicHandlers,
  ...pmHandlers,
};

export {
  ticketTools, chatTools, taskTools, ralphTools, artifactTools,
  dependencyTools, scopeTools, epicTools, pmTools,
};
export {
  ticketHandlers, chatHandlers, taskHandlers, ralphHandlers, artifactHandlers,
  dependencyHandlers, scopeHandlers, epicHandlers, pmHandlers,
};
```

**Step 3: Run verification**

```bash
cd apps/daemon && pnpm build && node -e "
import('./dist/mcp/tools/index.js').then(m => {
  const pmToolNames = m.allTools.filter(t => t.mcpServer === 'pm').map(t => t.name);
  console.log('PM tools:', pmToolNames.join(', '));
  console.log('Total tools:', m.allTools.length);
});
"
```
Expected: PM tools includes move_ticket, update_ticket, set_ticket_complexity, get_epic_status, etc.

**Step 4: Run full test suite**

```bash
cd apps/daemon && pnpm test
```
Expected: no regressions

**Step 5: Commit**

```
git add apps/daemon/src/mcp/tools/index.ts
git commit -m "feat: register pm tools in mcp tools index"
```

---

## Task 5: Update proxy.ts to support POTATO_MCP_SCOPE

**Depends on:** Task 1
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/mcp/proxy.ts`

**Purpose:** Each proxy process now advertises itself as either `potato-ticket` or `potato-pm` and fetches only its own tool subset from the daemon, so Claude sees two distinct MCP servers with non-overlapping tool sets.

**Not In Scope:** Spawning the second proxy — that's Task 6.

**Gotchas:** The proxy validation in `main()` requires `POTATO_PROJECT_ID` + one of `POTATO_TICKET_ID` / `POTATO_BRAINSTORM_ID`. PM proxies have `POTATO_BRAINSTORM_ID` set, so no changes needed there.

**Step 1: Update proxy.ts**

```typescript
// Add at top with other env vars:
const MCP_SCOPE = (process.env.POTATO_MCP_SCOPE || "ticket") as "ticket" | "pm";

// Update buildToolsUrl to include mcpServer param:
export function buildToolsUrl(daemonUrl: string, agentSource: string, projectId: string, mcpScope: "ticket" | "pm"): string {
  const url = new URL(`${daemonUrl}/mcp/tools`);
  if (agentSource) url.searchParams.set('agentSource', agentSource);
  if (projectId) url.searchParams.set('projectId', projectId);
  url.searchParams.set('mcpServer', mcpScope);
  return url.toString();
}

// Update server name to use scope:
const server = new Server(
  { name: `potato-${MCP_SCOPE}`, version: '4.0.0' },
  { capabilities: { tools: {} } }
);

// Update fetchTools call in ListTools handler and main():
cachedTools = await fetchTools(daemonUrl, AGENT_SOURCE, PROJECT_ID, MCP_SCOPE);

// Update fetchTools signature:
async function fetchTools(
  daemonUrl: string,
  agentSource?: string,
  projectId?: string,
  mcpScope: "ticket" | "pm" = "ticket"
): Promise<unknown[]> {
  try {
    const url = buildToolsUrl(daemonUrl, agentSource ?? '', projectId ?? '', mcpScope);
    // ...
  }
}
```

**Step 2: Update existing proxy.test.ts**

`buildToolsUrl` gains a required `mcpScope` parameter. Update `apps/daemon/src/mcp/__tests__/proxy.test.ts` to pass the new argument and add assertions for the `mcpServer` query param:

```typescript
// Update existing buildToolsUrl tests:
test('buildToolsUrl includes agentSource and projectId as query params', () => {
  const url = buildToolsUrl('http://localhost:8443', 'agents/builder.md', 'proj-123', 'ticket');
  assert.ok(url.includes('agentSource=agents%2Fbuilder.md'));
  assert.ok(url.includes('projectId=proj-123'));
  assert.ok(url.includes('mcpServer=ticket'));
});

test('buildToolsUrl omits params when not provided', () => {
  const url = buildToolsUrl('http://localhost:8443', '', '', 'ticket');
  assert.ok(!url.includes('agentSource'));
  assert.ok(!url.includes('projectId'));
  assert.ok(url.includes('mcpServer=ticket'));
});

// Add new test:
test('buildToolsUrl sets mcpServer=pm for pm scope', () => {
  const url = buildToolsUrl('http://localhost:8443', '', '', 'pm');
  assert.ok(url.includes('mcpServer=pm'));
});
```

**Step 3: Run test**

```bash
cd apps/daemon && pnpm build && node --test dist/mcp/__tests__/proxy.test.js
```
Expected: PASS (all assertions including new mcpServer ones)

**Step 4: TypeScript check**

```bash
cd apps/daemon && pnpm typecheck
```
Expected: no errors

**Step 5: Build and quick smoke test**

```bash
cd apps/daemon && pnpm build
# Verify server name changes:
POTATO_PROJECT_ID=test POTATO_BRAINSTORM_ID=brain_1 POTATO_MCP_SCOPE=pm node dist/mcp/proxy.js &
sleep 2 && kill %1
```
Expected: starts without error (will warn about no tools since daemon not running — that's fine)

**Step 6: Commit**

```
git add apps/daemon/src/mcp/proxy.ts apps/daemon/src/mcp/__tests__/proxy.test.ts
git commit -m "feat: proxy reads POTATO_MCP_SCOPE to set server name and tool filter"
```

---

## Task 6: Update session.service.ts — rename server and add PM dual-server config

**Depends on:** Task 5
**Complexity:** standard
**Files:**
- Modify: `apps/daemon/src/services/session/session.service.ts`
- Modify: `apps/daemon/src/system-agents/runner.ts`
- Modify: `apps/daemon/src/server/routes/artifact-chat.routes.ts`
- Modify: `apps/daemon/src/services/session/__tests__/session.service.test.ts`
- Modify: `apps/daemon/src/services/session/__tests__/session-pty-capture.test.ts`

**Purpose:** All ticket agent sessions get the renamed `potato-ticket` server. PM (brainstorm) sessions get both `potato-ticket` and `potato-pm` servers. The disallowed tool name is updated to match the new server name.

**Gotchas:** There are two separate MCP config blocks — one in `spawnClaudeSession` (~line 1065) for ticket agents, one in `spawnForBrainstorm` (~line 1621) for brainstorm/PM. Both need updating. `spawnForBrainstorm` inlines the config as JSON string; `spawnClaudeSession` writes it to a temp file.

Two additional call-sites outside `session.service.ts` also hardcode `"potato-cannon"` as the MCP server key and must be updated in the same task or the MCP connection will silently fail for those session types (mcpConfig key `"potato-cannon"` would not match the proxy advertising itself as `"potato-ticket"`):
- `apps/daemon/src/system-agents/runner.ts` (~line 44) — used by system agent execution
- `apps/daemon/src/server/routes/artifact-chat.routes.ts` (~line 321) — used by artifact chat sessions

Additionally, two test files reference `"potato-cannon"` in fixture data and must be updated to avoid `pnpm test` failures after this task:
- `apps/daemon/src/services/session/__tests__/session.service.test.ts` — multiple `mcpServerNames: ["potato-cannon", ...]` assertions
- `apps/daemon/src/services/session/__tests__/session-pty-capture.test.ts` — `mcp__potato-cannon__chat_ask` tool name fixture (only affects test fixture correctness, not runtime)

**Step 1: Update `spawnClaudeSession` — rename server**

Find the `mcpConfig` block (~line 1065) and rename the server key and add `POTATO_MCP_SCOPE`:

```typescript
const mcpConfig = {
  mcpServers: {
    "potato-ticket": {           // was "potato-cannon"
      command: nodePath,
      args: [mcpProxyPath],
      env: {
        POTATO_PROJECT_ID: projectId,
        POTATO_TICKET_ID: ticketId,
        POTATO_BRAINSTORM_ID: brainstormId,
        POTATO_WORKFLOW_ID: workflowId,
        POTATO_AGENT_MODEL: model || "",
        POTATO_AGENT_SOURCE: agentType || "",
        POTATO_MCP_SCOPE: "ticket",   // new
      },
    },
    ...additionalMcpServers,
  },
};
```

**Step 2: Update `spawnForBrainstorm` — rename server + add potato-pm for PM sessions**

Find the `mcpConfig` block (~line 1621). Replace:

```typescript
const mcpConfig = {
  mcpServers: {
    "potato-ticket": {           // was "potato-cannon"
      command: nodePath,
      args: [mcpProxyPath],
      env: {
        POTATO_PROJECT_ID: projectId,
        POTATO_TICKET_ID: "",
        POTATO_BRAINSTORM_ID: brainstormId,
        POTATO_WORKFLOW_ID: workflowId,
        POTATO_AGENT_MODEL: "",
        POTATO_AGENT_SOURCE: agentType,
        POTATO_MCP_SCOPE: "ticket",   // new
      },
    },
    // PM sessions get an additional server for PM-specific tools
    ...(usePm ? {
      "potato-pm": {
        command: nodePath,
        args: [mcpProxyPath],
        env: {
          POTATO_PROJECT_ID: projectId,
          POTATO_TICKET_ID: "",
          POTATO_BRAINSTORM_ID: brainstormId,
          POTATO_WORKFLOW_ID: workflowId,
          POTATO_AGENT_MODEL: "",
          POTATO_AGENT_SOURCE: agentType,
          POTATO_MCP_SCOPE: "pm",     // new PM server
        },
      },
    } : {}),
  },
};
```

**Step 3: Update disallowed tool name**

Find the disallowed tools line (~line 1666):

```typescript
// Before:
...(usePm ? ["mcp__potato-cannon__ralph_loop_dock"] : []),

// After:
...(usePm ? ["mcp__potato-ticket__ralph_loop_dock"] : []),
```

**Step 3b: Update `mcpServerNames` in `buildContinuityCompatibilityKey` calls**

There are two `mcpServerNames` references that also use `"potato-cannon"` (~lines 1866 and 2126). Both must be renamed to `"potato-ticket"` or the continuity hash will mismatch, forcing unnecessary session invalidations:

```typescript
// Before (appears twice):
mcpServerNames: ["potato-cannon", ...Object.keys(additionalMcpServers)],

// After (both occurrences):
mcpServerNames: ["potato-ticket", ...Object.keys(additionalMcpServers)],
```

**Step 3c: Rename server key in `system-agents/runner.ts` and `artifact-chat.routes.ts`**

Both files hardcode `"potato-cannon"` as the mcpServers key. After `proxy.ts` is updated (Task 5), the proxy advertises itself as `potato-ticket` by default, so a mismatched key in the mcpConfig will prevent Claude from connecting to the MCP server entirely. Update both:

```typescript
// system-agents/runner.ts (~line 44):
"potato-ticket": {   // was "potato-cannon"

// artifact-chat.routes.ts (~line 321):
"potato-ticket": {   // was "potato-cannon"
```

**Step 3d: Update test fixtures referencing `"potato-cannon"`**

`session.service.test.ts` contains multiple compatibility-key fixture objects with `mcpServerNames: ["potato-cannon", ...]` — update all occurrences to `"potato-ticket"`. `session-pty-capture.test.ts` uses `mcp__potato-cannon__chat_ask` as a fixture tool name — update to `mcp__potato-ticket__chat_ask`.

```bash
# Verify all occurrences found and changed:
grep -r "potato-cannon" apps/daemon/src/services/session/__tests__/
```
Expected: zero matches after update.

**Step 4: TypeScript check**

```bash
cd apps/daemon && pnpm typecheck
```
Expected: no errors

**Step 5: Build + run daemon smoke test**

```bash
cd apps/daemon && pnpm build
# Start daemon and verify it starts cleanly:
./bin/potato-cannon.js start
sleep 3
curl http://localhost:8443/health
./bin/potato-cannon.js stop
```
Expected: daemon starts and responds to health check

**Step 6: Verify tool filtering via HTTP**

```bash
./bin/potato-cannon.js start
sleep 2
# Ticket tools (should NOT include get_epic_status or move_ticket):
curl -s "http://localhost:8443/mcp/tools?mcpServer=ticket" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const t=JSON.parse(d).tools.map(x=>x.name); console.log('ticket count:', t.length); console.log('has get_epic_status:', t.includes('get_epic_status')); console.log('has move_ticket:', t.includes('move_ticket')); console.log('has get_ticket:', t.includes('get_ticket'));"
# PM tools (should include get_epic_status, move_ticket but NOT ralph_loop_dock):
curl -s "http://localhost:8443/mcp/tools?mcpServer=pm" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const t=JSON.parse(d).tools.map(x=>x.name); console.log('pm count:', t.length); console.log('has get_epic_status:', t.includes('get_epic_status')); console.log('has move_ticket:', t.includes('move_ticket')); console.log('has ralph_loop_dock:', t.includes('ralph_loop_dock'));"
./bin/potato-cannon.js stop
```
Expected:
- ticket: `has get_epic_status: false`, `has move_ticket: false`, `has get_ticket: true`
- pm: `has get_epic_status: true`, `has move_ticket: true`, `has ralph_loop_dock: false`

**Step 7: Run full test suite**

```bash
cd apps/daemon && pnpm test
```
Expected: all tests pass

**Step 8: Commit**

```
git add apps/daemon/src/services/session/session.service.ts apps/daemon/src/system-agents/runner.ts apps/daemon/src/server/routes/artifact-chat.routes.ts apps/daemon/src/services/session/__tests__/session.service.test.ts apps/daemon/src/services/session/__tests__/session-pty-capture.test.ts
git commit -m "feat: rename potato-cannon to potato-ticket and add potato-pm server for PM sessions"
```

---

## Task 7: Update documentation and project MCP config

**Depends on:** Task 6
**Complexity:** simple
**Files:**
- Modify: `apps/daemon/src/mcp/CLAUDE.md`
- Modify: `CLAUDE.md` (root)
- Modify: `.mcp.json` (root)

**Purpose:** Keep CLAUDE.md accurate for future agents.

**Step 1: Update `apps/daemon/src/mcp/CLAUDE.md`**

Update the proxy section to reflect two-server architecture:

```markdown
## Two-Server Architecture

Sessions now receive one or two MCP proxy processes:

| Session Type | Servers | Tool Set |
|-------------|---------|----------|
| Ticket agent | `potato-ticket` | Chat, task, artifact, ticket query tools |
| PM (brainstorm) | `potato-ticket` + `potato-pm` | All of the above + epic mgmt, move/update ticket |

The `POTATO_MCP_SCOPE` environment variable controls which server a proxy instance advertises:
- `ticket` (default) → names itself `potato-ticket`, fetches `?mcpServer=ticket` tools
- `pm` → names itself `potato-pm`, fetches `?mcpServer=pm` tools

### Tool Assignment

**potato-ticket** (ticket agents):
`chat_ask`, `chat_notify`, `chat_init`, `get_ticket`, `attach_artifact`, `create_task`, `update_task_status`, `get_task`, `list_tasks`, `add_comment_to_task`, `ralph_loop_dock`, `list_artifacts`, `get_artifact`, `set_plan_summary`

**potato-pm** (PM sessions only):
`get_epic_status`, `set_epic_pm_mode`, `list_tickets`, `create_ticket`, `add_ticket_comment`, `get_dependencies`, `add_dependency`, `delete_dependency`, `get_dependents`, `move_ticket`, `update_ticket`, `set_ticket_complexity`
```

Update the Session Spawning section to show the PM dual-server config example.

**Step 2: Update root `CLAUDE.md` MCP Tools table**

Add the three new tools to the MCP Tools table:

```markdown
| `move_ticket`  | Move ticket to a different phase (PM only) |
| `update_ticket` | Update ticket title/description (PM only) |
| `set_ticket_complexity` | Set ticket complexity (PM only) |
```

**Step 3: Update `.mcp.json`**

The root `.mcp.json` is the developer-facing external proxy config (used by Claude Code when working on this repo). It references `"potato-cannon"` as the server key, which must be renamed to `"potato-ticket"` to match the new server name:

```json
{
  "mcpServers": {
    "potato-ticket": {
      "command": "node",
      "args": ["D:/GIT/potato-cannonP4/apps/daemon/dist/mcp/external-proxy.js"],
      "env": {
        "POTATO_PROJECT_SLUG": "p4-potato-cannon"
      }
    }
  }
}
```

Note: `POTATO_PROJECT_SLUG` stays unchanged — that's the project identifier, not the server name.

**Step 4: Commit**

```
git add apps/daemon/src/mcp/CLAUDE.md CLAUDE.md .mcp.json
git commit -m "docs: document two-server MCP architecture, new PM tools, and rename mcp.json server key"
```

---

## Testing the Full Flow

After all tasks are complete:

```bash
# Build everything
pnpm build

# Run full test suite
pnpm test

# TypeScript check
pnpm typecheck
```

Expected: all tests pass, no type errors.

Manual smoke test (requires running daemon + PM-enabled epic):
1. Start daemon
2. Open an epic with PM mode = "watching" or "executing"
3. Send a message to the PM chat
4. Verify PM responds (was broken before this session's earlier fixes)
5. Ask PM to move a ticket to Build phase — it should call `move_ticket` instead of improvising

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | ✅ | All stated requirements addressed across 7 tasks |
| Accurate | ✅ | All file paths verified; new files in correct locations; `updateTicket` signature and `Complexity` type confirmed |
| Commands valid | ✅ | Fixed: test commands corrected to `pnpm build && node --experimental-test-module-mocks --test dist/...` |
| YAGNI | ✅ | Every task serves a directly stated requirement |
| Minimal | ✅ | Tasks are well-scoped; no redundant steps |
| Not over-engineered | ✅ | Additive tag approach + HTTP delegation is minimal |
| Key Decisions documented | ✅ | Five decisions with rationale in header |
| Context sections present | ✅ | Purpose on all tasks; Not In Scope on boundary tasks; Gotchas on Tasks 3 and 6 |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | EDITED | 2 | Promoted header fields to `##` headings; corrected Verification Record table row label |
| Feasibility | EDITED | 3 | Fixed `../pm.tools.js` relative import in test; added Step 3b for `mcpServerNames` rename at lines 1866+2126 of session.service.ts |
| Completeness | EDITED | 3 | Added `proxy.test.ts` update step to Task 5 (buildToolsUrl signature change breaks existing test); added `.mcp.json` to Task 7 Files + Step 3 |
| Risk | EDITED | 4 | Added two missing call-sites (`runner.ts`, `artifact-chat.routes.ts`) and two test fixtures to Task 6 — all hardcode `"potato-cannon"` and would silently break MCP after rename |
| Optimality | EDITED | 2 | Reordered Task 6 sub-steps to sequential 3/3b/3c/3d; all tasks justified, no over-engineering found |
