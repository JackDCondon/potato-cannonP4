import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createRetryScheduler, type RetryScheduler } from "../retry-scheduler.js";

describe("RetryScheduler", () => {
  let scheduler: RetryScheduler;
  let resumeFn: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    resumeFn = mock.fn(async () => {});
    scheduler = createRetryScheduler(resumeFn as unknown as (projectId: string, ticketId: string) => Promise<void>);
  });

  afterEach(() => {
    scheduler.cancelAll();
    mock.timers.reset();
  });

  it("should schedule a retry and fire at the correct time", () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString(); // 1 minute from now
    scheduler.schedule("proj-1", "TKT-1", retryAt);

    assert.equal(resumeFn.mock.callCount(), 0);
    mock.timers.tick(60_000);
    assert.equal(resumeFn.mock.callCount(), 1);
    assert.deepEqual(resumeFn.mock.calls[0].arguments, ["proj-1", "TKT-1"]);
  });

  it("should cancel a scheduled retry", () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    scheduler.schedule("proj-1", "TKT-1", retryAt);
    scheduler.cancel("TKT-1");

    mock.timers.tick(60_000);
    assert.equal(resumeFn.mock.callCount(), 0);
  });

  it("should fire immediately for past retryAt", () => {
    const retryAt = new Date(Date.now() - 10_000).toISOString(); // 10s in the past
    scheduler.schedule("proj-1", "TKT-1", retryAt);

    // setTimeout with delay <= 0 fires on next tick
    mock.timers.tick(1);
    assert.equal(resumeFn.mock.callCount(), 1);
  });

  it("should replace existing timer if scheduled again", () => {
    const retryAt1 = new Date(Date.now() + 60_000).toISOString();
    const retryAt2 = new Date(Date.now() + 120_000).toISOString();

    scheduler.schedule("proj-1", "TKT-1", retryAt1);
    scheduler.schedule("proj-1", "TKT-1", retryAt2); // Reschedule

    mock.timers.tick(60_000);
    assert.equal(resumeFn.mock.callCount(), 0, "Old timer should have been cancelled");

    mock.timers.tick(60_000); // 120s total
    assert.equal(resumeFn.mock.callCount(), 1);
  });

  it("cancelAll should clear all pending timers", () => {
    scheduler.schedule("proj-1", "TKT-1", new Date(Date.now() + 60_000).toISOString());
    scheduler.schedule("proj-1", "TKT-2", new Date(Date.now() + 60_000).toISOString());

    scheduler.cancelAll();
    mock.timers.tick(60_000);
    assert.equal(resumeFn.mock.callCount(), 0);
  });
});
