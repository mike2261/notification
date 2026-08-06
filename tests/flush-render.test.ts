import { describe, expect, it } from "vitest";
import { dedupeKeyFor, renderWindow, type WindowMember } from "../src/flush/render";

function member(overrides: Partial<WindowMember> = {}): WindowMember {
  return {
    eventId: "led_1:lesson_completed",
    windowKey: "chi_1",
    scope: "child",
    childId: "chi_1",
    parentId: "par_1",
    kind: "learning.lesson.completed",
    payload: {
      subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
      data: { courseId: "co1", lessonId: "l1", outcome: "achieved", durationS: 300 },
    },
    arrivedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

const context = { childName: "An", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" };

describe("dedupeKeyFor (design.md §4.5 step 2)", () => {
  it("keys on the oldest member by arrived_at", () => {
    const key = dedupeKeyFor([
      member({ eventId: "b", arrivedAt: "2026-08-07T10:05:00.000Z" }),
      member({ eventId: "a", arrivedAt: "2026-08-07T10:00:00.000Z" }),
    ]);
    expect(key).toBe("chi_1:a");
  });

  it("breaks ties within one batch by event_id", () => {
    const same = "2026-08-07T10:00:00.000Z";
    const key = dedupeKeyFor([
      member({ eventId: "zzz", arrivedAt: same }),
      member({ eventId: "aaa", arrivedAt: same }),
    ]);
    expect(key).toBe("chi_1:aaa");
  });

  it("is STABLE when a late arrival carries a smaller ledger eventId", () => {
    // The case a ledger-ordered key gets wrong (design.md §4.5 step 2):
    // ledger UUIDv7s land out of order, so min(event_id) would LOWER the key
    // on a late arrival, two overlapping ticks would compute different keys,
    // both INSERTs would succeed, and the parent gets two pushes.
    const first = member({ eventId: "zzz_high_ledger_id", arrivedAt: "2026-08-07T10:00:00.000Z" });
    const lateButSmaller = member({ eventId: "aaa_low_ledger_id", arrivedAt: "2026-08-07T10:09:00.000Z" });
    expect(dedupeKeyFor([first])).toBe("chi_1:zzz_high_ledger_id");
    expect(dedupeKeyFor([first, lateButSmaller])).toBe("chi_1:zzz_high_ledger_id");
  });
});

describe("renderWindow", () => {
  it("renders one child-scope notification for three events in a session", () => {
    const out = renderWindow(
      [
        member({ eventId: "e1", kind: "learning.lesson.completed" }),
        member({ eventId: "e2", kind: "learning.challenge.achieved" }),
        member({ eventId: "e3", kind: "learning.star.awarded" }),
      ],
      context,
    );
    expect(out.kind).toBe("progress");
    expect(out.parentId).toBe("par_1");
    expect(out.childId).toBe("chi_1");
    expect(out.dedupeKey).toBe("chi_1:e1");
    expect(out.title).toContain("An");
    expect(out.body).toBeTruthy();
  });

  it("prefers the identity mirror's name over the envelope's denormalized one", () => {
    // The mirror is fresh and handles renames (design.md §4.8 rule 1).
    const out = renderWindow([member()], { ...context, childName: "An Nguyễn" });
    expect(out.title).toContain("An Nguyễn");
  });

  it("falls back to the envelope name when the mirror has no row yet", () => {
    // Queues are unordered: a learning event CAN arrive before any
    // identity.child.upserted. An event is never unrenderable (§4.8 rule 1).
    const out = renderWindow([member()], { ...context, childName: null });
    expect(out.title).toContain("An");
  });

  it("renders a parent-scope weekly digest keyed on parentId", () => {
    const out = renderWindow(
      [
        member({
          eventId: "w1",
          windowKey: "par_1",
          scope: "parent",
          kind: "reporting.week.closed",
          payload: {
            subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
            data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
          },
        }),
      ],
      context,
    );
    expect(out.kind).toBe("weekly");
    expect(out.parentId).toBe("par_1");
    // A parent-scope digest is not about one child — §4.5 step 5.
    expect(out.childId).toBeNull();
  });

  it("folds a multi-child parent's weekly events into ONE digest", () => {
    // design.md §4.5 step 5: three children must not mean three pushes.
    const out = renderWindow(
      [
        member({
          eventId: "w1",
          windowKey: "par_1",
          scope: "parent",
          childId: "chi_1",
          kind: "reporting.week.closed",
          payload: {
            subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
            data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
          },
        }),
        member({
          eventId: "w2",
          windowKey: "par_1",
          scope: "parent",
          childId: "chi_2",
          kind: "reporting.week.closed",
          payload: {
            subject: { parentId: "par_1", childId: "chi_2", childName: "Bình" },
            data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 3, stars: 6, missionsAchieved: 2 },
          },
        }),
      ],
      context,
    );
    expect(out.dedupeKey).toBe("par_1:w1");
    // Both children's totals are in one body — the sum is what a parent sees.
    expect(out.body).toMatch(/8/); // 5 + 3 lessons
  });

  it("reports stars and missions as separate numbers", () => {
    // They are NOT derivable from each other (design.md §3.4).
    const out = renderWindow(
      [
        member({
          eventId: "w1",
          windowKey: "par_1",
          scope: "parent",
          kind: "reporting.week.closed",
          payload: {
            subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
            data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
          },
        }),
      ],
      context,
    );
    const data = JSON.parse(out.dataJson);
    expect(data.stars).toBe(14);
    expect(data.missionsAchieved).toBe(3);
  });
});
