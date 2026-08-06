import type { Kysely } from "kysely";
import { ensureParent } from "./parents";
import type { Database } from "./schema";

export type PreferencesView = {
  timezone: string;
  progressEnabled: boolean;
  weeklyEnabled: boolean;
  quietStart: string | null;
  quietEnd: string | null;
  dailyCap: number;
};

export type PreferencesPatch = {
  timezone?: string;
  progressEnabled?: boolean;
  weeklyEnabled?: boolean;
  quietStart?: string | null;
  quietEnd?: string | null;
  dailyCap?: number;
};

async function ensurePreferencesRow(db: Kysely<Database>, parentId: string): Promise<void> {
  await ensureParent(db, parentId);
  await db
    .insertInto("preferences")
    .values({
      parent_id: parentId,
      progress_enabled: 1,
      weekly_enabled: 1,
      quiet_start: null,
      quiet_end: null,
      daily_cap: 10,
    })
    .onConflict((oc) => oc.column("parent_id").doNothing())
    .execute();
}

async function selectPreferencesView(db: Kysely<Database>, parentId: string): Promise<PreferencesView> {
  const row = await db
    .selectFrom("preferences")
    .innerJoin("parents", "parents.parent_id", "preferences.parent_id")
    .select([
      "parents.timezone as timezone",
      "preferences.progress_enabled as progress_enabled",
      "preferences.weekly_enabled as weekly_enabled",
      "preferences.quiet_start as quiet_start",
      "preferences.quiet_end as quiet_end",
      "preferences.daily_cap as daily_cap",
    ])
    .where("preferences.parent_id", "=", parentId)
    .executeTakeFirstOrThrow();

  return {
    timezone: row.timezone,
    progressEnabled: row.progress_enabled === 1,
    weeklyEnabled: row.weekly_enabled === 1,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    dailyCap: row.daily_cap,
  };
}

export async function getPreferencesView(db: Kysely<Database>, parentId: string): Promise<PreferencesView> {
  await ensurePreferencesRow(db, parentId);
  return selectPreferencesView(db, parentId);
}

export async function updatePreferences(
  db: Kysely<Database>,
  parentId: string,
  patch: PreferencesPatch,
): Promise<PreferencesView> {
  await ensurePreferencesRow(db, parentId);

  if (patch.timezone !== undefined) {
    await db.updateTable("parents").set({ timezone: patch.timezone }).where("parent_id", "=", parentId).execute();
  }

  const prefsSet: {
    progress_enabled?: number;
    weekly_enabled?: number;
    quiet_start?: string | null;
    quiet_end?: string | null;
    daily_cap?: number;
  } = {};
  if (patch.progressEnabled !== undefined) prefsSet.progress_enabled = patch.progressEnabled ? 1 : 0;
  if (patch.weeklyEnabled !== undefined) prefsSet.weekly_enabled = patch.weeklyEnabled ? 1 : 0;
  if (patch.quietStart !== undefined) prefsSet.quiet_start = patch.quietStart;
  if (patch.quietEnd !== undefined) prefsSet.quiet_end = patch.quietEnd;
  if (patch.dailyCap !== undefined) prefsSet.daily_cap = patch.dailyCap;

  if (Object.keys(prefsSet).length > 0) {
    await db.updateTable("preferences").set(prefsSet).where("parent_id", "=", parentId).execute();
  }

  return selectPreferencesView(db, parentId);
}
