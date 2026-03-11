import { describe, it } from "node:test";
import assert from "node:assert";
import { mapLifecycleConflict } from "../routes/tickets.routes.js";
import { TicketLifecycleConflictError } from "../../services/session/session.service.js";

describe("tickets lifecycle conflict mapping", () => {
  it("maps TicketLifecycleConflictError to retryable 409 payload", () => {
    const error = new TicketLifecycleConflictError("Build", 7);
    const mapped = mapLifecycleConflict(error);

    assert.ok(mapped);
    assert.strictEqual(mapped.status, 409);
    assert.deepStrictEqual(mapped.body, {
      code: "TICKET_LIFECYCLE_CONFLICT",
      message: "Ticket lifecycle changed concurrently",
      currentPhase: "Build",
      currentGeneration: 7,
      retryable: true,
    });
  });

  it("returns null for unrelated errors", () => {
    const mapped = mapLifecycleConflict(new Error("boom"));
    assert.strictEqual(mapped, null);
  });
});
