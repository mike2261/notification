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

describe("eventV1 — learning + reporting events", () => {
  it("accepts learning.lesson.completed", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "led_1:lesson_completed",
      type: "learning.lesson.completed",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { courseId: "c1", lessonId: "l1", outcome: "achieved", durationS: 300 },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects an outcome value outside the enum", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "led_1:lesson_completed",
      type: "learning.lesson.completed",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { courseId: "c1", lessonId: "l1", outcome: "perfect", durationS: 300 },
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("accepts learning.challenge.achieved", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "led_1:challenge_achieved",
      type: "learning.challenge.achieved",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { courseId: "c1", challengeId: "ch1", firstTime: true },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("accepts learning.star.awarded", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "led_1:star_awarded",
      type: "learning.star.awarded",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { courseId: "c1", challengeId: "ch1", totalStars: 12 },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("accepts reporting.week.closed with stars and missionsAchieved as separate fields", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:2026-08-03",
      type: "reporting.week.closed",
      occurredAt: "2026-08-09T03:00:00Z",
      producer: "tuni-noti",
      subject: baseSubject,
      data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.data).toMatchObject({ stars: 14, missionsAchieved: 3 });
    }
  });
});

describe("eventV1 — negative cases the consumer depends on (design.md §4.4)", () => {
  it("rejects an unrecognized event type", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "x:1",
      type: "learning.something.new",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: {},
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("rejects a non-1.x specVersion", () => {
    const out = eventV1({
      specVersion: "2.0",
      eventId: "chi_1:deleted",
      type: "identity.child.deleted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: {},
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
