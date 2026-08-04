# tuni-noti — Parent Notification Service

**Status:** design r2, not yet implemented. r2 incorporates the 2026-08-04 design review (two-reviewer
debate + a line-by-line fact-check of every robo-worker citation): asymmetric parent tokens become a
prerequisite, the consumer is rebuilt around idempotent single-batch effects, `identity.child.deleted`
rides the durable deletion pipeline, and the §3.5 producer citations are corrected against the real code.

---

## 1. Context

**Tuni** is an English tutoring robot for Vietnamese children aged 5–8. Parents manage it through an
Android app that today talks only to **robo-worker** (Cloudflare Worker + Hono + D1 + Durable Objects).

robo-worker has **zero notification infrastructure** — no push, email, device tokens, or Queues. This is
explicit, not accidental: `docs/parent-app-api.md:108-113` lists "no push notifications" as a v1
non-goal, and `src/services/course/engine/lifecycle.ts:698` carries the comment *"NO new notification
transport… parent-app delivery is out of scope."*

The result: a child finishes a lesson, earns a star, completes a mission — and the parent learns nothing
unless they happen to open the app. **tuni-noti closes that loop.**

**Outcome:** parents get timely FCM pushes for progress moments, plus a Sunday weekly nudge, without
notification concerns leaking back into robo-worker's domain logic.

### 1.1 Responsibilities

| | robo-worker | tuni-noti |
|---|---|---|
| Owns | parents, children, learning progress, challenges, curriculum | FCM tokens, notification preferences, notification history |
| Does | emits domain events | renders, schedules and delivers pushes |

**tuni-noti never reads robo-worker's D1.** The only coupling is a versioned event contract.

### 1.2 Topology

```text
                    robo-worker  (domain & learning)
                          │
                  ledger fold commits
                          │
          ctx.waitUntil(publishEvents)   ← progress events: direct send, fire-and-forget
                                            (no outbox in v1 — see §3.1, §3.5)
          deletion pipeline stage        ← identity.child.deleted: durable, retried (§3.6)
                          │
                          ▼
              Cloudflare Queues  (at-least-once, unordered)
              NOTI_QUEUE (real-time) · NOTI_WEEKLY_QUEUE (Sunday fan-out, §5.3)
                          │
                          ▼
                     tuni-noti
        ┌──────────────────────────────────────┐
        │ inbox            (dedup record)      │
        │ identity mirror  (names, tombstones) │
        │ coalescing       (1 push / session)  │
        │ preferences      (quiet hours, caps) │
        │ FCM client       (HTTP v1 + WIF)     │
        └──────────────────────────────────────┘
                          │
                          ▼
                    Firebase FCM → Android app
```

### 1.3 Decisions

| Decision | Choice |
|---|---|
| Channel (v1) | FCM push, Android only. iOS is **deferred, not free**: APNs config, permission flows, platform payload fields, and token-lifecycle differences — a `platform` column is the smallest part of it (§9) |
| Coupling | Fully separate Worker. tuni-noti never reads robo-worker's D1. |
| Transport | Cloudflare Queues, versioned domain events. Real-time and weekly traffic on **separate queues** (§5.3) |
| Triggers | Progress moments + weekly nudge (one **digest per parent**, §4.5) |
| Weekly report | **No new report artifact.** Sunday cron emits summary *numbers*; the push deep-links to the analytics screen the app already has |
| Publish path | Progress events: inline `ctx.waitUntil(queue.send)`, **no producer outbox in v1** — a dropped push is tolerable, the learning data is already durable. Drops are **counted** (§3.2); outbox specced as deferred hardening (§3.5). `identity.child.deleted` is never on this path — it rides the durable deletion pipeline (§3.6) |
| Delivery guarantee | **At-least-once, stated honestly.** FCM cannot participate in a transaction, so a crash between "FCM accepted" and "state recorded" duplicates a push. Per-token delivery rows + deterministic IDs + Android collapse keys bound the visible damage (§4.5, §4.6) |
| Auth | **Prerequisite, not shared secret:** robo-worker migrates parent sessions to ES256 + JWKS before tuni-noti's authenticated API goes live. tuni-noti never holds `PARENT_SESSION_SECRET` (§1.4) |
| Identity | Denormalized in every envelope **and** mirrored via identity events. The mirror is the rendering source; the envelope name is the fallback when the mirror has no row yet (§4.8) |
| Stack | Mirror robo-worker: Worker + Hono + arktype + Kysely/D1 + Biome + vitest-pool-workers |
| FCM credentials | **WIF** — copy `src/auth/wif.ts`, parameterize scope. No Google API key held. |
| Event contract | Copy-in arktype module + golden JSON fixtures, synchronized by **pinned-SHA cross-repo CI** — not by discipline (§2) |

### 1.4 Prerequisite — asymmetric parent tokens

The original draft had tuni-noti validate parent JWTs by sharing `PARENT_SESSION_SECRET` (HS256,
`aud: "robo-worker/parent"`, verification at robo-worker `src/auth/parent.ts:30-47`). Review killed
this: with a symmetric key, a verifier IS a signer. Anyone who compromises tuni-noti's public
device/preferences API and reads the secret can **mint** valid parent sessions for robo-worker — the
notification service's blast radius becomes the entire parent API.

The migration is cheap because sessions are 24 h with **no refresh**, and ES256 + JWKS infrastructure
already exists in-house (`src/auth/wif.ts`, `/auth/jwks`):

1. Mint a **dedicated** parent-session ES256 key with a `kid` — do *not* reuse the WIF signing key.
2. Publish its public JWK through robo-worker's existing `/auth/jwks`.
3. robo-worker verifies **both** (strictly pinned HS256 legacy + ES256/JWKS) but issues ES256 only.
4. After the 24 h maximum HS256 lifetime plus skew, drop HS256 verification.
5. tuni-noti verifies ES256 via a cached JWKS fetch (unknown-`kid` → one refresh; strict `alg`, `iss`,
   `aud` pinning — no algorithm negotiation). It never sees a symmetric secret.

Step 5 is the only part tuni-noti builds; steps 1–4 are ~a day in robo-worker and can run in parallel
with the walking skeleton (§6).

### 1.5 Assumptions (flagged, not blocking)

- `identity.parent.deleted` is defined in the contract but has **no producer**: robo-worker has no
  account deletion (`docs/parent-app-api.md:111`). Child deletion does exist and is wired (§3.6).
- Both services are on Workers Paid (DOs / Workflows / Vectorize require it), so Queues is included:
  1 M operations/month free, then $0.40/M. Cost is not a factor.

---

## 2. The event contract

Owned by tuni-noti, published as `docs/events/v1.md`. The arktype schemas live in `src/events/v1.ts` and
are **copied verbatim** into robo-worker, alongside a shared set of golden JSON fixtures
(`tests/fixtures/events/*.json`).

**Synchronization is mechanical, not aspirational.** Two independently edited copies are two contracts,
even when both CIs are green. tuni-noti is the named owner; each repo's CI fetches the *other* repo's
fixture directory at a **pinned SHA** recorded in a manifest file, and asserts both directions (current
producer against pinned consumer contract, current consumer against pinned producer fixtures). Bumping a
pin is a deliberate, reviewed act. Fixtures include **negative cases** — missing required fields, unknown
added fields, version mismatches, every enum branch — not just golden positives.

Additive-only within a major; consumers ignore unknown fields.

```jsonc
{
  "specVersion": "1.0",
  "eventId":     "0198a3f1-…:star_awarded",   // DERIVED, deterministic — the idempotency key (see below)
  "type":        "learning.star.awarded",
  "occurredAt":  "2026-08-04T10:00:00Z",
  "producer":    "robo-worker",
  "subject": {
    "parentId":  "…",
    "childId":   "…",
    "childName": "An"                  // denormalized: an event is NEVER unrenderable
  },
  "data": { /* per-type */ }
}
```

**`eventId` is derived, never minted at publish time.** A replay — a retried `waitUntil`, a re-run
weekly rider, the future outbox draining twice — must produce byte-identical IDs, or the consumer inbox
dedupes nothing:

| Type | `eventId` derivation |
|---|---|
| `learning.*` | `{ledgerEventId}:{kind}` — e.g. `{uuid}:lesson_completed`, `{uuid}:star_awarded` |
| `reporting.week.closed` | `{childId}:{weekStart}` |
| `identity.child.*` | `{childId}:upserted:{occurredAt}` / `{childId}:deleted` |

| Type | `data` | Producer site (robo-worker) |
|---|---|---|
| `identity.child.upserted` | `{name, age, stage}` | `src/routes/parent.ts:97,118` + placement finalize |
| `identity.child.deleted` | `{}` | deletion pipeline, durable stage before `receipt` (§3.6) |
| `learning.lesson.completed` | `{courseId, lessonId, outcome, durationS}` | `commitFold` projected outputs (§3.2) |
| `learning.challenge.achieved` | `{courseId, challengeId, firstTime}` | `commitFold` projected outputs (§3.2) |
| `learning.star.awarded` | `{courseId, challengeId, totalStars}` | `commitFold` projected outputs (§3.2) |
| `reporting.week.closed` | `{weekStart, weekEnd, lessons, stars, missionsAchieved}` | Sunday cron (§3.4) |

**The ledger has no per-moment event types.** `learning_events.type` is only
`evidence | lesson_run | state_change`; one `lesson_run` projects into up to three row kinds (lesson
log / challenge outcome / awards) inside the fold. The contract therefore documents that **one
`lesson_run` yields zero to three notification events**, and `buildNotificationEvents` maps from the
fold's *projected outputs*, not from ledger event types (§3.2).

`outcome ∈ achieved | almost | practice_more` — reuse `deriveMissionOutcome()`
(`src/services/course/runtime/events.ts:454`).

> **Invariant D4** (`src/services/course/parent-analytics.ts:9-12`): lesson result labels derive
> **solely** from the Mission Can-do outcome, never from score. Notification copy must respect this.

> **Naming:** `reporting.week.closed`, not `WeeklyReportReady` — the queue carries *domain events*, not
> notification jobs. "Go tell people" is tuni-noti's decision to make, not robo-worker's.

---

## 3. Producer — robo-worker changes

> "Separate service" ≠ "no robo-worker changes." This is real work in the main worker.

### 3.1 Publishing — direct send (v1, progress events only)

**v1 publishes progress events directly to the queue, with no producer-side outbox.**

```ts
// after commitFold's batch commits
ctx.waitUntil(publishEvents(env, buildNotificationEvents(folded)));
```

**The tradeoff, stated plainly:** if `queue.send()` throws — or the isolate dies before `waitUntil`
settles — that notification is **lost silently**. There is no retry and no record that it should have
existed.

This is acceptable for v1 because a notification is not a system of record. The learning data is already
durably committed in `learning_events`; only the *telling* is lost. A parent misses one "An earned a
star" push and the app still shows the star on next open. Nothing needs reconciling.

Two hard boundaries on this path:

- It stops being acceptable the moment a notification carries information available nowhere else — an
  account or safety notice, a payment failure, anything with a deadline. See §3.5 before adding one.
- `identity.child.deleted` is **never** on this path. A lost deletion event silently retains a child's
  name and history in tuni-noti — that is a data-erasure failure, not a missed nicety. It rides the
  durable deletion pipeline (§3.6).

### 3.2 `src/services/notifications/publisher.ts`

- `buildNotificationEvents(folded)` — pure; `commitFold`'s **projected outputs** (lesson log rows,
  challenge outcomes, awards — see §2) → domain events with derived `eventId`s. Unit-testable with no
  bindings.
- `publishEvents(env, events)` — `env.NOTI_QUEUE.sendBatch()` (≤ 100 msgs / 256 KB per batch).
  **Must never throw into the caller** — catch and swallow. A failed push must never fail a lesson fold.

**Count the drops — logs cannot.** Production Worker logs are not retained in this deployment, so
"watch the logs for publish failures" is a trigger that can never fire. The catch block writes one
data point to a Workers **Analytics Engine** binding (`NOTI_METRICS`, dimensions: event type, error
class). That counter is the honest answer to "how many pushes did we drop last week?" and the §3.5
upgrade trigger.

Keep `buildNotificationEvents` separate from `publishEvents`. That seam is what makes §3.5 a
one-file change later, and it is where the golden-fixture contract tests attach.

### 3.3 Wiring

| Where | Change |
|---|---|
| after `commitFold` (`src/datastore/d1/learner-projection.ts:571-584`) | `ctx.waitUntil(publishEvents(env, …))` once the fold's single batch commits |
| `src/index.ts` weekly cron `"0 3 * * SUN"` | new rider: weekly aggregate fan-out (§3.4) |
| `src/routes/parent.ts:97,118` + `updateChildStage()` (`src/datastore/d1/children.ts:19`) | emit `identity.child.upserted` |
| `src/services/course/runtime/deletion.ts` | new durable stage emitting `identity.child.deleted` before `receipt` (§3.6) |
| `wrangler.jsonc` | queue **producer** bindings `NOTI_QUEUE` + `NOTI_WEEKLY_QUEUE`; **duplicate verbatim into `env.test`** (wrangler envs do not inherit) |

### 3.4 Weekly aggregation — a query, not an artifact

The Sunday rider emits one `reporting.week.closed` per child that was active in the last 7 days, with
`eventId = {childId}:{weekStart}` — a re-run of the rider is a no-op at the consumer, by construction.

**No report table, no report API, no stored artifact.**

**Aggregate with `GROUP BY`, never per child.** D1 allows **1,000 queries per Worker invocation**, so
two queries per child dies at ~500 children. The rider issues a fixed number of queries regardless of
population:

```sql
-- one pass, not one query per child
SELECT child_id, COUNT(*) AS lessons FROM child_lesson_log
 WHERE completed_at >= ?1 GROUP BY child_id;

SELECT child_id, COUNT(*) AS stars FROM child_challenge_awards
 WHERE awarded_at >= ?1 GROUP BY child_id;
```

Join the two result sets in memory and fan out **onto `NOTI_WEEKLY_QUEUE`** (§5.3). The weekly cron runs
on a ≥ 1 h interval so it gets the **15-minute CPU** budget rather than 30 s — ample, but page the
`GROUP BY` reads by `child_id` if the population ever makes a single scan uncomfortable.
`src/index.ts:59-61` documents how the existing hourly riders account for their D1 query budget.

The events stay per-child (domain truth); folding a multi-child parent's events into **one weekly
digest push** is rendering, and happens consumer-side (§4.5).

### 3.5 OPTIONAL — publish outbox (deferred hardening)

> **Not built in v1.** Documented so the upgrade is a known quantity rather than a redesign.

Direct send (§3.1) loses events when `queue.send()` fails. The outbox closes that hole by writing the
event **in the same commit** as the domain data, so "lesson recorded" and "notification owed" can never
disagree, then draining separately with retries.

**Add it when any of these becomes true:**

- The `NOTI_METRICS` publish-failure counter (§3.2) shows a non-trivial drop rate.
- A notification type carries information available nowhere else (account, safety, payment, deadline).
- A notification type joins the contract whose loss is a correctness bug rather than a missed nicety
  (deletion already solved this for itself via §3.6 — the outbox is the answer if a *second* such type
  appears outside the deletion pipeline).

**What it involves** — migration `0027_notification_outbox.sql`:

```sql
CREATE TABLE notification_outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- global publish cursor
  event_id     TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  published_at TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_notification_outbox_unpublished
  ON notification_outbox (id) WHERE published_at IS NULL;
```

`AUTOINCREMENT` is load-bearing: `learning_events` has **no globally monotonic insert key** (`event_id`
is a UUIDv7 PK, and rows land out of order as different child DOs drain their own outboxes), so the
publish cursor cannot be derived from the ledger.

Then:

- `enqueueNotificationEvents(stmts, events)` — appends outbox INSERTs into **`commitFold`'s single
  batch**: the whole fold is one 9-statement `session.batch()` at
  `src/datastore/d1/learner-projection.ts:583`, documented *"never decomposed"* — there is exactly one
  seam, not one per row kind. Appending statements to that batch honours the CLAUDE.md rule *"one
  datastore function owns one complete batch"*. Kysely's vendored dialect **throws** on transactions
  (`src/datastore/d1/kysely-d1.ts:124`) — `batch` is the only atomic primitive available.
- `publishPending(env, {limit})` replaces `publishEvents` at the `waitUntil` call site: reads unpublished
  by `id ASC`, sends, stamps `published_at`, increments `attempts` on throw. The stored `payload_json`
  carries the derived `eventId` (§2), so the inline drain and the cron backstop publishing the same row
  concurrently is a consumer-side no-op, not a duplicate push.
- New rider on the hourly cron `"0 * * * *"` in `src/index.ts` — the backstop that drains whatever the
  inline publish missed.

Model the drain on `drainKgOutbox` (`src/datastore/d1/kg-project.ts:123`) — same
`KG_OUTBOX_MAX_ATTEMPTS = 5` pattern, same "hourly cron + weekly full-sweep backstop" cadence.
robo-worker already runs two outboxes (`course_outbox` in DO SQLite, `kg_projection_outbox` in D1); this
would be the third, and should look like them.

**The consumer side does not change.** tuni-noti's inbox (§4.4) is required either way — Queues is
at-least-once, so duplicates arrive regardless of how the producer publishes.

### 3.6 `identity.child.deleted` — durable by construction (v1, not deferred)

Child deletion is already an irreversible multi-stage durable pipeline
(`src/services/course/runtime/deletion.ts`, stages `requested → … → receipt`) with its own persistence
and retry machinery. Emitting the notification event as a **stage of that pipeline** gives outbox
semantics with no new table:

- A `noti_emitted` stage runs before `receipt`.
- It **awaits** `queue.send()` and propagates failure into the pipeline's retry machinery — this is the
  one producer site that must *not* catch-and-swallow.
- `eventId = {childId}:deleted` — deterministic, so a crash after Queue acceptance but before the stage
  is marked complete republishes harmlessly; the consumer inbox dedupes it.

---

## 4. Consumer — the tuni-noti service

### 4.1 Stack

A Queues **push consumer must be a Worker**, so the transport decision picks the runtime. Beyond that,
mirroring robo-worker buys one set of conventions, one CI shape, one deploy protocol — and a copy-in list
that supplies most of the boring infrastructure pre-debugged. Match robo-worker's versions.

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| HTTP | Hono ^4.12 |
| Validation | **arktype ^2.2 — never zod** (house mandate) |
| DB | D1 (`tuni-noti-d1`), ~9 small tables |
| Query builder | Kysely ^0.28 + vendored `kysely-d1.ts` |
| Tests | `@cloudflare/vitest-pool-workers`, real D1 in workerd |
| Lint/format | Biome only — 2-space, double quotes, 120 cols |
| Packages | pnpm |
| FCM | hand-rolled HTTP v1 (§4.6) |
| Metrics | Workers Analytics Engine binding (`NOTI_METRICS`) — publish failures, sends, suppressions, token invalidations, DLQ arrivals |
| Deploy | `scripts/deploy.sh` 0 % canary + `check-startup.mjs` 300 ms gate |

**Deliberate deviations from robo-worker:**

- **No Durable Objects.** Coalescing *is* per-child concurrent state (the original draft's "no
  per-entity concurrency requirement" was wrong), but it does not need a DO: every consumer effect is an
  idempotent append and every flush is an exact-set delete, so D1's implicit-transaction `batch()` is
  enough (§4.4, §4.5). Avoids a DO class and migration tags.
- **No lazy-load boundary.** robo-worker's dynamic-import gymnastics in `src/index.ts` exist to dodge
  deploy-validator error 10021 on a large dependency graph. Import statically here; keep the
  `check:deploy` tripwire and add the boundary only if it ever trips.
- **No `firebase-admin`.** A Node SDK pulling grpc and `node:crypto` — does not belong in a Worker.
- **No `.prettierrc`.** Dead config in robo-worker that contradicts Biome.

### 4.2 Copy-in from robo-worker (do not reinvent)

| File | Why |
|---|---|
| `src/arktype-config.ts` | 11 lines; without it arktype throws `EvalError` in the request phase |
| `src/hxxp/{error,validator,bearer}.ts` | the whole `AppError` + `validate()` contract, portable as-is |
| `src/datastore/d1/kysely-d1.ts` | vendored D1 dialect, zero project coupling |
| `src/utils/uuid.ts` | monotonic UUIDv7 |
| `src/fetch.ts` skeleton | middleware order, `appOnError`, `AppContext` shape (**not** `index.ts`'s lazy-load boundary — see §4.1) |
| `src/auth/{wif,jwt}.ts` | WIF access-token mint for FCM (§4.6). Note: `mintFreshAccessToken` is module-private in robo-worker — export it in the copy, or go through the caching wrapper |
| `vitest.config.mts`, `tests/setup.ts`, `biome.json`, `.editorconfig`, `tsconfig.json` | verbatim |
| `scripts/{deploy.sh,check-startup.mjs}` | canary deploy + 300 ms startup gate |

### 4.3 Schema (`tuni-noti-d1`)

| Table | Key columns |
|---|---|
| `inbox` | `event_id` PK, `type`, `state ∈ processed\|ignored`, `payload_json`, `received_at` — a **dedup record, not a lock** (§4.4) |
| `parents` | `parent_id` PK, `timezone` default `Asia/Ho_Chi_Minh`, `locale` default `vi-VN` |
| `children` | `child_id` PK, `parent_id`, `name`, `identity_updated_at`, `deleted_at` — **mirror, not source of truth**; `deleted_at` is a terminal tombstone, never cleared (§4.8) |
| `push_tokens` | `token` PK (**globally unique** — a handset that switches accounts is atomically reassigned, §4.7), `device_id` UNIQUE (opaque handle for the API), `parent_id`, `platform`, `last_seen_at`, `disabled_at` |
| `preferences` | `parent_id` PK, `progress_enabled`, `weekly_enabled`, `quiet_start`, `quiet_end`, `daily_cap` |
| `coalesce_events` | `event_id` PK, `child_id`, `parent_id`, `kind`, `payload_json`, `arrived_at` — **append-only membership**, one row per pending event (§4.5); index `(child_id, arrived_at)` |
| `notifications` | `id` (UUIDv7), `parent_id`, `child_id`, `kind`, `title`, `body`, `data_json`, `scheduled_for`, `state ∈ scheduled\|enqueued\|done\|deferred_quiet\|suppressed_cap\|suppressed_dark\|canceled`, `dedupe_key` UNIQUE |
| `deliveries` | `notification_id` + `token` composite PK, `state ∈ pending\|accepted\|failed\|canceled`, `attempts`, `fcm_message_name` — per-token, because a parent has many devices and partial failure must not resend to the ones that succeeded |
| `caps` | `(parent_id, local_date)` PK, `sent_count` — atomic daily-cap reservation (§4.5) |

### 4.4 Queue consumer — idempotent effects, one batch

The inbox is **not a lock and there is no claim protocol.** An earlier draft claimed via
`INSERT … ON CONFLICT DO NOTHING` then fell through on `state = 'received'` ("a prior attempt died —
retry"); review killed it: `received` cannot distinguish *crashed* from *still working*, so two
deliveries of one event could both process it. Leases would fix that — but leases solve a problem
created by separating the claim from the effect. Don't separate them:

```ts
// The consumer's ENTIRE effect for a delivery batch is one d1.batch() —
// D1 batches execute as an implicit transaction, and every statement is
// INSERT OR IGNORE or a conditional UPDATE, so replays and concurrent
// duplicate deliveries no-op instead of racing:
//
//   for each event in the batch:
//     INSERT OR IGNORE inbox   (event_id, type, state, payload, …)
//     INSERT OR IGNORE coalesce_events (event_id, child_id, kind, payload, …)   // learning.*
//     conditional identity upsert / tombstone write (§4.8)                      // identity.*
//
// Crash before commit → nothing happened → queue redelivery re-runs the same
// batch to the same result. Crash after commit → redelivery no-ops row by row.
```

- An event's inbox row and its effect commit **atomically or not at all** — the "insert, crash before
  effect, duplicate dropped forever" hole cannot open.
- An unknown `type` from a newer producer → `state = 'ignored'` row in the same batch + a metric,
  **never** retried into the DLQ.
- **No FCM call and no queue send happens on this path.** Sends belong to the flush cron and the send
  consumer (§4.5).
- **One `batch()` per delivery batch** (up to 100 messages), not per message: D1 executes queries
  sequentially and up to 250 consumer invocations share one database — per-message round trips are
  precisely the contention pattern D1 handles worst.

**Retention: prune `inbox` to 30 days.** Queue retention is configurable up to 14 days and DLQ/operator
replay can happen after that; the earlier 7-day figure did not outlive every legal redelivery. At the
volumes in §5.2 this is ~900k rows — nowhere near the ceiling.

Queue config: `max_retries: 3` plus a dead-letter queue, both declared in `wrangler.jsonc`. DLQ depth is
a metric with an alert, and replay is a deliberate operator action — replayed messages land on the same
idempotent path, so replay is always safe.

### 4.5 Coalescing, quiet hours, caps — v1, not v2

A single 10-minute session can fire `lesson.completed` + `challenge.achieved` + `star.awarded`. Three
pushes for one sitting, often while the parent is in the same room, is how a service gets muted in
week two. So:

1. **Learning events do not send directly** — the consumer appends them to `coalesce_events` (§4.4).
   A child's window is *derived*, not stored: due when the newest membership row is ≥ 10 min old, or
   the **oldest is ≥ 30 min old** (the hard cap — without it a busy session postpones its push
   indefinitely).
2. **A `* * * * *` cron flushes due windows.** For each due child it reads the exact membership set
   `S`, renders one notification, then commits **one batch**:
   - `INSERT OR IGNORE notifications (…, dedupe_key = '{childId}:{min(event_id in S)}')`
   - `DELETE FROM coalesce_events WHERE event_id IN (S…) AND EXISTS
     (SELECT 1 FROM notifications WHERE id = {this invocation's notification id})`
   The guarded delete is what makes overlapping cron ticks safe: the loser's INSERT hits the UNIQUE
   `dedupe_key` and no-ops, so its own notification id does not exist, so its DELETE removes nothing —
   membership it read stays put for the next tick. An event that arrives mid-flush is a new row not in
   `S`; it survives the delete and seeds the next window. No lease, no version column, no `flushing`
   state. (Chunk the `IN` list across statements in the same batch if it ever nears SQLite bind limits.)
3. **Preference gates run at flush, with defined outcomes** — "suppressed rows are marked" is not a
   semantics:
   - quiet hours (parent's **local** timezone) → `deferred_quiet`, `scheduled_for` = quiet-end; the
     morning flush folds multiple deferred rows for one parent into one catch-up push;
   - daily cap → terminal `suppressed_cap`, never delivered later. The cap counts **logical
     notifications, not device deliveries**, and is reserved atomically: conditional
     `UPDATE caps SET sent_count = sent_count + 1 WHERE sent_count < daily_cap`, inspect
     `meta.changes`. Weekly digests bypass the cap (they are one per week by construction);
   - `PUSH_ENABLED = false` (dark rollout, §8) → terminal `suppressed_dark`, decided **at send time** —
     flipping the flag on must not release days of accumulated backlog.
4. **The cron enqueues; it never sends.** Due rows go onto the internal `SEND_QUEUE` via `sendBatch`
   (100 per subrequest) and are marked `enqueued`; a queue consumer performs the FCM calls. This is a
   scale requirement, not a style preference — see §5.1. The notification row doubles as the internal
   outbox: a sweeper on the hourly cron re-enqueues `scheduled` rows that never made it to `enqueued`
   (crash between commit and `sendBatch`).
5. **Weekly digest is per parent.** `reporting.week.closed` events are per child (§3.4); the flush
   groups a parent's children into **one** digest push (`dedupe_key = '{parentId}:{weekStart}'`) instead
   of pushing a three-child parent three times.

> The "queue carries domain events, not notification jobs" principle governs the **inter-service**
> boundary (robo-worker → tuni-noti). `SEND_QUEUE` is internal to tuni-noti and deliberately *does*
> carry jobs, with its own lower `max_retries`. **Delivery is at-least-once — say so.** A crash between
> "FCM accepted" and "delivery row updated" resends on redelivery; no D1 state machine can atomically
> commit with an external HTTP call. The `deliveries` table (per token, conditional
> `pending → accepted` transitions) prevents *systematic* duplicates — a redelivered job skips tokens
> already `accepted` — and the deterministic notification id + Android collapse key (§4.6) bound the
> *visible* cost of the crash window to a replaced notification rather than a stacked one.

Copy is **vi-VN**, rendered at flush from the identity mirror (fallback: the envelope's denormalized
name if the mirror has no row yet — §4.8). robo-worker has no timezone or locale column on `parents` —
tuni-noti owns both, defaulting to `Asia/Ho_Chi_Minh` / `vi-VN`.

### 4.6 FCM delivery

HTTP v1 (`/v1/projects/{id}/messages:send`), one call per token — there is no batch endpoint.

**Send loop:** a send consumer walks its batch with a **6-slot semaphore** (the simultaneous-connection
limit applies to *every* invocation, consumers included — never `Promise.all()` a 100-message batch).

**Token lifecycle — disable on evidence, not on status code:**

- `UNREGISTERED` / `NOT_FOUND` → stamp `disabled_at`, never retry.
- `INVALID_ARGUMENT` → **inspect the structured error detail.** It means "dead token" only when the
  detail names the registration token; otherwise it means *our payload is malformed*, and disabling the
  token would silently unsubscribe a healthy device to mask our own bug. Payload-shaped
  `INVALID_ARGUMENT` → `failed` + alert.
- `SENDER_ID_MISMATCH` → disable + alert (configuration drift, not token churn).
- `429` / `5xx` / timeout → retry with backoff, honouring `Retry-After`. A timeout is **ambiguous** —
  FCM may have accepted it; the collapse key is what makes the retry cosmetically safe.
- FCM 200 means **accepted by FCM, not delivered to the handset**. The delivery state is `accepted`
  (store the returned message name for correlation); nothing in this system may claim "delivered".

**Message shape:** deterministic notification id in the `data` payload (the app's dedupe handle), an
Android **collapse key / tag per child** (a newer progress push replaces a stale one on the lock screen
rather than stacking), explicit TTL (a progress push older than a few hours is noise — let it expire),
a named Android notification channel (parents mute channels, not apps), and a **versioned deep-link
contract** agreed with the app team. Lock-screen copy keeps child details minimal.

**Auth — WIF, no Google API key.** `mintFreshAccessToken()` (robo-worker `src/auth/wif.ts:200-249`)
already implements exactly the flow FCM needs and returns an **access token**: self-signed ES256 JWT →
STS token-exchange → `iamcredentials…:generateAccessToken`, with per-SA caching, in-flight dedup, and its
own mint timeout. Work required:

1. Copy `src/auth/{wif,jwt}.ts` (export `mintFreshAccessToken` — it is module-private upstream).
2. Make `scope` a parameter — it is a single constant at `wif.ts:233`
   (`{ scope: [SCOPE], lifetime: "3600s" }`). FCM needs
   `https://www.googleapis.com/auth/firebase.messaging`.
3. Point the impersonated SA at a new dedicated `tuni-noti@` service account — do **not** reuse the
   bridge SA; separate blast radius.
4. Serve `/auth/jwks` via `getPublicJwk()`, and set `WIF_ISSUER` to tuni-noti's own Worker URL.
5. **GCP one-time setup** (the real cost — console work, not code): register a WIF **provider** whose
   issuer is tuni-noti's URL (an existing pool can host it; robo-worker's *provider* cannot be shared,
   because a provider verifies self-signed JWTs against the JWKS served at its configured issuer). Add
   an attribute condition pinning the assertion's `sub`/audience so arbitrary tokens from the issuer
   cannot impersonate the SA. Then create the SA, grant it only the FCM send permission
   (`cloudmessaging.messages.create`), and bind the WIF principal with the narrowest impersonation
   grant that permits `generateAccessToken` — prefer `roles/iam.workloadIdentityUser` over the broader
   `roles/iam.serviceAccountTokenCreator` (which also grants signing).

> `WIF_PRIVATE_KEY` is still a long-lived secret — WIF is **not** "keyless". The gain is blast radius and
> revocation: the ECDSA key is useless outside your provider, yields only a 1-hour scoped token, and is
> killed by dropping one IAM binding rather than rotating a Google credential.

### 4.7 Parent API

Validates robo-worker's parent JWT as **ES256 via JWKS** (§1.4) — same `aud: "robo-worker/parent"`,
cached JWKS fetch, strict `alg`/`iss`/`aud` pinning. tuni-noti holds no signing material.

| Route | Notes |
|---|---|
| `POST /v1/me/devices` | `{token, platform, appVersion}` — returns an opaque `deviceId`. Upserts by **token** (globally unique): a handset re-registered under a different parent is atomically reassigned, so the previous parent stops receiving this device's pushes. Refreshes `last_seen_at`; lazily creates the `parents` row from `sub`. Rate-limited — it is an unauthenticated-adjacent write amplifier otherwise |
| `DELETE /v1/me/devices/:deviceId` | on sign-out. The **opaque id**, never the raw FCM token — tokens in URL paths leak into access logs |
| `GET` / `PATCH /v1/me/preferences` | toggles, quiet hours, timezone |
| `GET /healthz` | `{ok, versionId}` from `CF_VERSION_METADATA`, `?deep=1` variant per robo-worker |

App-team handoff: sessions are 24 h with **no refresh**, so the app will hit 401 routinely — it
re-authenticates silently and **retries the failed call**; token registration is separate (register on
login and on FCM `onNewToken`, not after every 401).

### 4.8 Identity — bootstrap, renames, tombstones

Queues are **unordered**: `learning.lesson.completed` can arrive before any `identity.child.upserted`,
a rename can arrive after a newer rename, and a delete can arrive before an older upsert. The rules,
all required:

1. `subject.childName` is denormalized into every envelope — rendering prefers the mirror (fresh, handles
   renames) and falls back to the envelope name when the mirror has no row yet. An event is never
   unrenderable.
2. `identity.child.upserted` applies with **last-write-wins guarded by `identity_updated_at`**
   (conditional `UPDATE … WHERE identity_updated_at <= ?`): a delayed older rename cannot regress a
   newer name.
3. **`deleted_at` is a terminal tombstone.** Upserts never clear it (child deletion is irreversible in
   robo-worker, and child IDs are UUIDs — never reused). A late `learning.*` or `reporting.*` event for
   a tombstoned child → inbox `ignored`.
4. **Deletion cancels in-flight work in the same batch that sets the tombstone:** pending
   `coalesce_events` rows, `scheduled`/`deferred_quiet` notifications, and `pending` deliveries for that
   child flip to `canceled`. The send consumer re-checks the tombstone immediately before each FCM call —
   a job already sitting in `SEND_QUEUE` must not push for a deleted child. Deletion purges the child's
   mirror row and notification history; it does **not** touch the parent's `push_tokens` — tokens are
   parent-scoped and serve their other children.
5. **One-time backfill** at launch: an admin-gated robo-worker route replays `identity.child.upserted`
   for every child with `parent_id IS NOT NULL` (`parent_id IS NULL` = test/legacy child, must be
   excluded).

---

## 5. Scale

Platform ceilings as of 2026-08, verified against current Cloudflare docs. Recorded so nobody has to
re-derive them.

| Limit | Value | Where it bites |
|---|---|---|
| **Simultaneous outgoing connections per invocation** | **6** (awaiting response headers) | **FCM fan-out — the binding constraint.** Applies per invocation of *any* handler — send consumers need a 6-slot semaphore too (§4.6) |
| Queue throughput | 5,000 msg/s per queue, 25 GB backlog | not a concern |
| Queue consumer concurrency | **250** concurrent invocations, auto-scaled | the escape hatch from the 6-connection limit — a configured *maximum*, not a guarantee; error rate and backoff shrink it |
| Queue batch | 100 messages / 256 KB | one `sendBatch` subrequest per 100 |
| Consumer invocation | 15 min wall / 5 min CPU (default 30 s) | generous |
| Cron CPU | 30 s (< 1 h interval) · 15 min (≥ 1 h) | the 1-min flush cron gets 30 s; the weekly rider gets 15 min |
| Subrequests per invocation | 10,000 (Paid) | headroom, not a fan-out target — connections, CPU and queue throughput bind first |
| **D1 queries per invocation** | **1,000** | kills any per-child query loop. Batched statements each count — `batch()` buys atomicity and round trips, not allowance |
| D1 max database size | **10 GB** | kills unbounded `inbox` / `notifications`; indexes and SQLite overhead mean raw payload arithmetic is optimistic |
| D1 execution | sequential, single-threaded per DB | 250 consumers contend on one DB — batch your writes; load-test the real schema before trusting any writes/s figure |

### 5.1 The binding constraint

A Worker invocation may have only **6 connections waiting on response headers** at once. FCM HTTP v1 is
**one request per token** — there is no batch send endpoint — so a component that sends N pushes from a
single invocation throttles to roughly tens per second, with no horizontal scaling.

A **cron trigger is one invocation.** Therefore the flush cron must never call FCM (§4.5 step 4). It
enqueues; queue consumers send. Consumers auto-scale toward 250 invocations, each with its own connection
budget — orders of magnitude more fan-out for what is essentially a moved function call.

Sizing at ~1 coalesced push per session, Vietnamese after-school peak:

| Active children | Peak pushes/min | Cron sends directly | Consumers send |
|---|---|---|---|
| 10,000 | ~100 | fine | fine |
| 100,000 | ~1,000 | marginal | fine |
| 1,000,000 | ~10,000 | **breaks** | fine |

The design is built the second way from the start, because retrofitting it means re-testing every
delivery path.

### 5.2 Retention is a correctness requirement, not housekeeping

D1 caps at **10 GB per database**, and the failure mode is the whole service, not just old rows.

| Table | Growth | Policy |
|---|---|---|
| `inbox` | 1 row per event, forever | **prune to 30 days** — must outlive queue retention (configurable to 14 d) *plus* DLQ replay (§4.4) |
| `notifications` + `deliveries` | 1 row per push / per token | **prune to 90 days** |
| `coalesce_events` | transient | deleted on flush; sweep rows older than the 30-min window cap |
| `caps` | 1 row per parent per active day | prune with `notifications` |
| `parents`, `children`, `push_tokens`, `preferences` | bounded by user count | no policy needed |

At 30k events/day with ~500-byte payloads, an unpruned `inbox` reaches the cap in under two years. A
30-day window holds it at ~900k rows. All sweeps ride the same hourly cron.

### 5.3 The Sunday fan-out gets its own queue

`reporting.week.closed` fires for every active child at once (03:00 UTC = 10:00 Vietnam — a live traffic
window). On a shared queue those messages compete with real-time progress events for consumer capacity,
retry budget, and D1 write bandwidth — and a poison weekly batch would share a DLQ with the real-time
path.

Separating queues at design time costs one binding and one consumer entry; separating them after launch
means re-testing every delivery path. So: **`NOTI_WEEKLY_QUEUE`**, its own consumer with lower
concurrency, its own retry policy and DLQ. The weekly rider paces its fan-out across the 15-minute CPU
budget rather than dumping the population in one burst. **Do not** solve burst pressure by shrinking the
batch — that just moves the queueing.

---

## 6. Implementation order

1. **This document** — `docs/design.md`, kept current as the service evolves.
2. **Walking skeleton** — GCP topology + one real push (§7.0). Blocks everything else.
3. **Auth migration** (robo-worker, §1.4) — ES256 parent sessions + dual verification. Independent of
   the skeleton; must land before step 6 ships to real parents.
4. **Scaffold** — `package.json`, `wrangler.jsonc`, copy-in list (§4.2), migrations, `/healthz`.
5. **Event contract** — `src/events/v1.ts` + golden fixtures + pinned-SHA CI + `docs/events/v1.md` (§2).
6. **Consumer** — inbox (§4.4), identity mirror (§4.8), coalescing (§4.5), FCM client (§4.6).
7. **Parent API** — devices + preferences (§4.7).
8. **Producer** — robo-worker publisher, wiring, deletion stage, weekly rider (§3).
9. **Backfill + rollout** — identity replay (§4.8), then ship dark behind `PUSH_ENABLED` (§8).

Steps 6–7 and step 8 are independent once the contract (5) is frozen, so they can proceed in parallel.

---

## 7. Verification

0. **Walking skeleton (do first).** The code path is proven, but the **GCP topology is not** — a second
   WIF provider, a new SA, and FCM role bindings have never been exercised together. Stand up the
   provider + SA, deploy a stub Worker serving `/auth/jwks`, mint an FCM access token through the copied
   `wif.ts`, and send one message to a real dev handset. Nothing else gets built until a push arrives.
1. **`pnpm vitest run` (tuni-noti)** — real D1 in workerd via `applyD1Migrations`. Cover:
   - concurrent duplicate delivery of one event → one membership row, one inbox row (idempotent batch);
   - crash-replay: re-running a committed batch is a row-by-row no-op;
   - unknown event type → `ignored`, never DLQ;
   - coalescing merges 3 events into 1 push; an event arriving mid-flush survives into the next window;
   - **overlapping cron flushes** of the same due set → exactly one notification (dedupe_key + guarded
     delete: the loser deletes nothing);
   - 30-min window cap fires for a continuously active session;
   - quiet hours → `deferred_quiet` and delivery at quiet-end; daily cap → terminal `suppressed_cap`,
     reserved atomically under concurrency; weekly digest bypasses the cap;
   - `PUSH_ENABLED` off marks `suppressed_dark` at send time; flipping it on releases nothing;
   - `UNREGISTERED` disables the token; **payload-shaped `INVALID_ARGUMENT` does not**;
   - re-registering a token under a second parent atomically detaches it from the first;
   - `identity.child.deleted` tombstones the mirror, cancels pending coalesce rows / notifications /
     deliveries, purges child history — and **leaves the parent's tokens intact**; a late upsert does
     not resurrect the child; a late learning event is `ignored`;
   - rename LWW: a delayed older `identity.child.upserted` cannot regress a newer name.
2. **`pnpm vitest run` (robo-worker)** — `buildNotificationEvents` maps `commitFold` projected outputs
   to the contract with **stable derived `eventId`s** (pure, no bindings — same fold twice ⇒ identical
   events); **a throwing `NOTI_QUEUE` does not fail the lesson fold** (§3.2) but increments the metric;
   the deletion stage propagates queue failure into pipeline retry (§3.6); weekly aggregate counts match
   seeded fixtures and re-running the rider emits identical `eventId`s.
3. **Contract test** — golden + negative fixtures per event type, asserted by both repos against the
   pinned SHA (§2), so producer and consumer cannot drift silently.
4. **End-to-end on dev** — seed a child → drive a lesson to completion via the existing e2e harness
   (`pnpm test:e2e`) → assert a queue delivery, an `inbox` row, a `notifications` row, a `deliveries`
   row, and a real push on a dev handset. A `POST /v1/_test/emit` gated by `E2E_ENABLED` lets this run
   without the robot in the loop.
5. **Gates before merge** (robo-worker's de-facto DoD): `type-check` 0 · `biome` clean · `check:deploy`
   under the 300 ms startup ceiling · full vitest green in both repos.
6. **Deploy order** — D1 migrations first, then the Worker (the old Worker never touches the new tables,
   so there is no risky window). Ship tuni-noti **consuming** before robo-worker starts **producing**.

---

## 8. Rollout

Ship dark: the producer emits, the consumer processes and writes `notifications` rows, but the send path
marks every due row `suppressed_dark` while `PUSH_ENABLED` is off (§4.5 — decided at send time, so
enabling the flag releases nothing retroactively). Verify volume and coalescing against real traffic for
a few days — this is the only honest way to size notification fatigue — then enable it for internal
parents first.

---

## 9. Out of scope for v1

- **iOS / APNs** — permission flows, APNs config, platform payload fields, foreground/background
  behaviour, token-lifecycle differences. Real platform work, not a schema column (§1.3).
- **Other channels** — email, Zalo, in-app inbox.
- **Delivery receipts / read tracking** — v1 knows "accepted by FCM", nothing further (§4.6).
- **Per-child notification preferences** — v1 preferences are per parent.
- **Parent account deletion** — `identity.parent.deleted` is in the contract but has no producer
  (§1.5); wire it when robo-worker grows account deletion.
- **Localization beyond `vi-VN`** — the column exists; the copy does not.
- **Campaign / marketing pushes** — this service carries progress moments only. Anything else needs its
  own consent model and is a different design.
