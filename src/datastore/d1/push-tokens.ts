import type { Kysely } from "kysely";
import { uuidV7 } from "../../utils/uuid";
import type { Database } from "./schema";

/**
 * Upserts by `token` (globally unique, design.md §4.3/§4.7): a handset that
 * re-registers under a different parent is atomically reassigned, and a
 * disabled token that re-registers is re-enabled. `device_id` is only set on
 * the INSERT branch — the ON CONFLICT branch omits it, so a re-registering
 * token keeps its original opaque id, which `RETURNING device_id` then
 * reports correctly either way.
 */
export async function upsertPushToken(
  db: Kysely<Database>,
  params: { token: string; parentId: string; platform: string },
): Promise<{ deviceId: string }> {
  const candidateDeviceId = uuidV7();
  const now = new Date().toISOString();
  const row = await db
    .insertInto("push_tokens")
    .values({
      token: params.token,
      device_id: candidateDeviceId,
      parent_id: params.parentId,
      platform: params.platform,
      last_seen_at: now,
      disabled_at: null,
    })
    .onConflict((oc) =>
      oc.column("token").doUpdateSet({
        parent_id: params.parentId,
        platform: params.platform,
        last_seen_at: now,
        disabled_at: null,
      }),
    )
    .returning("device_id")
    .executeTakeFirstOrThrow();
  return { deviceId: row.device_id };
}

/**
 * Soft-deletes (stamps `disabled_at`) rather than removing the row — matches
 * the token-lifecycle convention already established for FCM-driven
 * disabling (design.md §4.6). Scoped to `parentId` so a caller can only
 * disable their own devices; returns false (never throws) for "not found or
 * not yours" so the route can 404 without leaking which case it was.
 */
export async function disablePushToken(
  db: Kysely<Database>,
  params: { deviceId: string; parentId: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .updateTable("push_tokens")
    .set({ disabled_at: now })
    .where("device_id", "=", params.deviceId)
    .where("parent_id", "=", params.parentId)
    .where("disabled_at", "is", null)
    .returning("token")
    .executeTakeFirst();
  return result !== undefined;
}
