import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/datastore/d1/schema";
import { enqueueScheduled, type SendJob } from "../src/send/enqueue";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

type Sent = { body: SendJob };

function fakeQueue() {
  const sent: Sent[][] = [];
  return {
    queue: {
      send: async () => {},
      sendBatch: async (messages: Sent[]) => {
        sent.push(messages);
      },
    } as unknown as Queue,
    sent,
  };
}

async function seedNotification(params: { id: string; state: string; scheduledFor: string; parentId?: string }) {
  const db = getDb(env.NOTI_D1);
  await db
    .insertInto("notifications")
    .values({
      id: params.id,
      parent_id: params.parentId ?? "e_par",
      child_id: "e_chi",
      kind: "progress",
      title: "t",
      body: "b",
      data_json: "{}",
      scheduled_for: params.scheduledFor,
      enqueued_at: null,
      state: params.state as "scheduled",
      dedupe_key: `dk_${params.id}`,
    })
    .execute();
}

beforeEach(async () => {
  await getDb(env.NOTI_D1).deleteFrom("notifications").execute();
});

describe("enqueueScheduled (design.md §4.5 step 4)", () => {
  it("enqueues a due scheduled row and marks it enqueued with a timestamp", async () => {
    await seedNotification({ id: "e_1", state: "scheduled", scheduledFor: minutesAgo(1) });
    const { queue, sent } = fakeQueue();

    expect(await enqueueScheduled(env.NOTI_D1, queue, NOW)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0][0].body).toEqual({ notificationId: "e_1" });

    const row = await getDb(env.NOTI_D1)
      .selectFrom("notifications")
      .selectAll()
      .where("id", "=", "e_1")
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("enqueued");
    expect(row.enqueued_at).toBe(NOW.toISOString());
  });

  it("never enqueues a deferred_quiet row", async () => {
    // It is waiting for quiet-end; the catch-up fold owns it, not the queue.
    await seedNotification({ id: "e_deferred", state: "deferred_quiet", scheduledFor: minutesAgo(1) });
    const { queue, sent } = fakeQueue();
    expect(await enqueueScheduled(env.NOTI_D1, queue, NOW)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("never enqueues a suppressed row", async () => {
    await seedNotification({ id: "e_cap", state: "suppressed_cap", scheduledFor: minutesAgo(1) });
    const { queue } = fakeQueue();
    expect(await enqueueScheduled(env.NOTI_D1, queue, NOW)).toBe(0);
  });

  it("does not enqueue a row scheduled for the future", async () => {
    await seedNotification({
      id: "e_future",
      state: "scheduled",
      scheduledFor: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    const { queue } = fakeQueue();
    expect(await enqueueScheduled(env.NOTI_D1, queue, NOW)).toBe(0);
  });

  it("is idempotent — a second run finds nothing left in scheduled", async () => {
    await seedNotification({ id: "e_once", state: "scheduled", scheduledFor: minutesAgo(1) });
    const { queue } = fakeQueue();
    expect(await enqueueScheduled(env.NOTI_D1, queue, NOW)).toBe(1);
    expect(await enqueueScheduled(env.NOTI_D1, queue, NOW)).toBe(0);
  });
});

describe("enqueueScheduled — sweeper age floor", () => {
  it("skips a row younger than the floor", async () => {
    // The floor is REQUIRED: without it the sweeper races a flush that is
    // mid-tick and re-enqueues rows that were about to be sent normally.
    await seedNotification({ id: "e_young", state: "scheduled", scheduledFor: minutesAgo(5) });
    const { queue } = fakeQueue();
    expect(await enqueueScheduled(env.NOTI_D1, queue, NOW, { olderThanMs: 15 * 60_000 })).toBe(0);
  });

  it("re-enqueues a row older than the floor (a flush that crashed before sendBatch)", async () => {
    await seedNotification({ id: "e_stale", state: "scheduled", scheduledFor: minutesAgo(20) });
    const { queue, sent } = fakeQueue();
    expect(await enqueueScheduled(env.NOTI_D1, queue, NOW, { olderThanMs: 15 * 60_000 })).toBe(1);
    expect(sent[0][0].body).toEqual({ notificationId: "e_stale" });
  });
});
