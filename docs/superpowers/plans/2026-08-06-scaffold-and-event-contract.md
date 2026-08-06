# Scaffold + Event Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up tuni-noti's D1 schema, Queues bindings, and the versioned event contract (`docs/design.md` §6 steps 4–5) — the foundation steps 6 (consumer) and 7 (parent API) both depend on.

**Architecture:** Copy the vendored Kysely D1 dialect and D1 test harness from robo-worker verbatim (`docs/design.md` §4.2). One migration creates all 9 tables from §4.3. Three Queues bindings (`NOTI_QUEUE`, `NOTI_WEEKLY_QUEUE` consumers; `SEND_QUEUE` producer+consumer) plus their DLQs. The event contract is one arktype module (`src/events/v1.ts`) with a discriminated union per event type, golden + negative JSON fixtures, and a contract test — this is what `docs/events/v1.md` documents and what robo-worker's producer code will later import verbatim.

**Tech Stack:** Kysely ^0.28 (vendored D1 dialect), arktype ^2.2, `@cloudflare/vitest-pool-workers` (`applyD1Migrations`), Wrangler D1 + Queues bindings.

**Out of scope for this plan** (tracked separately, not placeholders — see `docs/design.md` §6):
- Step 3 (robo-worker auth migration) and step 8 (robo-worker producer) — different repository (`/home/ducmai/work/robo-worker`), not explored this session. Needs its own plan written from inside that repo.
- Step 6 (consumer: inbox, identity mirror, coalescing, FCM send consumer) and step 7 (parent API) — depend on this plan's migration + event contract landing first. Separate follow-up plans.
- Step 9 (backfill + rollout) — depends on steps 6–8 all shipping.

---

## Before you start

Run these once to confirm the baseline is what this plan assumes:

```sh
cd /home/ducmai/work/tuni-noti
pnpm test        # 28 passed
pnpm type-check   # clean
find src -type d  # src/{auth,fcm,hxxp,utils} only — no src/datastore, no src/events
```

If any of those differ, stop and reconcile before starting — the tasks below assume this exact starting point.

---

## Task 1: Kysely + vendored D1 dialect

**Files:**
- Modify: `package.json` (add `kysely` dependency)
- Create: `src/datastore/d1/kysely-d1.ts`
- Test: `tests/kysely-d1.test.ts`

- [ ] **Step 1: Add the dependency**

```sh
pnpm add kysely@^0.28.15
```

- [ ] **Step 2: Copy the vendored D1 dialect verbatim from robo-worker**

Create `src/datastore/d1/kysely-d1.ts` with this exact content (copied from `/home/ducmai/work/robo-worker/src/datastore/d1/kysely-d1.ts` — zero project coupling per `docs/design.md` §4.2, do not modify):

```ts
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

/**
 * Config for the D1 dialect. Pass your D1 instance to this object that you bound in `wrangler.toml`.
 */
export interface D1DialectConfig {
  database: D1Database;
}

/**
 * D1 dialect that adds support for [Cloudflare D1][0] in [Kysely][1].
 * The constructor takes the instance of your D1 database that you bound in `wrangler.toml`.
 *
 * ```typescript
 * new D1Dialect({
 *   database: env.DB,
 * })
 * ```
 *
 * [0]: https://blog.cloudflare.com/introducing-d1/
 * [1]: https://github.com/koskimas/kysely
 */
export class D1Dialect implements Dialect {
  #config: D1DialectConfig;

  constructor(config: D1DialectConfig) {
    this.#config = config;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new D1Driver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class D1Driver implements Driver {
  #config: D1DialectConfig;

  constructor(config: D1DialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1Connection(this.#config);
  }

  async beginTransaction(conn: D1Connection): Promise<void> {
    return await conn.beginTransaction();
  }

  async commitTransaction(conn: D1Connection): Promise<void> {
    return await conn.commitTransaction();
  }

  async rollbackTransaction(conn: D1Connection): Promise<void> {
    return await conn.rollbackTransaction();
  }

  async releaseConnection(_conn: D1Connection): Promise<void> {}

  async destroy(): Promise<void> {}
}

class D1Connection implements DatabaseConnection {
  #config: D1DialectConfig;

  constructor(config: D1DialectConfig) {
    this.#config = config;
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const results = await this.#config.database
      .prepare(compiledQuery.sql)
      .bind(...compiledQuery.parameters)
      .all();
    if (results.error) {
      throw new Error(results.error);
    }

    const numAffectedRows = results.meta.changes > 0 ? BigInt(results.meta.changes) : undefined;

    return {
      insertId:
        results.meta.last_row_id === undefined || results.meta.last_row_id === null
          ? undefined
          : BigInt(results.meta.last_row_id),
      rows: (results?.results as O[]) || [],
      numAffectedRows,
    };
  }

  async beginTransaction() {
    throw new Error("Transactions are not supported yet.");
  }

  async commitTransaction() {
    throw new Error("Transactions are not supported yet.");
  }

  async rollbackTransaction() {
    throw new Error("Transactions are not supported yet.");
  }

  // biome-ignore lint/correctness/useYield: pass
  async *streamQuery<O>(_compiledQuery: CompiledQuery, _chunkSize: number): AsyncIterableIterator<QueryResult<O>> {
    throw new Error("D1 Driver does not support streaming");
  }
}
```

- [ ] **Step 3: Write a smoke test proving the dialect works against a real D1 binding**

This test doubles as the first proof that Task 2's migration (below) applies cleanly — write it now, it will fail until Task 2 lands, which is expected TDD order here since the dialect is meaningless without a table to query.

```ts
// tests/kysely-d1.test.ts
import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { D1Dialect } from "../src/datastore/d1/kysely-d1";

type DB = { parents: { parent_id: string; timezone: string; locale: string } };

describe("D1Dialect", () => {
  it("round-trips a row through Kysely against real D1", async () => {
    const db = new Kysely<DB>({ dialect: new D1Dialect({ database: env.NOTI_D1 }) });
    await db.insertInto("parents").values({ parent_id: "p1", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" }).execute();
    const row = await db.selectFrom("parents").selectAll().where("parent_id", "=", "p1").executeTakeFirst();
    expect(row).toEqual({ parent_id: "p1", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" });
  });
});
```

- [ ] **Step 4: Run it — expect failure**

```sh
pnpm test tests/kysely-d1.test.ts
```

Expected: FAIL — `env.NOTI_D1` is undefined (no D1 binding yet) and/or `no such table: parents` (no migration yet). Both are fixed by Task 2.

---

## Task 2: D1 database + migration 0001 (all 9 tables)

**Files:**
- Modify: `wrangler.jsonc` (add `d1_databases` binding, top-level and `env.test`)
- Create: `migrations/0001_init.sql`
- Modify: `vitest.config.mts` (wire `readD1Migrations`)
- Modify: `tests/setup.ts` (call `applyD1Migrations`)

- [ ] **Step 1: Create the D1 database**

```sh
npx wrangler d1 create tuni-noti-d1
```

This prints a `database_id` — copy it for Step 2. (This is a real, mutating Cloudflare API call; confirm with the user before running if not already authorized for this session.)

- [ ] **Step 2: Bind it in `wrangler.jsonc`**

Add to the top-level config (next to `"vars"`, inside the same object as `"upload_source_maps"` etc — see current file for exact placement) and duplicate verbatim into `env.test` per the existing `// wrangler envs do NOT inherit` comment at `wrangler.jsonc:54`:

```jsonc
"d1_databases": [
  {
    "binding": "NOTI_D1",
    "database_name": "tuni-noti-d1",
    "database_id": "<paste the id from Step 1>",
    "migrations_dir": "migrations"
  }
],
```

For `env.test`, use a fixed placeholder id — `vitest-pool-workers` provisions its own local D1 and ignores `database_id`, but the field is required:

```jsonc
"d1_databases": [
  {
    "binding": "NOTI_D1",
    "database_name": "tuni-noti-d1-test",
    "database_id": "00000000-0000-0000-0000-000000000000",
    "migrations_dir": "migrations"
  }
],
```

- [ ] **Step 3: Write migration 0001 — all 9 tables from `docs/design.md` §4.3**

```sql
-- migrations/0001_init.sql

CREATE TABLE inbox (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('processed','ignored')),
  payload_json TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- 30-day prune sweep (design.md §5.2) scans by age.
CREATE INDEX idx_inbox_received_at ON inbox (received_at);

CREATE TABLE parents (
  parent_id TEXT PRIMARY KEY,
  timezone  TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  locale    TEXT NOT NULL DEFAULT 'vi-VN'
);

CREATE TABLE children (
  child_id            TEXT PRIMARY KEY,
  parent_id           TEXT NOT NULL,
  name                TEXT NOT NULL,
  identity_updated_at TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX idx_children_parent_id ON children (parent_id);

CREATE TABLE push_tokens (
  token        TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL UNIQUE,
  parent_id    TEXT NOT NULL,
  platform     TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  disabled_at  TEXT
);
CREATE INDEX idx_push_tokens_parent_id ON push_tokens (parent_id);

CREATE TABLE preferences (
  parent_id        TEXT PRIMARY KEY,
  progress_enabled INTEGER NOT NULL DEFAULT 1,
  weekly_enabled   INTEGER NOT NULL DEFAULT 1,
  quiet_start      TEXT,
  quiet_end        TEXT,
  daily_cap        INTEGER NOT NULL DEFAULT 10
);

-- Append-only pending membership for coalescing (design.md §4.5 step 1).
-- window_key = child_id for scope='child', parent_id for scope='parent'.
CREATE TABLE coalesce_events (
  event_id     TEXT PRIMARY KEY,
  window_key   TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('child','parent')),
  child_id     TEXT,
  parent_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  arrived_at   TEXT NOT NULL
);
-- Load-bearing for the flush query (design.md §4.5 step 2): grouped by
-- window_key, ordered by arrived_at.
CREATE INDEX idx_coalesce_events_window ON coalesce_events (window_key, arrived_at);

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT NOT NULL,
  child_id      TEXT,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  data_json     TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  enqueued_at   TEXT,
  state         TEXT NOT NULL CHECK (state IN (
                  'scheduled','enqueued','done','deferred_quiet',
                  'suppressed_cap','suppressed_dark','canceled'
                )),
  dedupe_key    TEXT NOT NULL UNIQUE
);
-- The hourly sweeper (design.md §4.5 step 4) scans scheduled rows older than
-- 15 min; the quiet-end flush scans deferred_quiet rows for a parent+date.
CREATE INDEX idx_notifications_state_scheduled ON notifications (state, scheduled_for);
CREATE INDEX idx_notifications_parent_id ON notifications (parent_id);

CREATE TABLE deliveries (
  notification_id TEXT NOT NULL,
  token            TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('pending','accepted','failed','canceled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  fcm_message_name TEXT,
  PRIMARY KEY (notification_id, token)
);
CREATE INDEX idx_deliveries_token ON deliveries (token);

CREATE TABLE caps (
  parent_id  TEXT NOT NULL,
  local_date TEXT NOT NULL,
  daily_cap  INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (parent_id, local_date)
);
```

- [ ] **Step 4: Wire the D1 test harness (`vitest.config.mts` + `tests/setup.ts`)**

Replace `vitest.config.mts` with:

```ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      restoreMocks: true,
      setupFiles: ["tests/setup.ts"],
      teardownTimeout: 5000,
      hookTimeout: 20000,
    },
  };
});
```

Replace `tests/setup.ts` with:

```ts
// MUST stay the first import in the test entry too: arktype's JIT compiles with
// `new Function`, which workerd forbids outside script startup. See
// src/arktype-config.ts.
import "../src/arktype-config";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  if (!migrations) throw new Error("TEST_MIGRATIONS is required for D1 test setup");
  await applyD1Migrations(env.NOTI_D1, migrations);
});
```

- [ ] **Step 5: Regenerate types and run the tests**

```sh
pnpm types
pnpm test tests/kysely-d1.test.ts
```

Expected: PASS — the round-trip from Task 1 Step 3 now has both a binding and a table.

- [ ] **Step 6: Run the full suite and type-check**

```sh
pnpm type-check
pnpm test
```

Expected: all previously-passing tests still pass (29 total: 28 existing + the new kysely-d1 test).

- [ ] **Step 7: Apply the migration to the real (remote) database**

```sh
npx wrangler d1 migrations apply tuni-noti-d1 --remote
```

Confirm with the user before running — this is a real, mutating change against production D1. Not covered by `--env=""`; D1 migrations commands don't take that flag, they take `--remote`/`--local`.

- [ ] **Step 8: Commit**

```sh
git add package.json pnpm-lock.yaml src/datastore/d1/kysely-d1.ts tests/kysely-d1.test.ts \
  migrations/0001_init.sql wrangler.jsonc vitest.config.mts tests/setup.ts worker-configuration.d.ts
git commit -m "feat(scaffold): D1 schema, Kysely D1 dialect, test harness (design.md §4.2-4.3)"
```

---

## Task 3: Queue bindings

**Files:**
- Modify: `wrangler.jsonc` (top-level and `env.test`)

Three queues per `docs/design.md` §1.2, §4.4, §4.5 step 4, §5.3:
- `NOTI_QUEUE` — real-time progress events from robo-worker. This Worker is a **consumer** only (robo-worker is the producer — its binding is out of scope here, tracked under step 8).
- `NOTI_WEEKLY_QUEUE` — Sunday fan-out, separate from `NOTI_QUEUE` so a poison weekly batch can't share a DLQ with real-time traffic (§5.3). Consumer only, same reasoning.
- `SEND_QUEUE` — internal to tuni-noti. The flush cron is the **producer** (§4.5 step 4); a send consumer is the **consumer** (§4.6). Both bindings live in this repo.

- [ ] **Step 1: Create the queues and their dead-letter queues**

```sh
npx wrangler queues create tuni-noti-events
npx wrangler queues create tuni-noti-events-dlq
npx wrangler queues create tuni-noti-weekly
npx wrangler queues create tuni-noti-weekly-dlq
npx wrangler queues create tuni-noti-send
npx wrangler queues create tuni-noti-send-dlq
```

Confirm with the user before running — mutating Cloudflare API calls.

- [ ] **Step 2: Add bindings to `wrangler.jsonc`, top-level**

```jsonc
"queues": {
  "consumers": [
    {
      "queue": "tuni-noti-events",
      "max_batch_size": 100,
      "max_retries": 3,
      "dead_letter_queue": "tuni-noti-events-dlq"
    },
    {
      "queue": "tuni-noti-weekly",
      "max_batch_size": 100,
      "max_retries": 3,
      "dead_letter_queue": "tuni-noti-weekly-dlq"
    },
    {
      "queue": "tuni-noti-send",
      "max_batch_size": 100,
      // Lower than the inbound queues: a send failure is retried by FCM's own
      // classifier (src/fcm/client.ts) up to the point it's terminal, so a
      // consumer-level retry storm on top of that just wastes budget
      // (docs/design.md §4.6, §5.3 "its own retry policy").
      "max_retries": 2,
      "dead_letter_queue": "tuni-noti-send-dlq"
    }
  ],
  "producers": [
    { "queue": "tuni-noti-send", "binding": "SEND_QUEUE" }
  ]
},
```

`NOTI_QUEUE` and `NOTI_WEEKLY_QUEUE` do not appear under `producers` here — this Worker only consumes them. The consumer entries above don't need `binding` names; Wrangler routes by queue name to the exported `queue()` handler in `src/index.ts` (added in the consumer plan, Task Group C/D).

- [ ] **Step 3: Duplicate into `env.test`**, using distinct queue names so local test runs never touch real Cloudflare queues:

```jsonc
"queues": {
  "consumers": [
    { "queue": "tuni-noti-events-test", "max_batch_size": 100, "max_retries": 3, "dead_letter_queue": "tuni-noti-events-test-dlq" },
    { "queue": "tuni-noti-weekly-test", "max_batch_size": 100, "max_retries": 3, "dead_letter_queue": "tuni-noti-weekly-test-dlq" },
    { "queue": "tuni-noti-send-test", "max_batch_size": 100, "max_retries": 2, "dead_letter_queue": "tuni-noti-send-test-dlq" }
  ],
  "producers": [
    { "queue": "tuni-noti-send-test", "binding": "SEND_QUEUE" }
  ]
},
```

`vitest-pool-workers` simulates queues locally; it does not require these named queues to exist in the real account.

- [ ] **Step 4: Regenerate types, type-check**

```sh
pnpm types
pnpm type-check
```

Expected: clean. No behavior to test yet — there's no `queue()` handler until the consumer plan; this task only proves the config parses and types generate.

- [ ] **Step 5: Commit**

```sh
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "feat(scaffold): Queues bindings for NOTI_QUEUE, NOTI_WEEKLY_QUEUE, SEND_QUEUE (design.md §1.2, §5.3)"
```

---

## Task 4: Event contract — envelope + identity events

**Files:**
- Create: `src/events/v1.ts`
- Test: `tests/events-v1.test.ts`

- [ ] **Step 1: Write the failing tests** for the envelope shape and the two identity event types

```ts
// tests/events-v1.test.ts
import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { eventV1 } from "../src/events/v1";

const baseSubject = { parentId: "par_1", childId: "chi_1", childName: "An" };

describe("eventV1 — identity events", () => {
  it("accepts a valid identity.child.upserted envelope", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:upserted:2026-08-04T10:00:00Z",
      type: "identity.child.upserted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { name: "An", age: 6, stage: "A1" },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("accepts identity.child.deleted with empty data", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:deleted",
      type: "identity.child.deleted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: {},
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects a missing required subject field", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:deleted",
      type: "identity.child.deleted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: { parentId: "par_1", childName: "An" }, // childId missing
      data: {},
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("ignores unknown fields on data — additive-only within a major (design.md §2)", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:upserted:2026-08-04T10:00:00Z",
      type: "identity.child.upserted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { name: "An", age: 6, stage: "A1", futureField: "whatever" },
    });
    expect(out instanceof type.errors).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/events-v1.test.ts
```

Expected: FAIL — `../src/events/v1` does not exist.

- [ ] **Step 3: Write `src/events/v1.ts`** — envelope + the two identity event types only (learning + reporting types are Task 5)

```ts
// src/events/v1.ts
//
// The versioned event contract (docs/design.md §2). Owned by tuni-noti,
// copied VERBATIM into robo-worker — the two repos' CIs cross-check each
// other's fixtures at a pinned SHA (docs/events/v1.md, docs/design.md §2).
// Do not hand-edit a copy in robo-worker; land the change here first.
//
// Additive-only within a major: consumers ignore unknown fields, so every
// `data` shape below is "+": "ignore" (arktype's default) rather than
// "+": "reject".

import { type } from "arktype";

const subject = type({
  parentId: "string > 0",
  childId: "string > 0",
  childName: "string > 0",
});

const envelopeFields = {
  specVersion: "'1.0'",
  eventId: "string > 0",
  occurredAt: "string > 0",
  producer: "string > 0",
  subject,
} as const;

// outcome ∈ achieved | almost | practice_more — mirrors
// deriveMissionOutcome() (robo-worker src/services/course/runtime/events.ts:454).
const outcome = "'achieved'|'almost'|'practice_more'";

export const identityChildUpserted = type({
  ...envelopeFields,
  type: "'identity.child.upserted'",
  data: { name: "string > 0", age: "number", stage: "string > 0" },
});

export const identityChildDeleted = type({
  ...envelopeFields,
  type: "'identity.child.deleted'",
  data: {},
});

// Defined in the contract, no producer yet (docs/design.md §1.5) — robo-worker
// has no account deletion. Included so the consumer's exhaustive type switch
// (docs/design.md §4.4) has a real branch to route to `ignored` rather than
// an unknown-type fallback, the day a producer for it appears.
export const identityParentDeleted = type({
  ...envelopeFields,
  type: "'identity.parent.deleted'",
  data: {},
});

export const learningLessonCompleted = type({
  ...envelopeFields,
  type: "'learning.lesson.completed'",
  data: { courseId: "string > 0", lessonId: "string > 0", outcome, durationS: "number" },
});

export const learningChallengeAchieved = type({
  ...envelopeFields,
  type: "'learning.challenge.achieved'",
  data: { courseId: "string > 0", challengeId: "string > 0", firstTime: "boolean" },
});

export const learningStarAwarded = type({
  ...envelopeFields,
  type: "'learning.star.awarded'",
  data: { courseId: "string > 0", challengeId: "string > 0", totalStars: "number" },
});

export const reportingWeekClosed = type({
  ...envelopeFields,
  type: "'reporting.week.closed'",
  data: {
    weekStart: "string > 0",
    weekEnd: "string > 0",
    lessons: "number",
    // stars and missionsAchieved are DIFFERENT numbers — one row in
    // child_challenge_awards is one mission, `stars` is that row's award
    // (1..100); COUNT(*) is not a star count (docs/design.md §3.4).
    stars: "number",
    missionsAchieved: "number",
  },
});

export const eventV1 = identityChildUpserted
  .or(identityChildDeleted)
  .or(identityParentDeleted)
  .or(learningLessonCompleted)
  .or(learningChallengeAchieved)
  .or(learningStarAwarded)
  .or(reportingWeekClosed);

export type EventV1 = typeof eventV1.infer;
```

- [ ] **Step 4: Run the tests — expect pass**

```sh
pnpm test tests/events-v1.test.ts
```

Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```sh
git add src/events/v1.ts tests/events-v1.test.ts
git commit -m "feat(events): envelope + identity.* event types (design.md §2)"
```

---

## Task 5: Event contract — learning + reporting events, negative fixtures

**Files:**
- Modify: `tests/events-v1.test.ts`
- Create: `tests/fixtures/events/` (golden + negative JSON, one file per case)

- [ ] **Step 1: Write the failing tests** for the four remaining event types plus the version-major and unknown-type negative cases the consumer will rely on (`docs/design.md` §4.4)

```ts
// append to tests/events-v1.test.ts

describe("eventV1 — learning + reporting events", () => {
  it("accepts learning.lesson.completed", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "led_1:lesson_completed",
      type: "learning.lesson.completed",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { courseId: "c1", lessonId: "l1", outcome: "achieved", durationS: 300 },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects an outcome value outside the enum", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "led_1:lesson_completed",
      type: "learning.lesson.completed",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { courseId: "c1", lessonId: "l1", outcome: "perfect", durationS: 300 },
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("accepts learning.challenge.achieved", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "led_1:challenge_achieved",
      type: "learning.challenge.achieved",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { courseId: "c1", challengeId: "ch1", firstTime: true },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("accepts learning.star.awarded", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "led_1:star_awarded",
      type: "learning.star.awarded",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: { courseId: "c1", challengeId: "ch1", totalStars: 12 },
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("accepts reporting.week.closed with stars and missionsAchieved as separate fields", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "chi_1:2026-08-03",
      type: "reporting.week.closed",
      occurredAt: "2026-08-09T03:00:00Z",
      producer: "tuni-noti",
      subject: baseSubject,
      data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.data).toMatchObject({ stars: 14, missionsAchieved: 3 });
    }
  });
});

describe("eventV1 — negative cases the consumer depends on (design.md §4.4)", () => {
  it("rejects an unrecognized event type", () => {
    const out = eventV1({
      specVersion: "1.0",
      eventId: "x:1",
      type: "learning.something.new",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: {},
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("rejects a non-1.x specVersion", () => {
    const out = eventV1({
      specVersion: "2.0",
      eventId: "chi_1:deleted",
      type: "identity.child.deleted",
      occurredAt: "2026-08-04T10:00:00Z",
      producer: "robo-worker",
      subject: baseSubject,
      data: {},
    });
    expect(out instanceof type.errors).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect the new tests to fail**, existing ones still pass

```sh
pnpm test tests/events-v1.test.ts
```

Expected: the 4 event-type tests + negative cases pass already if Task 4's union is complete (it is — `eventV1` in Task 4 Step 3 already includes all 6 types). This step should actually show **all PASS** — if `learningLessonCompleted` etc. fail, the union in Task 4 is incomplete; fix it there, not here.

- [ ] **Step 3: Write the golden + negative JSON fixtures** other tests (and later, robo-worker's CI) assert against. One file per case, named for what it proves:

```json
// tests/fixtures/events/identity.child.upserted.golden.json
{
  "specVersion": "1.0",
  "eventId": "chi_1:upserted:2026-08-04T10:00:00Z",
  "type": "identity.child.upserted",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": { "name": "An", "age": 6, "stage": "A1" }
}
```

```json
// tests/fixtures/events/identity.child.deleted.golden.json
{
  "specVersion": "1.0",
  "eventId": "chi_1:deleted",
  "type": "identity.child.deleted",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": {}
}
```

```json
// tests/fixtures/events/learning.lesson.completed.golden.json
{
  "specVersion": "1.0",
  "eventId": "led_1:lesson_completed",
  "type": "learning.lesson.completed",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": { "courseId": "c1", "lessonId": "l1", "outcome": "achieved", "durationS": 300 }
}
```

```json
// tests/fixtures/events/learning.challenge.achieved.golden.json
{
  "specVersion": "1.0",
  "eventId": "led_1:challenge_achieved",
  "type": "learning.challenge.achieved",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": { "courseId": "c1", "challengeId": "ch1", "firstTime": true }
}
```

```json
// tests/fixtures/events/learning.star.awarded.golden.json
{
  "specVersion": "1.0",
  "eventId": "led_1:star_awarded",
  "type": "learning.star.awarded",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": { "courseId": "c1", "challengeId": "ch1", "totalStars": 12 }
}
```

```json
// tests/fixtures/events/reporting.week.closed.golden.json
{
  "specVersion": "1.0",
  "eventId": "chi_1:2026-08-03",
  "type": "reporting.week.closed",
  "occurredAt": "2026-08-09T03:00:00Z",
  "producer": "tuni-noti",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": { "weekStart": "2026-08-03", "weekEnd": "2026-08-09", "lessons": 5, "stars": 14, "missionsAchieved": 3 }
}
```

```json
// tests/fixtures/events/negative.missing-subject-field.json
{
  "specVersion": "1.0",
  "eventId": "chi_1:deleted",
  "type": "identity.child.deleted",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childName": "An" },
  "data": {}
}
```

```json
// tests/fixtures/events/negative.unknown-type.json
{
  "specVersion": "1.0",
  "eventId": "x:1",
  "type": "learning.something.new",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": {}
}
```

```json
// tests/fixtures/events/negative.version-mismatch.json
{
  "specVersion": "2.0",
  "eventId": "chi_1:deleted",
  "type": "identity.child.deleted",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": {}
}
```

```json
// tests/fixtures/events/negative.unknown-added-field.json
{
  "specVersion": "1.0",
  "eventId": "chi_1:upserted:2026-08-04T10:00:00Z",
  "type": "identity.child.upserted",
  "occurredAt": "2026-08-04T10:00:00Z",
  "producer": "robo-worker",
  "subject": { "parentId": "par_1", "childId": "chi_1", "childName": "An" },
  "data": { "name": "An", "age": 6, "stage": "A1", "futureField": "whatever" }
}
```

- [ ] **Step 4: Write a contract test that loads every fixture file and asserts golden ⇒ valid, negative ⇒ invalid** — this is what makes the fixture directory executable rather than decorative, and what the pinned-SHA cross-repo CI (Task 6) will point at.

```ts
// tests/fixtures-contract.test.ts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { eventV1 } from "../src/events/v1";

const FIXTURES_DIR = path.join(__dirname, "fixtures/events");

describe("event fixtures — contract", () => {
  it("every fixture file parses as declared by its filename", async () => {
    const files = await readdir(FIXTURES_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const json = JSON.parse(await readFile(path.join(FIXTURES_DIR, file), "utf8"));
      const out = eventV1(json);
      const isNegative = file.startsWith("negative.");
      const failed = out instanceof type.errors;
      expect(failed, `${file}: expected ${isNegative ? "REJECT" : "ACCEPT"}, got ${failed ? "REJECT" : "ACCEPT"}`).toBe(
        isNegative,
      );
    }
  });
});
```

- [ ] **Step 5: Run everything**

```sh
pnpm test
pnpm type-check
```

Expected: all green (29 prior + new event/fixture tests).

- [ ] **Step 6: Commit**

```sh
git add src/events/v1.ts tests/events-v1.test.ts tests/fixtures/events tests/fixtures-contract.test.ts
git commit -m "feat(events): learning + reporting event types, golden and negative fixtures (design.md §2)"
```

---

## Task 6: `docs/events/v1.md`

**Files:**
- Create: `docs/events/v1.md`

- [ ] **Step 1: Write the contract doc.** This is what robo-worker's team reads to build the producer side (step 8) without needing to read `src/events/v1.ts` — keep it a spec, not an implementation walkthrough.

```markdown
# tuni-noti event contract — v1

Owned by **tuni-noti** (`src/events/v1.ts`). Copied verbatim into robo-worker. Golden and negative
fixtures live in `tests/fixtures/events/*.json` in both repos, synchronized by pinned-SHA CI (see
"Synchronization" below) — not by discipline.

**Additive-only within a major.** Consumers ignore unknown fields on `data`. A breaking change is a new
major (`specVersion: "2.0"`), which the consumer treats as `ignored`, never as a parse error to retry.

## Envelope

```jsonc
{
  "specVersion": "1.0",
  "eventId":     "string",   // DERIVED, never minted fresh — see below
  "type":        "string",   // one of the event types below
  "occurredAt":  "string",   // ISO-8601
  "producer":    "string",   // "robo-worker" | "tuni-noti"
  "subject": {
    "parentId":  "string",
    "childId":   "string",
    "childName": "string"    // denormalized — an event is never unrenderable
  },
  "data": { /* per-type, see below */ }
}
```

## `eventId` derivation

Replays (a retried `waitUntil`, a re-run weekly rider, a future outbox drain) must produce
byte-identical ids, or the consumer inbox dedupes nothing.

| Type | `eventId` |
|---|---|
| `learning.*` | `{ledgerEventId}:{kind}` — e.g. `{uuid}:lesson_completed`, `{uuid}:star_awarded` |
| `reporting.week.closed` | `{childId}:{weekStart}` |
| `identity.child.*` | `{childId}:upserted:{occurredAt}` / `{childId}:deleted` |

## Event types

| Type | `data` |
|---|---|
| `identity.child.upserted` | `{ name: string, age: number, stage: string }` |
| `identity.child.deleted` | `{}` |
| `identity.parent.deleted` | `{}` — defined, no producer yet (robo-worker has no account deletion) |
| `learning.lesson.completed` | `{ courseId: string, lessonId: string, outcome: 'achieved'\|'almost'\|'practice_more', durationS: number }` |
| `learning.challenge.achieved` | `{ courseId: string, challengeId: string, firstTime: boolean }` |
| `learning.star.awarded` | `{ courseId: string, challengeId: string, totalStars: number }` |
| `reporting.week.closed` | `{ weekStart: string, weekEnd: string, lessons: number, stars: number, missionsAchieved: number }` — `stars` and `missionsAchieved` are separate counts, not derivable from each other |

## Transport

- `learning.*` and `identity.child.upserted` → `NOTI_QUEUE`.
- `reporting.week.closed` → `NOTI_WEEKLY_QUEUE` (separate queue — a poison weekly batch must not share
  a DLQ or retry budget with real-time traffic).
- `identity.child.deleted` → also `NOTI_QUEUE`, but published from robo-worker's durable deletion
  pipeline, not the fire-and-forget path every other event uses. A lost deletion event is a data-erasure
  bug, not a missed nicety.

## Synchronization

Each repo's CI fetches the *other* repo's `tests/fixtures/events/` directory at a pinned SHA recorded in
a manifest file, and asserts both directions: current producer (robo-worker) against the pinned consumer
contract, current consumer (tuni-noti) against the pinned producer fixtures. Bumping the pin is a
deliberate, reviewed act — not automatic on every push.

**Not built in this plan:** the actual CI manifest + fetch step lives in a follow-up once robo-worker's
producer side (design.md §6 step 8) exists to fetch fixtures *from*.
```

- [ ] **Step 2: Commit**

```sh
git add docs/events/v1.md
git commit -m "docs(events): publish the v1 event contract (design.md §2)"
```

---

## Final check for this plan

```sh
cd /home/ducmai/work/tuni-noti
pnpm type-check
pnpm test
pnpm lint
git log --oneline -6
```

Expected: clean type-check, all tests green, no lint errors, 6 new commits on top of `3b9f823`.

**What this unblocks:** `design.md` §6 steps 6 (consumer) and 7 (parent API) can now start — both need the D1 schema and the event contract this plan produces. Write those as separate plans; each is large enough to warrant its own file and its own review checkpoint, per the Scope Check in `superpowers:writing-plans`.

**What this does NOT touch:** steps 3 and 8 (robo-worker changes) — different repository, needs a plan written from a session with that repo open. Step 9 (backfill + rollout) — depends on steps 6–8 all shipping first.
