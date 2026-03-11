import { describe, it } from "node:test";
import assert from "node:assert";
import {
  mapLifecycleConflict,
  mapStaleTicketInput,
} from "../routes/tickets.routes.js";
import {
  TicketLifecycleConflictError,
  StaleTicketInputError,
} from "../../services/session/session.service.js";

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

describe("tickets stale input mapping", () => {
  it("maps StaleTicketInputError to non-retryable 409 payload", () => {
    const error = new StaleTicketInputError(
      "Ticket input no longer matches the active lifecycle",
      12,
      11,
      "q-expected",
      "q-provided",
    );
    const mapped = mapStaleTicketInput(error);

    assert.ok(mapped);
    assert.strictEqual(mapped.status, 409);
    assert.deepStrictEqual(mapped.body, {
      code: "STALE_TICKET_INPUT",
      message: "Ticket input no longer matches the active lifecycle",
      reason: "Ticket input no longer matches the active lifecycle",
      retryable: false,
      currentGeneration: 12,
      providedGeneration: 11,
      expectedQuestionId: "q-expected",
      providedQuestionId: "q-provided",
    });
  });

  it("returns null for unrelated stale errors", () => {
    const mapped = mapStaleTicketInput(new Error("boom"));
    assert.strictEqual(mapped, null);
  });
});
