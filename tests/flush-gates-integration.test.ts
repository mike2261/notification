import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/datastore/d1/schema";
import { flushDueWindows, flushQuietEndCatchup } from "../src/flush/flush";

// 2026-08-07T15:00Z = 22:00 in Asia/Ho_Chi_Minh — inside a 21:00→07:00 window.
const NIGHT = new Date("2026-08-07T15:00:00Z");
// 2026-08-07T05:00Z = 12:00 local — outside it.
const NOON = new Date("2026-08-07T05:00:00Z");
const minutesBefore = (base: Date, n: number) => new Date(base.getTime() - n * 60_000).toISOString();

async function seedParent(params: {
  parentId: string;
  timezone?: string;
  quietStart?: string | null;
  quietEnd?: string | null;
  dailyCap?: number;
  progressEnabled?: boolean;
  weeklyEnabled?: boolean;
}) {
  const db = getDb(env.NOTI_D1);
  await db
    .insertInto("parents")
    .values({ parent_id: params.parentId, timezone: params.timezone ?? "Asia/Ho_Chi_Minh", locale: "vi-VN" })
    .onConflict((oc) => oc.column("parent_id").doNothing())
    .execute();
  await db
    .insertInto("preferences")
    .values({
      parent_id: params.parentId,
      progress_enabled: params.progressEnabled === false ? 0 : 1,
      weekly_enabled: params.weeklyEnabled === false ? 0 : 1,
      quiet_start: params.quietStart ?? null,
      quiet_end: params.quietEnd ?? null,
      daily_cap: params.dailyCap ?? 10,
    })
    .onConflict((oc) => oc.column("parent_id").doNothing())
    .execute();
}

async function seedMember(params: {
  eventId: string;
  windowKey: string;
  childId: string;
  parentId: string;
  scope?: "child" | "parent";
  kind?: string;
  arrivedAt: string;
}) {
  const db = getDb(env.NOTI_D1);
  await db
    .insertInto("coalesce_events")
    .values({
      event_id: params.eventId,
      window_key: params.windowKey,
      scope: params.scope ?? "child",
      child_id: params.childId,
      parent_id: params.parentId,
      kind: params.kind ?? "learning.lesson.completed",
      payload_json: JSON.stringify({
        subject: { parentId: params.parentId, childId: params.childId, childName: "An" },
        data: { lessons: 5, stars: 14, missionsAchieved: 3, weekStart: "2026-08-03", weekEnd: "2026-08-09" },
      }),
      arrived_at: params.arrivedAt,
    })
    .execute();
}

beforeEach(async () => {
  const db = getDb(env.NOTI_D1);
  await db.deleteFrom("coalesce_events").execute();
  await db.deleteFrom("notifications").execute();
  await db.deleteFrom("caps").execute();
});

describe("quiet hours (design.md §4.5 step 3)", () => {
  it("defers a notification landing inside the quiet window, with scheduled_for at quiet-end", async () => {
    await seedParent({ parentId: "g_par_quiet", quietStart: "21:00", quietEnd: "07:00" });
    await seedMember({
      eventId: "g_q1",
      windowKey: "g_chi_quiet",
      childId: "g_chi_quiet",
      parentId: "g_par_quiet",
      arrivedAt: minutesBefore(NIGHT, 15),
    });
    await flushDueWindows(env.NOTI_D1, NIGHT);

    const db = getDb(env.NOTI_D1);
    const row = await db
      .selectFrom("notifications")
      .selectAll()
      .where("parent_id", "=", "g_par_quiet")
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("deferred_quiet");
    expect(row.scheduled_for).toBe("2026-08-08T00:00:00.000Z"); // 07:00 local
  });

  it("folds a parent's deferred rows into ONE catch-up push and cancels the folded ones", async () => {
    await seedParent({ parentId: "g_par_fold", quietStart: "21:00", quietEnd: "07:00" });
    for (let i = 0; i < 3; i++) {
      await seedMember({
        eventId: `g_fold_${i}`,
        windowKey: `g_chi_fold_${i}`,
        childId: `g_chi_fold_${i}`,
        parentId: "g_par_fold",
        arrivedAt: minutesBefore(NIGHT, 15),
      });
    }
    await flushDueWindows(env.NOTI_D1, NIGHT);

    const db = getDb(env.NOTI_D1);
    expect(
      await db.selectFrom("notifications").selectAll().where("state", "=", "deferred_quiet").execute(),
    ).toHaveLength(3);

    // Quiet hours end at 07:00 local = 2026-08-08T00:00Z.
    const folded = await flushQuietEndCatchup(env.NOTI_D1, new Date("2026-08-08T00:01:00Z"));
    expect(folded).toBe(1);

    const catchups = await db.selectFrom("notifications").selectAll().where("kind", "=", "catchup").execute();
    expect(catchups).toHaveLength(1);
    expect(catchups[0].state).toBe("scheduled");
    expect(catchups[0].dedupe_key).toBe("g_par_fold:catchup:2026-08-08");

    // The folded rows must not also send individually.
    const stillDeferred = await db
      .selectFrom("notifications")
      .selectAll()
      .where("state", "=", "deferred_quiet")
      .execute();
    expect(stillDeferred).toHaveLength(0);
    expect(await db.selectFrom("notifications").selectAll().where("state", "=", "canceled").execute()).toHaveLength(3);
  });

  it("leaves rows deferred until their quiet-end actually arrives", async () => {
    await seedParent({ parentId: "g_par_early", quietStart: "21:00", quietEnd: "07:00" });
    await seedMember({
      eventId: "g_early",
      windowKey: "g_chi_early",
      childId: "g_chi_early",
      parentId: "g_par_early",
      arrivedAt: minutesBefore(NIGHT, 15),
    });
    await flushDueWindows(env.NOTI_D1, NIGHT);

    // Still inside quiet hours — nothing is due yet.
    expect(await flushQuietEndCatchup(env.NOTI_D1, new Date("2026-08-07T18:00:00Z"))).toBe(0);
  });
});

describe("daily cap (design.md §4.5 step 3)", () => {
  it("refuses a 3-notification parent with a 2-slot cap WHOLE, not partially", async () => {
    await seedParent({ parentId: "g_par_cap", dailyCap: 2 });
    for (let i = 0; i < 3; i++) {
      await seedMember({
        eventId: `g_cap_${i}`,
        windowKey: `g_chi_cap_${i}`,
        childId: `g_chi_cap_${i}`,
        parentId: "g_par_cap",
        arrivedAt: minutesBefore(NOON, 15),
      });
    }
    await flushDueWindows(env.NOTI_D1, NOON);

    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("notifications").selectAll().where("parent_id", "=", "g_par_cap").execute();
    expect(rows).toHaveLength(3);
    // All-or-nothing: which child gets through must not depend on scan order.
    expect(rows.every((r) => r.state === "suppressed_cap")).toBe(true);
  });

  it("lets a parent within their cap through and records the reservation", async () => {
    await seedParent({ parentId: "g_par_ok", dailyCap: 5 });
    await seedMember({
      eventId: "g_ok_1",
      windowKey: "g_chi_ok",
      childId: "g_chi_ok",
      parentId: "g_par_ok",
      arrivedAt: minutesBefore(NOON, 15),
    });
    await flushDueWindows(env.NOTI_D1, NOON);

    const db = getDb(env.NOTI_D1);
    const row = await db
      .selectFrom("notifications")
      .selectAll()
      .where("parent_id", "=", "g_par_ok")
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("scheduled");

    const cap = await db.selectFrom("caps").selectAll().where("parent_id", "=", "g_par_ok").executeTakeFirstOrThrow();
    expect(cap.sent_count).toBe(1);
    expect(cap.local_date).toBe("2026-08-07"); // parent-local, not UTC
  });

  it("snapshots daily_cap so a mid-day preference edit applies tomorrow, not retroactively", async () => {
    await seedParent({ parentId: "g_par_snap", dailyCap: 5 });
    await seedMember({
      eventId: "g_snap_1",
      windowKey: "g_chi_snap",
      childId: "g_chi_snap",
      parentId: "g_par_snap",
      arrivedAt: minutesBefore(NOON, 15),
    });
    await flushDueWindows(env.NOTI_D1, NOON);

    const db = getDb(env.NOTI_D1);
    // Parent lowers their cap to 1 mid-day. The already-reserved row stands.
    await db.updateTable("preferences").set({ daily_cap: 1 }).where("parent_id", "=", "g_par_snap").execute();

    const cap = await db.selectFrom("caps").selectAll().where("parent_id", "=", "g_par_snap").executeTakeFirstOrThrow();
    expect(cap.daily_cap).toBe(5); // snapshotted, not re-read
  });

  it("exempts weekly digests from the cap", async () => {
    await seedParent({ parentId: "g_par_weekly", dailyCap: 1 });
    // Burn the single slot on a progress push first.
    await seedMember({
      eventId: "g_wk_progress",
      windowKey: "g_chi_wk",
      childId: "g_chi_wk",
      parentId: "g_par_weekly",
      arrivedAt: minutesBefore(NOON, 15),
    });
    await flushDueWindows(env.NOTI_D1, NOON);

    await seedMember({
      eventId: "g_wk_digest",
      windowKey: "g_par_weekly",
      scope: "parent",
      kind: "reporting.week.closed",
      childId: "g_chi_wk",
      parentId: "g_par_weekly",
      arrivedAt: minutesBefore(NOON, 10),
    });
    await flushDueWindows(env.NOTI_D1, NOON);

    const db = getDb(env.NOTI_D1);
    const weekly = await db
      .selectFrom("notifications")
      .selectAll()
      .where("kind", "=", "weekly")
      .executeTakeFirstOrThrow();
    // One per week by construction — the cap must not touch it.
    expect(weekly.state).toBe("scheduled");
  });
});

describe("preference toggles", () => {
  it("cancels a progress push when the parent turned progress off", async () => {
    await seedParent({ parentId: "g_par_off", progressEnabled: false });
    await seedMember({
      eventId: "g_off_1",
      windowKey: "g_chi_off",
      childId: "g_chi_off",
      parentId: "g_par_off",
      arrivedAt: minutesBefore(NOON, 15),
    });
    await flushDueWindows(env.NOTI_D1, NOON);

    const db = getDb(env.NOTI_D1);
    const row = await db
      .selectFrom("notifications")
      .selectAll()
      .where("parent_id", "=", "g_par_off")
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("canceled");
    // Membership is still consumed — a disabled preference is not a reason to
    // re-scan the same window every tick forever.
    expect(await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "g_chi_off").execute()).toEqual(
      [],
    );
  });
});
