import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/consumer/parse";

const valid = {
  specVersion: "1.0",
  eventId: "chi_1:upserted:2026-08-04T10:00:00Z",
  type: "identity.child.upserted",
  occurredAt: "2026-08-04T10:00:00Z",
  producer: "robo-worker",
  subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
  data: { name: "An", age: 6, stage: "A1" },
};

describe("parseEnvelope", () => {
  it("accepts a valid 1.0 envelope", () => {
    const out = parseEnvelope(valid);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.event.type).toBe("identity.child.upserted");
      expect(out.event.eventId).toBe("chi_1:upserted:2026-08-04T10:00:00Z");
    }
  });

  it("classifies a 2.0 envelope as version_unsupported, not a parse failure", () => {
    const out = parseEnvelope({ ...valid, specVersion: "2.0" });
    expect(out.kind).toBe("version_unsupported");
    // Must still surface the id so the inbox can record an `ignored` row against it.
    if (out.kind === "version_unsupported") expect(out.eventId).toBe(valid.eventId);
  });

  it("classifies an unknown type as type_unsupported", () => {
    const out = parseEnvelope({ ...valid, type: "learning.something.new" });
    expect(out.kind).toBe("type_unsupported");
    if (out.kind === "type_unsupported") expect(out.eventId).toBe(valid.eventId);
  });

  it("classifies a structurally broken payload as malformed", () => {
    expect(parseEnvelope({ nope: 1 }).kind).toBe("malformed");
    expect(parseEnvelope(null).kind).toBe("malformed");
    expect(parseEnvelope("a string").kind).toBe("malformed");
  });

  it("treats a 1.x minor bump as processable — additive-only within a major", () => {
    // A 1.1 producer adding fields must NOT be ignored; §2's additive rule is
    // exactly what makes this safe.
    const out = parseEnvelope({ ...valid, specVersion: "1.1" });
    expect(out.kind).toBe("ok");
  });

  it("recovers the eventId from a malformed-but-identifiable payload", () => {
    // Enough envelope to know WHICH event this was, but the data shape is
    // wrong. Recording an `ignored` row still beats an untraceable DLQ entry.
    const out = parseEnvelope({ ...valid, data: { age: "not a number" } });
    expect(out.kind).toBe("malformed");
    if (out.kind === "malformed") expect(out.eventId).toBe(valid.eventId);
  });
});
