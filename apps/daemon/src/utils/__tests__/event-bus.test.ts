import { beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import { EventBus } from "../event-bus.js";

class MockResponse extends EventEmitter {
  writes: string[] = [];
  writableEnded = false;
  destroyed = false;
  private shouldThrow = false;

  setThrowOnWrite(value: boolean): void {
    this.shouldThrow = value;
  }

  write(chunk: string): boolean {
    if (this.shouldThrow) {
      throw new Error("socket closed");
    }
    this.writes.push(chunk);
    return true;
  }
}

function asResponse(mock: MockResponse): Response {
  return mock as unknown as Response;
}

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("broadcasts to connected clients", () => {
    const clientA = new MockResponse();
    const clientB = new MockResponse();

    bus.addClient(asResponse(clientA));
    bus.addClient(asResponse(clientB));

    bus.broadcast("ticket:updated", { projectId: "p1", ticketId: "JCI-20" });

    assert.strictEqual(clientA.writes.length, 1);
    assert.strictEqual(clientB.writes.length, 1);
    assert.match(clientA.writes[0], /event: ticket:updated/);
  });

  it("removes clients that throw on write and keeps broadcasting", () => {
    const broken = new MockResponse();
    const healthy = new MockResponse();

    broken.setThrowOnWrite(true);

    bus.addClient(asResponse(broken));
    bus.addClient(asResponse(healthy));

    // Must not throw even if one client socket fails.
    bus.broadcast("session:started", { sessionId: "sess_1" });
    bus.broadcast("session:ended", { sessionId: "sess_1" });

    assert.strictEqual(healthy.writes.length, 2);
    assert.strictEqual(broken.writes.length, 0);
  });
});
