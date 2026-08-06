// src/routes/parent.ts
//
// Parent API (design.md §4.7): device registration/deregistration and
// preferences. Mounted at /v1/me in src/fetch.ts. Every route requires a
// verified parent JWT (src/auth/parent-jwt.ts); requireParentAuth runs before
// any body validation, matching the auth-before-validate ordering already
// established for the skeleton push route in fetch.ts.

import { type } from "arktype";
import { Hono } from "hono";
import type { ParentAuthEnv, ParentAuthVariables } from "../auth/parent-jwt";
import { requireParentAuth } from "../auth/parent-jwt";
import { getPreferencesView, updatePreferences } from "../datastore/d1/preferences";
import { disablePushToken, upsertPushToken } from "../datastore/d1/push-tokens";
import { getDb } from "../datastore/d1/schema";
import { AppError } from "../hxxp/error";
import { validate } from "../hxxp/validator";

export type ParentApiEnv = Env & ParentAuthEnv;

export type ParentAppContext = {
  Bindings: ParentApiEnv;
  Variables: ParentAuthVariables;
};

const parentApp = new Hono<ParentAppContext>();

parentApp.use("*", requireParentAuth);

const registerDeviceBody = type({
  token: "string > 0",
  // v1 is Android-only (design.md §1.3) — the column exists for iOS later.
  platform: "'android'",
  // Accepted for contract parity with design.md §4.7's route table, but NOT
  // persisted: push_tokens (§4.3) has no app_version column. See the plan's
  // "Known schema gap" note.
  appVersion: "string > 0",
});

parentApp.post("/devices", validate("json", registerDeviceBody), async (c) => {
  const { token, platform } = c.req.valid("json");
  const db = getDb(c.env.NOTI_D1);
  const { deviceId } = await upsertPushToken(db, { token, parentId: c.get("parentId"), platform });
  return c.json({ deviceId });
});

parentApp.delete("/devices/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId");
  const db = getDb(c.env.NOTI_D1);
  const disabled = await disablePushToken(db, { deviceId, parentId: c.get("parentId") });
  if (!disabled) throw new AppError("NotExist", "device not found");
  return c.body(null, 204);
});

parentApp.get("/preferences", async (c) => {
  const db = getDb(c.env.NOTI_D1);
  const prefs = await getPreferencesView(db, c.get("parentId"));
  return c.json(prefs);
});

const QUIET_HOUR_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const patchPreferencesBody = type({
  "timezone?": "string > 0",
  "progressEnabled?": "boolean",
  "weeklyEnabled?": "boolean",
  "quietStart?": "string | null",
  "quietEnd?": "string | null",
  "dailyCap?": "number.integer > 0",
});

parentApp.patch("/preferences", validate("json", patchPreferencesBody), async (c) => {
  const patch = c.req.valid("json");

  for (const [field, value] of [
    ["quietStart", patch.quietStart],
    ["quietEnd", patch.quietEnd],
  ] as const) {
    if (value !== undefined && value !== null && !QUIET_HOUR_RE.test(value)) {
      throw new AppError("Validation", `${field} must be HH:MM 24h or null`);
    }
  }

  if (patch.timezone !== undefined) {
    try {
      // Intl throws RangeError for a string that isn't a real IANA zone —
      // the simplest correct validator available without a bundled tz list.
      new Intl.DateTimeFormat("en-US", { timeZone: patch.timezone });
    } catch {
      throw new AppError("Validation", `not a valid IANA timezone: ${patch.timezone}`);
    }
  }

  const db = getDb(c.env.NOTI_D1);
  const prefs = await updatePreferences(db, c.get("parentId"), patch);
  return c.json(prefs);
});

export { parentApp };
