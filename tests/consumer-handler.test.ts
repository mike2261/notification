import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { consumeBatch } from "../src/consumer/handler";
import { getDb } from "../src/datastore/d1/schema";

function upserted(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: "1.0",
    eventId: "h_chi_1:upserted:2026-08-04T10:00:00Z",
    type: "identity.child.upserted",
    occurredAt: "2026-08-04T10:00:00Z",
    producer: "robo-worker",
    subject: { parentId: "h_par_1", childId: "h_chi_1", childName: "An" },
    data: { name: "An", age: 6, stage: "A1" },
    ...overrides,
  };
}

describe("consumeBatch — idempotency (design.md §4.4)", () => {
  it("records one inbox row and mirrors the child", async () => {
    await consumeBatch(env.NOTI_D1, [upserted()]);
    const db = getDb(env.NOTI_D1);
    const inbox = await db
      .selectFrom("inbox")
      .selectAll()
      .where("event_id", "=", "h_chi_1:upserted:2026-08-04T10:00:00Z")
      .executeTakeFirstOrThrow();
    expect(inbox.state).toBe("processed");
    const child = await db
      .selectFrom("children")
      .selectAll()
      .where("child_id", "=", "h_chi_1")
      .executeTakeFirstOrThrow();
    expect(child.name).toBe("An");
    expect(child.deleted_at).toBeNull();
  });

  it("re-running the same batch is a row-by-row no-op (crash replay)", async () => {
    const event = upserted({
      eventId: "h_replay:1",
      subject: { parentId: "h_par_2", childId: "h_chi_2", childName: "Bình" },
    });
    await consumeBatch(env.NOTI_D1, [event]);
    await consumeBatch(env.NOTI_D1, [event]);
    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("inbox").selectAll().where("event_id", "=", "h_replay:1").execute();
    expect(rows).toHaveLength(1);
  });

  it("concurrent duplicate delivery of one event yields one inbox row", async () => {
    const event = upserted({
      eventId: "h_concurrent:1",
      subject: { parentId: "h_par_3", childId: "h_chi_3", childName: "Cường" },
    });
    await Promise.all([consumeBatch(env.NOTI_D1, [event]), consumeBatch(env.NOTI_D1, [event])]);
    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("inbox").selectAll().where("event_id", "=", "h_concurrent:1").execute();
    expect(rows).toHaveLength(1);
  });

  it("an unknown type is recorded as ignored, never thrown", async () => {
    await expect(
      consumeBatch(env.NOTI_D1, [upserted({ eventId: "h_unknown:1", type: "learning.brand.new" })]),
    ).resolves.not.toThrow();
    const db = getDb(env.NOTI_D1);
    const row = await db
      .selectFrom("inbox")
      .selectAll()
      .where("event_id", "=", "h_unknown:1")
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("ignored");
  });

  it("an unknown major specVersion is recorded as ignored, never thrown", async () => {
    await expect(
      consumeBatch(env.NOTI_D1, [upserted({ eventId: "h_v2:1", specVersion: "2.0" })]),
    ).resolves.not.toThrow();
    const db = getDb(env.NOTI_D1);
    const row = await db.selectFrom("inbox").selectAll().where("event_id", "=", "h_v2:1").executeTakeFirstOrThrow();
    expect(row.state).toBe("ignored");
  });
});

describe("consumeBatch — identity mirror (design.md §4.8)", () => {
  it("a delayed OLDER rename cannot regress a newer name (LWW)", async () => {
    const subject = { parentId: "h_par_lww", childId: "h_chi_lww", childName: "Old" };
    // Newer event arrives first — queues are unordered, this is the normal case.
    await consumeBatch(env.NOTI_D1, [
      upserted({
        eventId: "h_lww:new",
        occurredAt: "2026-08-06T10:00:00Z",
        subject,
        data: { name: "NewName", age: 7, stage: "A2" },
      }),
    ]);
    await consumeBatch(env.NOTI_D1, [
      upserted({
        eventId: "h_lww:old",
        occurredAt: "2026-08-01T10:00:00Z",
        subject,
        data: { name: "OldName", age: 6, stage: "A1" },
      }),
    ]);
    const db = getDb(env.NOTI_D1);
    const child = await db
      .selectFrom("children")
      .selectAll()
      .where("child_id", "=", "h_chi_lww")
      .executeTakeFirstOrThrow();
    expect(child.name).toBe("NewName");
  });

  it("a late upsert does not resurrect a tombstoned child", async () => {
    const subject = { parentId: "h_par_tomb", childId: "h_chi_tomb", childName: "An" };
    await consumeBatch(env.NOTI_D1, [
      {
        specVersion: "1.0",
        eventId: "h_tomb:deleted",
        type: "identity.child.deleted",
        occurredAt: "2026-08-05T10:00:00Z",
        producer: "robo-worker",
        subject,
        data: {},
      },
    ]);
    await consumeBatch(env.NOTI_D1, [
      upserted({ eventId: "h_tomb:late-upsert", occurredAt: "2026-08-06T10:00:00Z", subject }),
    ]);
    const db = getDb(env.NOTI_D1);
    const child = await db
      .selectFrom("children")
      .selectAll()
      .where("child_id", "=", "h_chi_tomb")
      .executeTakeFirstOrThrow();
    expect(child.deleted_at).not.toBeNull();
  });

  it("deletion cancels pending notifications but leaves the parent's tokens intact", async () => {
    const db = getDb(env.NOTI_D1);
    const subject = { parentId: "h_par_cancel", childId: "h_chi_cancel", childName: "An" };
    await consumeBatch(env.NOTI_D1, [upserted({ eventId: "h_cancel:setup", subject })]);

    // Seed a token for the parent and a scheduled notification for the child.
    await db
      .insertInto("push_tokens")
      .values({
        token: "h_cancel_token",
        device_id: "h_cancel_device",
        parent_id: "h_par_cancel",
        platform: "android",
        last_seen_at: "2026-08-06T10:00:00Z",
        disabled_at: null,
      })
      .execute();
    await db
      .insertInto("notifications")
      .values({
        id: "h_cancel_noti",
        parent_id: "h_par_cancel",
        child_id: "h_chi_cancel",
        kind: "progress",
        title: "t",
        body: "b",
        data_json: "{}",
        scheduled_for: "2026-08-06T10:00:00Z",
        enqueued_at: null,
        state: "scheduled",
        dedupe_key: "h_cancel_dedupe",
      })
      .execute();

    await consumeBatch(env.NOTI_D1, [
      {
        specVersion: "1.0",
        eventId: "h_cancel:deleted",
        type: "identity.child.deleted",
        occurredAt: "2026-08-07T10:00:00Z",
        producer: "robo-worker",
        subject,
        data: {},
      },
    ]);

    const noti = await db
      .selectFrom("notifications")
      .selectAll()
      .where("id", "=", "h_cancel_noti")
      .executeTakeFirstOrThrow();
    expect(noti.state).toBe("canceled");

    // Tokens are parent-scoped and serve the parent's OTHER children
    // (design.md §4.8 rule 4) — deletion must not touch them.
    const token = await db
      .selectFrom("push_tokens")
      .selectAll()
      .where("token", "=", "h_cancel_token")
      .executeTakeFirstOrThrow();
    expect(token.disabled_at).toBeNull();
  });
});
