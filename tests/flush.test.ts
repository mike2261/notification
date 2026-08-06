import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/datastore/d1/schema";
import { flushDueWindows } from "../src/flush/flush";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

async function seedMember(params: {
  eventId: string;
  windowKey: string;
  scope: "child" | "parent";
  childId: string;
  parentId: string;
  kind: string;
  arrivedAt: string;
}) {
  const db = getDb(env.NOTI_D1);
  await db
    .insertInto("coalesce_events")
    .values({
      event_id: params.eventId,
      window_key: params.windowKey,
      scope: params.scope,
      child_id: params.childId,
      parent_id: params.parentId,
      kind: params.kind,
      payload_json: JSON.stringify({
        subject: { parentId: params.parentId, childId: params.childId, childName: "An" },
        data: {
          courseId: "co1",
          lessonId: "l1",
          outcome: "achieved",
          durationS: 300,
          weekStart: "2026-08-03",
          weekEnd: "2026-08-09",
          lessons: 5,
          stars: 14,
          missionsAchieved: 3,
        },
      }),
      arrived_at: params.arrivedAt,
    })
    .execute();
}

beforeEach(async () => {
  const db = getDb(env.NOTI_D1);
  await db.deleteFrom("coalesce_events").execute();
  await db.deleteFrom("notifications").execute();
});

describe("flushDueWindows — coalescing (design.md §4.5)", () => {
  it("merges three events in one session into ONE notification", async () => {
    for (const [i, kind] of [
      "learning.lesson.completed",
      "learning.challenge.achieved",
      "learning.star.awarded",
    ].entries()) {
      await seedMember({
        eventId: `f_merge_${i}`,
        windowKey: "f_chi_1",
        scope: "child",
        childId: "f_chi_1",
        parentId: "f_par_1",
        kind,
        arrivedAt: minutesAgo(15),
      });
    }
    await flushDueWindows(env.NOTI_D1, NOW);

    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_1").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("scheduled");
    // Membership is consumed by the guarded delete.
    const left = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "f_chi_1").execute();
    expect(left).toHaveLength(0);
  });

  it("leaves a window that is not yet due", async () => {
    await seedMember({
      eventId: "f_fresh",
      windowKey: "f_chi_fresh",
      scope: "child",
      childId: "f_chi_fresh",
      parentId: "f_par_fresh",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(2), // newest < 10 min, oldest < 30 min
    });
    await flushDueWindows(env.NOTI_D1, NOW);
    const db = getDb(env.NOTI_D1);
    expect(await db.selectFrom("notifications").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("coalesce_events").selectAll().execute()).toHaveLength(1);
  });

  it("fires the 30-minute hard cap for a continuously active session", async () => {
    // Newest is only 2 min old, so the 10-min rule does NOT fire — but the
    // oldest is past the hard cap, which exists precisely so a busy session
    // cannot postpone its push indefinitely (§4.5 step 1).
    await seedMember({
      eventId: "f_cap_old",
      windowKey: "f_chi_cap",
      scope: "child",
      childId: "f_chi_cap",
      parentId: "f_par_cap",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(35),
    });
    await seedMember({
      eventId: "f_cap_new",
      windowKey: "f_chi_cap",
      scope: "child",
      childId: "f_chi_cap",
      parentId: "f_par_cap",
      kind: "learning.star.awarded",
      arrivedAt: minutesAgo(2),
    });
    await flushDueWindows(env.NOTI_D1, NOW);
    const db = getDb(env.NOTI_D1);
    expect(
      await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_cap").execute(),
    ).toHaveLength(1);
  });

  it("uses the shorter parent-scope window for weekly digests", async () => {
    // 5 min newest / 15 min oldest, vs the child scope's 10 / 30.
    await seedMember({
      eventId: "f_weekly",
      windowKey: "f_par_weekly",
      scope: "parent",
      childId: "f_chi_weekly",
      parentId: "f_par_weekly",
      kind: "reporting.week.closed",
      arrivedAt: minutesAgo(7),
    });
    await flushDueWindows(env.NOTI_D1, NOW);
    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_weekly").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("weekly");
  });
});

describe("flushDueWindows — concurrency (design.md §4.5 step 2)", () => {
  it("two overlapping ticks over the same due set produce exactly ONE notification", async () => {
    await seedMember({
      eventId: "f_race_1",
      windowKey: "f_chi_race",
      scope: "child",
      childId: "f_chi_race",
      parentId: "f_par_race",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(15),
    });
    await Promise.all([flushDueWindows(env.NOTI_D1, NOW), flushDueWindows(env.NOTI_D1, NOW)]);

    const db = getDb(env.NOTI_D1);
    // The loser's row hits the UNIQUE dedupe_key constraint and no-ops, so its
    // notification id never exists, so its half of the paired delete removes
    // nothing. No lease, no version column, no `flushing` state.
    const rows = await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_race").execute();
    expect(rows).toHaveLength(1);
  });

  it("stays at ONE notification when the last arrival carries the smallest ledger eventId", async () => {
    // The case a ledger-ordered dedupe_key gets wrong (§4.5 step 2, §7).
    await seedMember({
      eventId: "zzz_high_ledger",
      windowKey: "f_chi_ooo",
      scope: "child",
      childId: "f_chi_ooo",
      parentId: "f_par_ooo",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(20),
    });
    await seedMember({
      eventId: "aaa_low_ledger",
      windowKey: "f_chi_ooo",
      scope: "child",
      childId: "f_chi_ooo",
      parentId: "f_par_ooo",
      kind: "learning.star.awarded",
      arrivedAt: minutesAgo(12),
    });
    await Promise.all([flushDueWindows(env.NOTI_D1, NOW), flushDueWindows(env.NOTI_D1, NOW)]);

    const db = getDb(env.NOTI_D1);
    expect(
      await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_ooo").execute(),
    ).toHaveLength(1);
  });

  it("an event arriving mid-flush survives into the next window", async () => {
    await seedMember({
      eventId: "f_mid_1",
      windowKey: "f_chi_mid",
      scope: "child",
      childId: "f_chi_mid",
      parentId: "f_par_mid",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(15),
    });
    await flushDueWindows(env.NOTI_D1, NOW);

    // Arrives after the page was read — a new row not in the page, so the
    // guarded delete never touched it.
    await seedMember({
      eventId: "f_mid_2",
      windowKey: "f_chi_mid",
      scope: "child",
      childId: "f_chi_mid",
      parentId: "f_par_mid",
      kind: "learning.star.awarded",
      arrivedAt: minutesAgo(1),
    });

    const db = getDb(env.NOTI_D1);
    const left = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "f_chi_mid").execute();
    expect(left).toHaveLength(1);
    expect(left[0].event_id).toBe("f_mid_2");
  });
});

describe("flushDueWindows — query budget (design.md §5.1, §7 step 1b)", () => {
  it("issues a constant number of D1 queries regardless of how many windows are due", async () => {
    let count = 0;
    const counting = new Proxy(env.NOTI_D1, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            count++;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    for (let i = 0; i < 40; i++) {
      await seedMember({
        eventId: `f_budget_${i}`,
        windowKey: `f_chi_budget_${i}`,
        scope: "child",
        childId: `f_chi_budget_${i}`,
        parentId: `f_par_budget_${i}`,
        kind: "learning.lesson.completed",
        arrivedAt: minutesAgo(15),
      });
    }
    await flushDueWindows(counting, NOW);

    const db = getDb(env.NOTI_D1);
    expect(await db.selectFrom("notifications").selectAll().execute()).toHaveLength(40);
    // A per-window loop would be 4-6 queries EACH — ~200 here, and dead at
    // ~200 due children against D1's 1,000-query invocation budget (§5.1).
    // The set-based form is: due+membership, render context, and one batch of
    // two statements.
    expect(count).toBeLessThanOrEqual(6);
  });

  it("drains coalesce_events rather than growing tick over tick", async () => {
    for (let i = 0; i < 10; i++) {
      await seedMember({
        eventId: `f_drain_${i}`,
        windowKey: `f_chi_drain_${i}`,
        scope: "child",
        childId: `f_chi_drain_${i}`,
        parentId: `f_par_drain_${i}`,
        kind: "learning.lesson.completed",
        arrivedAt: minutesAgo(15),
      });
    }
    await flushDueWindows(env.NOTI_D1, NOW);
    const db = getDb(env.NOTI_D1);
    expect(await db.selectFrom("coalesce_events").selectAll().execute()).toHaveLength(0);
  });
});
