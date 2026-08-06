// src/consumer/parse.ts
//
// Classifies an inbound queue message before any effect is chosen
// (design.md §4.4). Three of the four outcomes are terminal-but-recorded:
// an unsupported version, an unrecognized type, and a malformed payload all
// become an `ignored` inbox row plus a metric — never a retry, never a DLQ
// entry. Retrying any of them is guaranteed to fail identically.

import { type } from "arktype";
import { type EventV1, eventV1 } from "../events/v1";

export type ParseResult =
  | { kind: "ok"; event: EventV1 }
  | { kind: "version_unsupported"; eventId: string | null; specVersion: string }
  | { kind: "type_unsupported"; eventId: string | null; type: string }
  | { kind: "malformed"; eventId: string | null; reason: string };

// Just enough to identify an event for the inbox even when the rest is wrong.
// Deliberately looser than the real contract: this is a forensics shape, not
// a validation gate.
const identifiable = type({
  "eventId?": "string",
  "specVersion?": "string",
  "type?": "string",
});

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "identity.child.upserted",
  "identity.child.deleted",
  "identity.parent.deleted",
  "learning.lesson.completed",
  "learning.challenge.achieved",
  "learning.star.awarded",
  "reporting.week.closed",
]);

export function parseEnvelope(value: unknown): ParseResult {
  const shallow = identifiable(value);
  if (shallow instanceof type.errors) {
    return { kind: "malformed", eventId: null, reason: "not an object envelope" };
  }

  // Version gate FIRST — `eventV1` pins specVersion to "1.0" exactly, so
  // letting the contract decide would make a 1.1 envelope indistinguishable
  // from a 2.0 one. A 1.x minor bump must process (additive-only within a
  // major, §2); a 2.0 must be `ignored` rather than a generic parse failure.
  const specVersion = shallow.specVersion;
  if (typeof specVersion !== "string") {
    return { kind: "malformed", eventId: shallow.eventId ?? null, reason: "missing specVersion" };
  }
  const major = specVersion.split(".")[0];
  if (major !== "1") {
    return { kind: "version_unsupported", eventId: shallow.eventId ?? null, specVersion };
  }

  const eventType = shallow.type;
  if (typeof eventType !== "string") {
    return { kind: "malformed", eventId: shallow.eventId ?? null, reason: "missing type" };
  }
  if (!KNOWN_TYPES.has(eventType)) {
    return { kind: "type_unsupported", eventId: shallow.eventId ?? null, type: eventType };
  }

  // Normalize the version for the contract check only. The original string is
  // never persisted from here; the inbox stores the raw payload.
  const forContract = { ...(value as Record<string, unknown>), specVersion: "1.0" };
  const parsed = eventV1(forContract);
  if (parsed instanceof type.errors) {
    return {
      kind: "malformed",
      eventId: shallow.eventId ?? null,
      reason: parsed
        .map((e) => e.toString())
        .join("; ")
        .slice(0, 300),
    };
  }

  return { kind: "ok", event: parsed };
}

export function isKnownType(value: string): boolean {
  return KNOWN_TYPES.has(value);
}
