import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { consumeBatch } from "../src/consumer/handler";
import { parseEnvelope } from "../src/consumer/parse";
import { planBatch } from "../src/consumer/plan";
import { getDb } from "../src/datastore/d1/schema";

const RECEIVED_AT = "2026-08-07T10:00:00.000Z";

function lesson(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: "1.0",
    eventId: "led_1:lesson_completed",
    type: "learning.lesson.completed",
    occurredAt: "2026-08-04T10:00:00Z",
    producer: "robo-worker",
    subject: { parentId: "c_par_1", childId: "c_chi_1", childName: "An" },
    data: { courseId: "co1", lessonId: "l1", outcome: "achieved", durationS: 300 },
    ...overrides,
  };
}

function weekClosed(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: "1.0",
    eventId: "c_chi_1:2026-08-03",
    type: "reporting.week.closed",
    occurredAt: "2026-08-09T03:00:00Z",
    producer: "tuni-noti",
    subject: { parentId: "c_par_1", childId: "c_chi_1", childName: "An" },
    data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
    ...overrides,
  };
}

describe("planBatch — coalescing membership (design.md §4.5 step 1)", () => {
  it("writes a child-scoped coalesce row for a learning event, keyed on child_id", () => {
    const stmts = planBatch([parseEnvelope(lesson())], RECEIVED_AT, new Set());
    const ce = stmts.find((s) => s.sql.includes("INTO coalesce_events"));
    expect(ce).toBeDefined();
    expect(ce?.sql).toMatch(/INSERT OR IGNORE/);
    expect(ce?.params).toContain("child");
    expect(ce?.params).toContain("c_chi_1"); // window_key
  });

  it("writes a parent-scoped coalesce row for reporting.week.closed, keyed on parent_id", () => {
    const stmts = planBatch([parseEnvelope(weekClosed())], RECEIVED_AT, new Set());
    const ce = stmts.find((s) => s.sql.includes("INTO coalesce_events"));
    expect(ce).toBeDefined();
    expect(ce?.params).toContain("parent");
    expect(ce?.params).toContain("c_par_1"); // window_key
  });

  it("uses the consumer-assigned receivedAt as arrived_at, never the event's occurredAt", () => {
    // design.md §4.5 step 2: arrived_at is what the flush orders and keys by.
    // occurredAt is ledger order, which is NOT stable under unordered queues.
    const stmts = planBatch([parseEnvelope(lesson())], RECEIVED_AT, new Set());
    const ce = stmts.find((s) => s.sql.includes("INTO coalesce_events"));
    expect(ce?.params).toContain(RECEIVED_AT);
    expect(ce?.params).not.toContain("2026-08-04T10:00:00Z");
  });

  it("skips the coalesce row and marks the inbox ignored for a tombstoned child", () => {
    const stmts = planBatch([parseEnvelope(lesson())], RECEIVED_AT, new Set(["c_chi_1"]));
    expect(stmts.some((s) => s.sql.includes("INTO coalesce_events"))).toBe(false);
    const inbox = stmts.find((s) => s.sql.includes("INTO inbox"));
    expect(inbox?.params).toContain("ignored");
  });

  it("still records the inbox row as processed for a live child", () => {
    const stmts = planBatch([parseEnvelope(lesson())], RECEIVED_AT, new Set(["someone_else"]));
    const inbox = stmts.find((s) => s.sql.includes("INTO inbox"));
    expect(inbox?.params).toContain("processed");
  });
});

describe("consumeBatch — coalescing against real D1", () => {
  it("appends one membership row per learning event", async () => {
    const db = getDb(env.NOTI_D1);
    await consumeBatch(env.NOTI_D1, [
      lesson({ eventId: "cd_1:lesson", subject: { parentId: "cd_par", childId: "cd_chi", childName: "An" } }),
      lesson({
        eventId: "cd_2:star",
        type: "learning.star.awarded",
        subject: { parentId: "cd_par", childId: "cd_chi", childName: "An" },
        data: { courseId: "co1", challengeId: "ch1", totalStars: 12 },
      }),
    ]);
    const rows = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "cd_chi").execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scope === "child")).toBe(true);
  });

  it("a replayed batch does not duplicate membership", async () => {
    const db = getDb(env.NOTI_D1);
    const event = lesson({
      eventId: "cd_replay:lesson",
      subject: { parentId: "cd_par2", childId: "cd_chi2", childName: "Bình" },
    });
    await consumeBatch(env.NOTI_D1, [event]);
    await consumeBatch(env.NOTI_D1, [event]);
    const rows = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "cd_chi2").execute();
    expect(rows).toHaveLength(1);
  });

  it("a late learning event for a tombstoned child writes no membership", async () => {
    const db = getDb(env.NOTI_D1);
    const subject = { parentId: "cd_par3", childId: "cd_chi3", childName: "Cường" };
    await consumeBatch(env.NOTI_D1, [
      {
        specVersion: "1.0",
        eventId: "cd_tomb:deleted",
        type: "identity.child.deleted",
        occurredAt: "2026-08-05T10:00:00Z",
        producer: "robo-worker",
        subject,
        data: {},
      },
    ]);
    await consumeBatch(env.NOTI_D1, [lesson({ eventId: "cd_tomb:late-lesson", subject })]);

    const rows = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "cd_chi3").execute();
    expect(rows).toHaveLength(0);
    const inbox = await db
      .selectFrom("inbox")
      .selectAll()
      .where("event_id", "=", "cd_tomb:late-lesson")
      .executeTakeFirstOrThrow();
    expect(inbox.state).toBe("ignored");
  });
});
