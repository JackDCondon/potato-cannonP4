import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { DEFAULT_PM_CONFIG, type Brainstorm } from "@potato-cannon/shared";

const mockGetBrainstorm = mock.fn(
  async (): Promise<Brainstorm> =>
    ({
      id: "brain_1",
      name: "Epic One",
      status: "epic",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }) as Brainstorm,
);
const mockUpdateBrainstormPmConfig = mock.fn(() => {});
const mockGetTicketsByBrainstormId = mock.fn(() => []);
const mockListTasks = mock.fn(() => []);
const mockTicketDependencyGetForTicket = mock.fn(() => []);

mock.module("../../stores/brainstorm.store.js", {
  namedExports: {
    getBrainstorm: mockGetBrainstorm,
    updateBrainstormPmConfig: mockUpdateBrainstormPmConfig,
  },
});

mock.module("../../stores/ticket.store.js", {
  namedExports: {
    getTicketsByBrainstormId: mockGetTicketsByBrainstormId,
  },
});

mock.module("../../stores/task.store.js", {
  namedExports: {
    listTasks: mockListTasks,
  },
});

mock.module("../../stores/ticket-dependency.store.js", {
  namedExports: {
    ticketDependencyGetForTicket: mockTicketDependencyGetForTicket,
  },
});

const { epicHandlers } = await import("./epic.tools.js");

describe("set_epic_pm_mode", () => {
  beforeEach(() => {
    mockGetBrainstorm.mock.resetCalls();
    mockUpdateBrainstormPmConfig.mock.resetCalls();
    mockGetTicketsByBrainstormId.mock.resetCalls();
    mockListTasks.mock.resetCalls();
    mockTicketDependencyGetForTicket.mock.resetCalls();
  });

  it("updates pm config to watching mode from session context", async () => {
    mockGetBrainstorm.mock.mockImplementationOnce(async () => {
      return {
        id: "brain_1",
        name: "Epic One",
        status: "epic",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as Brainstorm;
    });

    const result = await epicHandlers.set_epic_pm_mode(
      {
        projectId: "proj_1",
        brainstormId: "brain_1",
        daemonUrl: "http://localhost:8443",
      },
      { mode: "watching" },
    );

    assert.match(result.content[0].text, /set to 'watching'/);
    assert.strictEqual(mockGetBrainstorm.mock.calls.length, 1);
    assert.deepStrictEqual(mockGetBrainstorm.mock.calls[0]?.arguments, [
      "proj_1",
      "brain_1",
    ]);
    assert.strictEqual(mockUpdateBrainstormPmConfig.mock.calls.length, 1);
    assert.deepStrictEqual(mockUpdateBrainstormPmConfig.mock.calls[0]?.arguments, [
      "brain_1",
      {
        pmEnabled: true,
        pmConfig: {
          ...DEFAULT_PM_CONFIG,
          mode: "watching",
        },
      },
    ]);
  });

  it("sets pmEnabled=false when mode is passive", async () => {
    mockGetBrainstorm.mock.mockImplementationOnce(async () => {
      return {
        id: "brain_1",
        name: "Epic One",
        status: "epic",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pmConfig: {
          ...DEFAULT_PM_CONFIG,
          mode: "executing",
        },
      } as Brainstorm;
    });

    await epicHandlers.set_epic_pm_mode(
      {
        projectId: "proj_1",
        brainstormId: "brain_1",
        daemonUrl: "http://localhost:8443",
      },
      { mode: "passive" },
    );

    assert.strictEqual(mockUpdateBrainstormPmConfig.mock.calls.length, 1);
    assert.deepStrictEqual(mockUpdateBrainstormPmConfig.mock.calls[0]?.arguments, [
      "brain_1",
      {
        pmEnabled: false,
        pmConfig: {
          ...DEFAULT_PM_CONFIG,
          mode: "passive",
        },
      },
    ]);
  });

  it("returns an error when brainstormId is missing from both context and args", async () => {
    const result = await epicHandlers.set_epic_pm_mode(
      {
        projectId: "proj_1",
        daemonUrl: "http://localhost:8443",
      },
      { mode: "watching" },
    );

    assert.match(result.content[0].text, /no brainstormId/i);
    assert.strictEqual(mockGetBrainstorm.mock.calls.length, 0);
    assert.strictEqual(mockUpdateBrainstormPmConfig.mock.calls.length, 0);
  });
});
