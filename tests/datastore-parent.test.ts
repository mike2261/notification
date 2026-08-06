import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ensureParent } from "../src/datastore/d1/parents";
import { getPreferencesView, updatePreferences } from "../src/datastore/d1/preferences";
import { disablePushToken, upsertPushToken } from "../src/datastore/d1/push-tokens";
import { getDb } from "../src/datastore/d1/schema";

describe("ensureParent", () => {
  it("creates a parent row with defaults, idempotently", async () => {
    const db = getDb(env.NOTI_D1);
    await ensureParent(db, "par_ensure_1");
    await ensureParent(db, "par_ensure_1"); // second call must not throw or duplicate
    const row = await db
      .selectFrom("parents")
      .selectAll()
      .where("parent_id", "=", "par_ensure_1")
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ parent_id: "par_ensure_1", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" });
  });
});

describe("upsertPushToken / disablePushToken", () => {
  it("mints a fresh deviceId on first registration", async () => {
    const db = getDb(env.NOTI_D1);
    const { deviceId } = await upsertPushToken(db, {
      token: "tok_a",
      parentId: "par_push_1",
      platform: "android",
    });
    expect(deviceId).toBeTruthy();
    const row = await db.selectFrom("push_tokens").selectAll().where("token", "=", "tok_a").executeTakeFirstOrThrow();
    expect(row.device_id).toBe(deviceId);
    expect(row.parent_id).toBe("par_push_1");
    expect(row.disabled_at).toBeNull();
  });

  it("preserves the existing deviceId when the same token re-registers", async () => {
    const db = getDb(env.NOTI_D1);
    const first = await upsertPushToken(db, { token: "tok_b", parentId: "par_push_2", platform: "android" });
    const second = await upsertPushToken(db, { token: "tok_b", parentId: "par_push_2", platform: "android" });
    expect(second.deviceId).toBe(first.deviceId);
  });

  it("atomically reassigns a token to a new parent on re-registration (design.md §4.7)", async () => {
    const db = getDb(env.NOTI_D1);
    await upsertPushToken(db, { token: "tok_c", parentId: "par_push_old", platform: "android" });
    await upsertPushToken(db, { token: "tok_c", parentId: "par_push_new", platform: "android" });
    const row = await db.selectFrom("push_tokens").selectAll().where("token", "=", "tok_c").executeTakeFirstOrThrow();
    expect(row.parent_id).toBe("par_push_new");
  });

  it("re-registering a disabled token clears disabled_at", async () => {
    const db = getDb(env.NOTI_D1);
    const { deviceId } = await upsertPushToken(db, { token: "tok_d", parentId: "par_push_3", platform: "android" });
    const disabled = await disablePushToken(db, { deviceId, parentId: "par_push_3" });
    expect(disabled).toBe(true);
    let row = await db.selectFrom("push_tokens").selectAll().where("token", "=", "tok_d").executeTakeFirstOrThrow();
    expect(row.disabled_at).not.toBeNull();

    await upsertPushToken(db, { token: "tok_d", parentId: "par_push_3", platform: "android" });
    row = await db.selectFrom("push_tokens").selectAll().where("token", "=", "tok_d").executeTakeFirstOrThrow();
    expect(row.disabled_at).toBeNull();
  });

  it("disablePushToken returns false for a deviceId owned by a different parent", async () => {
    const db = getDb(env.NOTI_D1);
    const { deviceId } = await upsertPushToken(db, { token: "tok_e", parentId: "par_push_owner", platform: "android" });
    const disabled = await disablePushToken(db, { deviceId, parentId: "par_push_intruder" });
    expect(disabled).toBe(false);
    const row = await db.selectFrom("push_tokens").selectAll().where("token", "=", "tok_e").executeTakeFirstOrThrow();
    expect(row.disabled_at).toBeNull(); // untouched
  });

  it("disablePushToken returns false for an unknown deviceId", async () => {
    const db = getDb(env.NOTI_D1);
    const disabled = await disablePushToken(db, { deviceId: "does-not-exist", parentId: "par_push_owner" });
    expect(disabled).toBe(false);
  });
});

describe("getPreferencesView / updatePreferences", () => {
  it("lazily creates a preferences row with schema defaults on first read", async () => {
    const db = getDb(env.NOTI_D1);
    const prefs = await getPreferencesView(db, "par_prefs_1");
    expect(prefs).toEqual({
      timezone: "Asia/Ho_Chi_Minh",
      progressEnabled: true,
      weeklyEnabled: true,
      quietStart: null,
      quietEnd: null,
      dailyCap: 10,
    });
  });

  it("is idempotent — a second read does not reset anything", async () => {
    const db = getDb(env.NOTI_D1);
    await getPreferencesView(db, "par_prefs_2");
    await updatePreferences(db, "par_prefs_2", { dailyCap: 3 });
    const prefs = await getPreferencesView(db, "par_prefs_2");
    expect(prefs.dailyCap).toBe(3);
  });

  it("updates only the provided fields", async () => {
    const db = getDb(env.NOTI_D1);
    await getPreferencesView(db, "par_prefs_3");
    const updated = await updatePreferences(db, "par_prefs_3", { progressEnabled: false });
    expect(updated).toEqual({
      timezone: "Asia/Ho_Chi_Minh",
      progressEnabled: false,
      weeklyEnabled: true,
      quietStart: null,
      quietEnd: null,
      dailyCap: 10,
    });
  });

  it("sets and clears quiet hours", async () => {
    const db = getDb(env.NOTI_D1);
    await updatePreferences(db, "par_prefs_4", { quietStart: "21:00", quietEnd: "07:00" });
    let prefs = await getPreferencesView(db, "par_prefs_4");
    expect(prefs.quietStart).toBe("21:00");
    expect(prefs.quietEnd).toBe("07:00");

    await updatePreferences(db, "par_prefs_4", { quietStart: null, quietEnd: null });
    prefs = await getPreferencesView(db, "par_prefs_4");
    expect(prefs.quietStart).toBeNull();
    expect(prefs.quietEnd).toBeNull();
  });

  it("updates timezone on the parents row, not preferences", async () => {
    const db = getDb(env.NOTI_D1);
    await updatePreferences(db, "par_prefs_5", { timezone: "Asia/Bangkok" });
    const parentRow = await db
      .selectFrom("parents")
      .selectAll()
      .where("parent_id", "=", "par_prefs_5")
      .executeTakeFirstOrThrow();
    expect(parentRow.timezone).toBe("Asia/Bangkok");
  });
});
