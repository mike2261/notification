import type { Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Lazily creates the `parents` row on first authenticated contact — mirrors
 * design.md §4.7's "lazily creates the parents row from sub" for the devices
 * route, but shared so preferences (which can be the FIRST call a client ever
 * makes) gets the same behavior.
 */
export async function ensureParent(db: Kysely<Database>, parentId: string): Promise<void> {
  await db
    .insertInto("parents")
    .values({ parent_id: parentId, timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" })
    .onConflict((oc) => oc.column("parent_id").doNothing())
    .execute();
}
