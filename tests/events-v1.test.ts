import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { eventV1 } from "../src/events/v1";

const baseSubject = { parentId: "par_1", childId: "chi_1", childName: "An" };

describe("eventV1 — identity events", () => {
  it("accepts a valid identity.child.upserted envelope", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:upserted:2026-08-04T10:00:00Z",
      type: "identity.child.upserted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { name: "An", age: 6, stage: "A1" },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("accepts identity.child.deleted with empty data", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:deleted",
      type: "identity.child.deleted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: {},
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects a missing required subject field", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:deleted",
      type: "identity.child.deleted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: { parentId: "par_1", childName: "An" }, // childId missing
      data: {},
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("ignores unknown fields on data — additive-only within a major (design.md §2)", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:upserted:2026-08-04T10:00:00Z",
      type: "identity.child.upserted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { name: "An", age: 6, stage: "A1", futureField: "whatever" },
    });
    expect(out instanceof type.errors).toBe(false);
  });
});
