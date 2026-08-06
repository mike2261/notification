# Parent API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement tuni-noti's Parent API (`docs/design.md` §4.7) — device registration/deregistration and
preferences CRUD, authenticated via ES256 JWT verified against robo-worker's JWKS (`docs/design.md` §1.4).

**Architecture:** A standalone `verifyParentJwt()` (JWKS fetch with module-level cache, unknown-`kid` triggers
exactly one refetch, strict `alg`/`iss`/`aud` pinning — no algorithm negotiation) backs a Hono middleware
`requireParentAuth`. Datastore access goes through a shared Kysely `Database` type (`src/datastore/d1/schema.ts`)
and small per-table modules, mirroring the vendored-dialect pattern already in place. Routes live in
`src/routes/parent.ts`, a Hono sub-app mounted at `/v1/me` in `src/fetch.ts` — kept separate from the
walking-skeleton routes already in `fetch.ts` so that file doesn't grow unbounded.

**Tech Stack:** Hono ^4.12, arktype ^2.2, Kysely ^0.28 (existing vendored D1 dialect), Web Crypto (ES256
verify, no JWT library — matches the hand-rolled convention already used by `src/auth/wif.ts`).

**Scope note:** this plan implements tuni-noti's own JWT verification code against robo-worker's documented
contract (ES256, `aud: "robo-worker/parent"`, JWKS at a URL robo-worker serves). It does **not** touch
robo-worker (`docs/design.md` §6 step 3, a different repository) — tests stub the JWKS endpoint, and
`wrangler.jsonc`'s production `PARENT_JWKS_URL`/`PARENT_JWT_ISSUER` are placeholders to fill in once
robo-worker's migration (§1.4) actually ships its JWKS endpoint, matching how `WIF_ISSUER` etc. were already
handled as "FILL IN AFTER..." placeholders in this same file.

**Known schema gap, called out rather than silently worked around:** `docs/design.md` §4.7's route table
lists the `POST /v1/me/devices` request body as `{token, platform, appVersion}`, but the `push_tokens` table
(§4.3, already migrated) has no `app_version` column. This plan accepts and validates `appVersion` (so the
API contract matches the doc) but does not persist it — there is nowhere to put it without a new migration,
which is out of scope here. If app-version tracking turns out to matter, that's a follow-up migration, not a
silent schema violation to sneak into this plan.

---

## Before you start

```sh
cd /home/ducmai/work/tuni-noti
pnpm test        # 41 passed
pnpm type-check   # clean
git log --oneline -1   # c038943 docs(events): publish the v1 event contract (design.md §2)
```

If any of those differ, stop and reconcile before starting.

---

## Task 1: Kysely DB schema + parents/push-tokens/preferences datastore modules

**Files:**
- Create: `src/datastore/d1/schema.ts`
- Create: `src/datastore/d1/parents.ts`
- Create: `src/datastore/d1/push-tokens.ts`
- Create: `src/datastore/d1/preferences.ts`
- Test: `tests/datastore-parent.test.ts`

- [ ] **Step 1: Write the shared Kysely `Database` type + `getDb()` helper**

`tests/kysely-d1.test.ts` (already landed) declares its own tiny inline `DB` type. This task introduces the
real, full one, covering all 9 tables from `migrations/0001_init.sql` — everything this plan and future
consumer/producer work will import instead of redeclaring.

```ts
// src/datastore/d1/schema.ts
import { Kysely } from "kysely";
import { D1Dialect } from "./kysely-d1";

export interface Database {
  inbox: InboxTable;
  parents: ParentsTable;
  children: ChildrenTable;
  push_tokens: PushTokensTable;
  preferences: PreferencesTable;
  coalesce_events: CoalesceEventsTable;
  notifications: NotificationsTable;
  deliveries: DeliveriesTable;
  caps: CapsTable;
}

export interface InboxTable {
  event_id: string;
  type: string;
  state: "processed" | "ignored";
  payload_json: string;
  received_at: string;
}

export interface ParentsTable {
  parent_id: string;
  timezone: string;
  locale: string;
}

export interface ChildrenTable {
  child_id: string;
  parent_id: string;
  name: string;
  identity_updated_at: string;
  deleted_at: string | null;
}

export interface PushTokensTable {
  token: string;
  device_id: string;
  parent_id: string;
  platform: string;
  last_seen_at: string;
  disabled_at: string | null;
}

export interface PreferencesTable {
  parent_id: string;
  progress_enabled: number; // 0 | 1 — D1 has no native boolean
  weekly_enabled: number;
  quiet_start: string | null;
  quiet_end: string | null;
  daily_cap: number;
}

export interface CoalesceEventsTable {
  event_id: string;
  window_key: string;
  scope: "child" | "parent";
  child_id: string | null;
  parent_id: string;
  kind: string;
  payload_json: string;
  arrived_at: string;
}

export interface NotificationsTable {
  id: string;
  parent_id: string;
  child_id: string | null;
  kind: string;
  title: string;
  body: string;
  data_json: string;
  scheduled_for: string;
  enqueued_at: string | null;
  state:
    | "scheduled"
    | "enqueued"
    | "done"
    | "deferred_quiet"
    | "suppressed_cap"
    | "suppressed_dark"
    | "canceled";
  dedupe_key: string;
}

export interface DeliveriesTable {
  notification_id: string;
  token: string;
  state: "pending" | "accepted" | "failed" | "canceled";
  attempts: number;
  fcm_message_name: string | null;
}

export interface CapsTable {
  parent_id: string;
  local_date: string;
  daily_cap: number;
  sent_count: number;
}

export function getDb(d1: D1Database): Kysely<Database> {
  return new Kysely<Database>({ dialect: new D1Dialect({ database: d1 }) });
}
```

- [ ] **Step 2: Write `ensureParent` — the lazy parent-row creation shared by devices + preferences routes**

```ts
// src/datastore/d1/parents.ts
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
```

- [ ] **Step 3: Write the failing tests for `ensureParent` and `upsertPushToken`/`disablePushToken`**

```ts
// tests/datastore-parent.test.ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ensureParent } from "../src/datastore/d1/parents";
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
```

- [ ] **Step 4: Run it — expect failure**

```sh
pnpm test tests/datastore-parent.test.ts
```

Expected: FAIL — `../src/datastore/d1/push-tokens` does not exist yet.

- [ ] **Step 5: Write `push-tokens.ts`**

```ts
// src/datastore/d1/push-tokens.ts
import type { Kysely } from "kysely";
import type { Database } from "./schema";
import { uuidV7 } from "../../utils/uuid";

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
```

- [ ] **Step 6: Run it — expect pass**

```sh
pnpm test tests/datastore-parent.test.ts
```

Expected: PASS, all 8 tests.

- [ ] **Step 7: Write the failing tests for `preferences.ts`**

Append to `tests/datastore-parent.test.ts`:

```ts
import { getPreferencesView, updatePreferences } from "../src/datastore/d1/preferences";

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
```

- [ ] **Step 8: Run it — expect failure**

```sh
pnpm test tests/datastore-parent.test.ts
```

Expected: FAIL — `../src/datastore/d1/preferences` does not exist yet.

- [ ] **Step 9: Write `preferences.ts`**

```ts
// src/datastore/d1/preferences.ts
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

  const prefsSet: { progress_enabled?: number; weekly_enabled?: number; quiet_start?: string | null; quiet_end?: string | null; daily_cap?: number } = {};
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
```

- [ ] **Step 10: Run the full suite and type-check**

```sh
pnpm test
pnpm type-check
```

Expected: all previously-passing tests still pass, plus 13 new ones in `tests/datastore-parent.test.ts` (54 total).

- [ ] **Step 11: Commit**

```sh
git add src/datastore/d1/schema.ts src/datastore/d1/parents.ts src/datastore/d1/push-tokens.ts \
  src/datastore/d1/preferences.ts tests/datastore-parent.test.ts
git commit -m "feat(parent-api): Kysely schema + parents/push-tokens/preferences datastore (design.md §4.3, §4.7)"
```

---

## Task 2: Parent JWT verification (ES256 via JWKS)

**Files:**
- Create: `src/auth/parent-jwt.ts`
- Test: `tests/parent-jwt.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/parent-jwt.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { b64url, jsonBytes } from "../src/auth/jwt";
import { __resetParentJwksCache, verifyParentJwt } from "../src/auth/parent-jwt";

const ENV = {
  PARENT_JWKS_URL: "https://robo-worker.test/auth/jwks",
  PARENT_JWT_ISSUER: "https://robo-worker.test",
  PARENT_JWT_AUDIENCE: "robo-worker/parent",
};

async function makeKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function jwkFromPublicKey(publicKey: CryptoKey, kid: string) {
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey & { x: string; y: string };
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" };
}

async function signJwt(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", kid };
  const signingInput = `${b64url(jsonBytes(header))}.${b64url(jsonBytes(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

function stubJwks(keys: unknown[]) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === ENV.PARENT_JWKS_URL) return new Response(JSON.stringify({ keys }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("verifyParentJwt", () => {
  beforeEach(() => {
    __resetParentJwksCache();
  });

  it("accepts a validly signed, current token", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k1", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    });
    const result = await verifyParentJwt(ENV, jwt);
    expect(result).toEqual({ parentId: "par_1" });
  });

  it("refetches the JWKS once on an unknown kid, then verifies", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k2");
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls++;
      if (url !== ENV.PARENT_JWKS_URL) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify({ keys: calls === 1 ? [] : [jwk] }), { status: 200 });
    });
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k2", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    });
    const result = await verifyParentJwt(ENV, jwt);
    expect(result).toEqual({ parentId: "par_1" });
    expect(calls).toBe(2);
  });

  it("rejects a token signed by a key not in the JWKS", async () => {
    const pair = await makeKeyPair();
    const otherPair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    // Signed by otherPair but claims kid "k1" — the JWKS holds pair's key, so
    // verification against the wrong public key must fail.
    const jwt = await signJwt(otherPair.privateKey, "k1", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    });
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/bad signature/);
  });

  it("rejects an expired token", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k1", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now - 7200,
      exp: now - 3600,
    });
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/expired/);
  });

  it("rejects a wrong audience", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k1", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: "someone-else/parent",
      iat: now,
      exp: now + 3600,
    });
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/aud mismatch/);
  });

  it("rejects a wrong issuer", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k1", {
      sub: "par_1",
      iss: "https://evil.test",
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    });
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/iss mismatch/);
  });

  it("rejects a non-ES256 alg without attempting verification (no algorithm negotiation)", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "none", typ: "JWT", kid: "k1" };
    const payload = {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    };
    // Dummy non-empty signature segment so parseJwt's shape check passes and
    // execution reaches the alg check — this test is about alg, not shape.
    const jwt = `${b64url(jsonBytes(header))}.${b64url(jsonBytes(payload))}.AA`;
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/unsupported alg/);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/parent-jwt.test.ts
```

Expected: FAIL — `../src/auth/parent-jwt` does not exist.

- [ ] **Step 3: Write `src/auth/parent-jwt.ts`**

```ts
// src/auth/parent-jwt.ts
//
// Verifies robo-worker's parent-session JWT (design.md §1.4, §4.7): ES256,
// aud "robo-worker/parent", verified against a cached JWKS fetch. tuni-noti
// never holds a signing key for this — it only verifies.
//
// Deliberately hand-rolled (no JWT library), matching the convention already
// established by src/auth/wif.ts for the WIF signing side.

import { extractBearer } from "../hxxp/bearer";
import { AppError } from "../hxxp/error";
import { parseJwt } from "./jwt";
import type { MiddlewareHandler } from "hono";

export type ParentAuthEnv = {
  PARENT_JWKS_URL: string;
  PARENT_JWT_ISSUER: string;
  PARENT_JWT_AUDIENCE: string;
};

type Jwk = { kty: string; crv: string; x: string; y: string; kid: string };

let jwksCache: Jwk[] | null = null;
let jwksInflight: Promise<Jwk[]> | null = null;

async function fetchJwks(env: ParentAuthEnv): Promise<Jwk[]> {
  const resp = await fetch(env.PARENT_JWKS_URL);
  if (!resp.ok) throw new Error(`parent-jwt: JWKS fetch failed ${resp.status}`);
  const body = (await resp.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("parent-jwt: JWKS response missing keys[]");
  return body.keys;
}

async function getJwks(env: ParentAuthEnv, forceRefresh: boolean): Promise<Jwk[]> {
  if (jwksCache && !forceRefresh) return jwksCache;
  if (!jwksInflight) {
    jwksInflight = fetchJwks(env).finally(() => {
      jwksInflight = null;
    });
  }
  const keys = await jwksInflight;
  jwksCache = keys;
  return keys;
}

async function findKey(env: ParentAuthEnv, kid: string): Promise<Jwk> {
  let keys = await getJwks(env, false);
  let key = keys.find((k) => k.kid === kid);
  if (!key) {
    // Unknown kid → exactly one refetch (design.md §1.4 step 5), not a retry
    // loop — a kid that's still unknown after a fresh fetch is not ours.
    keys = await getJwks(env, true);
    key = keys.find((k) => k.kid === kid);
  }
  if (!key) throw new Error(`parent-jwt: unknown kid ${kid}`);
  return key;
}

/** Test seam: drop the cached JWKS so a suite can re-exercise the fetch. */
export function __resetParentJwksCache(): void {
  jwksCache = null;
  jwksInflight = null;
}

export async function verifyParentJwt(env: ParentAuthEnv, token: string): Promise<{ parentId: string }> {
  const parsed = parseJwt(token);

  // Strict alg pinning — no algorithm negotiation (design.md §1.4 step 5).
  // Checked BEFORE any key lookup or verify call so a token asserting "none"
  // or an unexpected alg is rejected without ever touching the JWKS.
  if (parsed.header.alg !== "ES256") {
    throw new Error("parent-jwt: unsupported alg");
  }

  const kid = parsed.header.kid;
  if (typeof kid !== "string" || !kid) {
    throw new Error("parent-jwt: missing kid");
  }

  const jwk = await findKey(env, kid);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    parsed.signature,
    new TextEncoder().encode(parsed.signingInput),
  );
  if (!valid) throw new Error("parent-jwt: bad signature");

  const payload = parsed.payload;
  if (payload.iss !== env.PARENT_JWT_ISSUER) throw new Error("parent-jwt: iss mismatch");
  if (payload.aud !== env.PARENT_JWT_AUDIENCE) throw new Error("parent-jwt: aud mismatch");

  const exp = payload.exp;
  const now = Math.floor(Date.now() / 1000);
  if (typeof exp !== "number" || exp <= now) throw new Error("parent-jwt: expired");

  const sub = payload.sub;
  if (typeof sub !== "string" || !sub) throw new Error("parent-jwt: missing sub");

  return { parentId: sub };
}

export type ParentAuthVariables = { parentId: string };

/**
 * Hono middleware: extracts the bearer token, verifies it, and sets
 * `parentId` in context. Any failure — missing header, bad signature, wrong
 * aud/iss, expired, unsupported alg — becomes a 401 (AppError "Authn"), never
 * a distinguishable error to the caller (design.md §1.4: never leak which
 * check failed to an unauthenticated caller beyond "not authenticated").
 */
export const requireParentAuth: MiddlewareHandler<{
  Bindings: ParentAuthEnv;
  Variables: ParentAuthVariables;
}> = async (c, next) => {
  let token: string;
  try {
    token = extractBearer(c.req.header("Authorization"));
  } catch (err) {
    throw new AppError("Authn", (err as Error).message);
  }
  try {
    const { parentId } = await verifyParentJwt(c.env, token);
    c.set("parentId", parentId);
  } catch (err) {
    throw new AppError("Authn", (err as Error).message);
  }
  await next();
};
```

- [ ] **Step 4: Run it — expect pass**

```sh
pnpm test tests/parent-jwt.test.ts
```

Expected: PASS, all 7 tests.

- [ ] **Step 5: Run the full suite and type-check**

```sh
pnpm test
pnpm type-check
```

Expected: all green (61 total: 54 from Task 1 + 7 new).

- [ ] **Step 6: Commit**

```sh
git add src/auth/parent-jwt.ts tests/parent-jwt.test.ts
git commit -m "feat(parent-api): ES256 parent JWT verification via JWKS (design.md §1.4)"
```

---

## Task 3: Parent API routes — devices + preferences

**Files:**
- Create: `src/routes/parent.ts`
- Modify: `src/fetch.ts` (mount at `/v1/me`)
- Test: `tests/parent-routes.test.ts`

- [ ] **Step 1: Write the failing route tests**

```ts
// tests/parent-routes.test.ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { b64url, jsonBytes } from "../src/auth/jwt";
import { __resetParentJwksCache } from "../src/auth/parent-jwt";

async function makeKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function jwkFromPublicKey(publicKey: CryptoKey, kid: string) {
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey & { x: string; y: string };
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" };
}

async function signJwt(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", kid };
  const signingInput = `${b64url(jsonBytes(header))}.${b64url(jsonBytes(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

let keyPair: CryptoKeyPair;

async function tokenFor(parentId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(keyPair.privateKey, "route-test-key", {
    sub: parentId,
    iss: env.PARENT_JWT_ISSUER,
    aud: env.PARENT_JWT_AUDIENCE,
    iat: now,
    exp: now + 3600,
  });
}

beforeEach(async () => {
  __resetParentJwksCache();
  keyPair = await makeKeyPair();
  const jwk = await jwkFromPublicKey(keyPair.publicKey, "route-test-key");
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === env.PARENT_JWKS_URL) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    throw new Error(`unexpected fetch in route test: ${url}`);
  });
});

describe("POST /v1/me/devices", () => {
  it("401s with no Authorization header", async () => {
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "t1", platform: "android", appVersion: "1.0.0" }),
    });
    expect(res.status).toBe(401);
  });

  it("registers a device and returns an opaque deviceId", async () => {
    const jwt = await tokenFor("par_route_1");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ token: "route-tok-1", platform: "android", appVersion: "1.0.0" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: string };
    expect(body.deviceId).toBeTruthy();
  });

  it("422s a malformed body", async () => {
    const jwt = await tokenFor("par_route_1");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ token: "", platform: "android", appVersion: "1.0.0" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("DELETE /v1/me/devices/:deviceId", () => {
  it("404s an unknown deviceId", async () => {
    const jwt = await tokenFor("par_route_2");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/devices/does-not-exist", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
  });

  it("204s and disables an owned device", async () => {
    const jwt = await tokenFor("par_route_3");
    const reg = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ token: "route-tok-3", platform: "android", appVersion: "1.0.0" }),
    });
    const { deviceId } = (await reg.json()) as { deviceId: string };

    const res = await SELF.fetch(`https://tuni-noti.test/v1/me/devices/${deviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(204);
  });

  it("404s a device owned by a different parent", async () => {
    const jwtOwner = await tokenFor("par_route_owner");
    const reg = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtOwner}` },
      body: JSON.stringify({ token: "route-tok-owner", platform: "android", appVersion: "1.0.0" }),
    });
    const { deviceId } = (await reg.json()) as { deviceId: string };

    const jwtIntruder = await tokenFor("par_route_intruder");
    const res = await SELF.fetch(`https://tuni-noti.test/v1/me/devices/${deviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtIntruder}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET/PATCH /v1/me/preferences", () => {
  it("401s with no Authorization header", async () => {
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/preferences");
    expect(res.status).toBe(401);
  });

  it("GET returns defaults on first contact", async () => {
    const jwt = await tokenFor("par_route_prefs_1");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      timezone: "Asia/Ho_Chi_Minh",
      progressEnabled: true,
      weeklyEnabled: true,
      quietStart: null,
      quietEnd: null,
      dailyCap: 10,
    });
  });

  it("PATCH updates and GET reflects it", async () => {
    const jwt = await tokenFor("par_route_prefs_2");
    const patchRes = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ weeklyEnabled: false, quietStart: "22:00", quietEnd: "06:30" }),
    });
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({ weeklyEnabled: false, quietStart: "22:00", quietEnd: "06:30" });

    const getRes = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(await getRes.json()).toMatchObject({ weeklyEnabled: false, quietStart: "22:00", quietEnd: "06:30" });
  });

  it("PATCH rejects a malformed quiet-hours time", async () => {
    const jwt = await tokenFor("par_route_prefs_3");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ quietStart: "9pm" }),
    });
    expect(res.status).toBe(422);
  });

  it("PATCH rejects an invalid IANA timezone", async () => {
    const jwt = await tokenFor("par_route_prefs_4");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ timezone: "Not/AZone" }),
    });
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/parent-routes.test.ts
```

Expected: FAIL — `../src/routes/parent` does not exist, and `env.PARENT_JWKS_URL` etc. are not yet typed/bound
(that's Task 4). This is expected — write the route file now, wire the env vars in Task 4.

- [ ] **Step 3: Write `src/routes/parent.ts`**

```ts
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
```

- [ ] **Step 4: Mount it in `src/fetch.ts`**

Add near the top with the other imports:

```ts
import { parentApp } from "./routes/parent";
```

Add right after `app.onError(appOnError);` (before the `// --- Routes ---` comment's existing routes, order
doesn't matter for `.route()` but keep it grouped with the other route registrations):

```ts
app.route("/v1/me", parentApp);
```

- [ ] **Step 5: Run it — still expect failure (Task 4 wires the env vars)**

```sh
pnpm test tests/parent-routes.test.ts
```

Expected: FAIL — `env.PARENT_JWKS_URL` etc. are `undefined` in `env.test` until Task 4 adds them to
`wrangler.jsonc`. Confirm the failures are specifically about the missing env vars / JWKS fetch, not a syntax
or import error — if they're something else, that's a real bug to fix now, not defer to Task 4.

- [ ] **Step 6: Run the full suite and type-check**

```sh
pnpm test
pnpm type-check
```

Expected: `tests/parent-routes.test.ts` still fails (as above); everything else (61 tests from Tasks 1–2) still
passes. `pnpm type-check` should be clean for the new files themselves — if `ParentApiEnv`/`Env` extension
doesn't type-check cleanly, fix that now; the *runtime* JWKS failure is expected, a *type* error is not.

- [ ] **Step 7: Commit**

```sh
git add src/routes/parent.ts src/fetch.ts tests/parent-routes.test.ts
git commit -m "feat(parent-api): devices + preferences routes, mounted at /v1/me (design.md §4.7)"
```

---

## Task 4: Wire `PARENT_JWKS_URL`/`PARENT_JWT_ISSUER`/`PARENT_JWT_AUDIENCE`, final check

**Files:**
- Modify: `wrangler.jsonc` (top-level `vars` and `env.test.vars`)

- [ ] **Step 1: Add to `wrangler.jsonc`'s top-level `vars` block**

Add alongside the existing WIF/FCM vars (same object, same style as the existing
`// --- FILL IN AFTER THE GCP CONSOLE WORK ---` comment block):

```jsonc
// --- FILL IN once robo-worker's auth migration (design.md §1.4) ships its
// JWKS endpoint. Until then these are placeholders — the parent API will
// 401 every request in production, which is the correct failure mode for
// "the upstream contract isn't live yet" rather than silently accepting
// unverifiable tokens.
"PARENT_JWKS_URL": "https://robo-worker.example/auth/jwks",
"PARENT_JWT_ISSUER": "https://robo-worker.example",
// Real, known value from design.md §1.4 — not a placeholder.
"PARENT_JWT_AUDIENCE": "robo-worker/parent",
```

- [ ] **Step 2: Add to `env.test.vars`**

```jsonc
"PARENT_JWKS_URL": "https://robo-worker.test/auth/jwks",
"PARENT_JWT_ISSUER": "https://robo-worker.test",
"PARENT_JWT_AUDIENCE": "robo-worker/parent",
```

(These match the values `tests/parent-jwt.test.ts` and `tests/parent-routes.test.ts` already use.)

- [ ] **Step 3: Regenerate types and run everything**

```sh
pnpm types
pnpm type-check
pnpm test
pnpm lint
```

Expected: clean type-check, all 65 tests passing (61 from Tasks 1–2 + 4 in `tests/parent-routes.test.ts`... —
recount against actual test output, not this estimate, and treat any mismatch as something to investigate,
not paper over), no lint errors.

- [ ] **Step 4: Commit**

```sh
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "feat(parent-api): wire PARENT_JWKS_URL/ISSUER/AUDIENCE config (design.md §1.4)"
```

---

## Final check for this plan

```sh
cd /home/ducmai/work/tuni-noti
pnpm type-check
pnpm test
pnpm lint
git log --oneline -4
```

Expected: clean type-check, all tests green, no lint errors, 4 new commits.

**What this unblocks:** the Android app team can integrate device registration + preferences against a real
API surface. Parent JWT verification is reusable as-is once the Consumer (design.md §6 step 6) needs to
identify which parent an inbound webhook-adjacent call belongs to (it currently doesn't — the queue consumer
authenticates nothing, it trusts Cloudflare Queues delivery).

**What this does NOT touch:** robo-worker's auth migration (§1.4, a different repo — `PARENT_JWKS_URL` stays
a placeholder in production until that ships) and the Consumer (§4.4–§4.6, §4.8 — inbox, identity mirror,
coalescing, FCM client), tracked as a separate follow-up plan.
