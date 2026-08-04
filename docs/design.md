# tuni-noti — Parent Notification Service

**Status:** design, not yet implemented.

---
có t 
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
          ctx.waitUntil(publishEvents)   ← direct send, fire-and-forget
                                            (no outbox in v1 — see §3.1, §3.5)
                          │
                          ▼
                  Cloudflare Queue  (at-least-once, unordered)
                          │
                          ▼
                     tuni-noti
        ┌──────────────────────────────────────┐
        │ inbox            (idempotency)       │
        │ identity mirror  (names, links)      │
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
| Channel (v1) | FCM push, Android only (iOS later — no code change beyond a `platform` column) |
| Coupling | Fully separate Worker. tuni-noti never reads robo-worker's D1. |
| Transport | Cloudflare Queues, versioned domain events |
| Triggers | Progress moments + weekly nudge |
| Weekly report | **No new report artifact.** Sunday cron emits summary *numbers*; the push deep-links to the analytics screen the app already has |
| Publish path | Inline `ctx.waitUntil(queue.send)`, **no producer outbox in v1** — a dropped push is tolerable, the learning data is already durable. Outbox specced as deferred hardening (§3.5) |
| Identity | Denormalized in every envelope **and** mirrored via identity events |
| Stack | Mirror robo-worker: Worker + Hono + arktype + Kysely/D1 + Biome + vitest-pool-workers |
| FCM credentials | **WIF** — copy `src/auth/wif.ts`, parameterize scope. No Google API key held. |
| Event contract | Copy-in arktype module + golden JSON fixtures asserted by both repos |

### 1.4 Assumptions (flagged, not blocking)

- **Auth:** tuni-noti validates robo-worker's existing parent JWT by sharing `PARENT_SESSION_SECRET`
  (HS256, `aud: "robo-worker/parent"`). Migrating to asymmetric + JWKS would remove the shared secret but
  breaks live 24 h sessions unless dual-signed — deferred.
- `identity.parent.deleted` is defined in the contract but has **no producer**: robo-worker has no
  account deletion (`docs/parent-app-api.md:110`). Child deletion does exist and is wired.
- Both services are on Workers Paid (DOs / Workflows / Vectorize require it), so Queues is included:
  1 M operations/month free, then $0.40/M. Cost is not a factor.

---

## 2. The event contract

Owned by tuni-noti, published as `docs/events/v1.md`. The arktype schemas live in `src/events/v1.ts` and
are **copied verbatim** into robo-worker, alongside a shared set of golden JSON fixtures
(`tests/fixtures/events/*.json`) that **both repos assert against in CI** — that fixture set, not the
type system, is what catches drift across two separate repos.

Additive-only within a major; consumers ignore unknown fields.

```jsonc
{
  "specVersion": "1.0",
  "eventId":     "0192f3a1-…",        // UUIDv7 — the idempotency key
  "type":        "learning.lesson.completed",
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

| Type | `data` | Producer site (robo-worker) |
|---|---|---|
| `identity.child.upserted` | `{name, age, stage}` | `src/routes/parent.ts:97,118` + placement finalize |
| `identity.child.deleted` | `{}` | deletion pipeline, before the `receipt` stage |
| `learning.lesson.completed` | `{courseId, lessonId, outcome, durationS}` | ledger fold |
| `learning.challenge.achieved` | `{courseId, challengeId, firstTime}` | ledger fold |
| `learning.star.awarded` | `{courseId, challengeId, totalStars}` | ledger fold |
| `reporting.week.closed` | `{weekStart, weekEnd, lessons, stars, missionsAchieved}` | Sunday cron |

`outcome ∈ achieved | almost | practice_more` — reuse `deriveMissionOutcome()`
(`src/services/course/runtime/events.ts:454`).

> **Invariant D4** (`src/services/course/parent-analytics.ts:9-12`): lesson result labels derive
> **solely** from the Mission Can-do outcome, never from score. Notification copy must respect this.

> **Naming:** `reporting.week.closed`, not `WeeklyReportReady` — the queue carries *domain events*, not
> notification jobs. "Go tell people" is tuni-noti's decision to make, not robo-worker's.

---

## 3. Producer — robo-worker changes

> "Separate service" ≠ "no robo-worker changes." This is real work in the main worker.

### 3.1 Publishing — direct send (v1)

**v1 publishes directly to the queue, with no producer-side outbox.**

```ts
// after the ledger fold commits
ctx.waitUntil(publishEvents(env, buildNotificationEvents(folded)));
```

**The tradeoff, stated plainly:** if `queue.send()` throws — or the isolate dies before `waitUntil`
settles — that notification is **lost silently**. There is no retry and no record that it should have
existed.

This is acceptable for v1 because a notification is not a system of record. The learning data is already
durably committed in `learning_events`; only the *telling* is lost. A parent misses one "An earned a
star" push and the app still shows the star on next open. Nothing needs reconciling.

It stops being acceptable the moment a notification carries information available nowhere else — an
account or safety notice, a payment failure, anything with a deadline. See §3.5 before adding one.

### 3.2 `src/services/notifications/publisher.ts`

- `buildNotificationEvents(folded)` — pure; ledger events → domain events. Unit-testable with no bindings.
- `publishEvents(env, events)` — `env.NOTI_QUEUE.sendBatch()` (≤ 100 msgs / 256 KB per batch).
  **Must never throw into the caller** — catch, `console.error` with the `[notifications]` prefix, and
  swallow. A failed push must never fail a lesson fold.

Keep `buildNotificationEvents` separate from `publishEvents`. That seam is what makes §3.5 a
one-file change later, and it is where the golden-fixture contract tests attach.

### 3.3 Wiring

| Where | Change |
|---|---|
| projector drain call site | `ctx.waitUntil(publishEvents(env, …))` after the fold commits |
| `src/index.ts` weekly cron `"0 3 * * SUN"` | new rider: weekly aggregate fan-out (§3.4) |
| `src/routes/parent.ts:97,118` + `updateChildStage()` (`src/datastore/d1/children.ts:19`) | emit `identity.child.upserted` |
| `src/services/course/runtime/deletion.ts` | emit `identity.child.deleted` before the `receipt` stage |
| `wrangler.jsonc` | queue **producer** binding `NOTI_QUEUE`; **duplicate verbatim into `env.test`** (wrangler envs do not inherit) |

### 3.4 Weekly aggregation — a query, not an artifact

The Sunday rider emits one `reporting.week.closed` per child that was active in the last 7 days.

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

Join the two result sets in memory and fan out. The weekly cron runs on a ≥ 1 h interval so it gets the
**15-minute CPU** budget rather than 30 s — ample, but page the `GROUP BY` reads by `child_id` if the
population ever makes a single scan uncomfortable. `src/index.ts:66` documents how the existing riders
account for their D1 budget.

### 3.5 OPTIONAL — publish outbox (deferred hardening)

> **Not built in v1.** Documented so the upgrade is a known quantity rather than a redesign.

Direct send (§3.1) loses events when `queue.send()` fails. The outbox closes that hole by writing the
event **in the same commit** as the domain data, so "lesson recorded" and "notification owed" can never
disagree, then draining separately with retries.

**Add it when any of these becomes true:**

- `[notifications] publish failed` shows up in production logs at a non-trivial rate.
- A notification type carries information available nowhere else (account, safety, payment, deadline).
- Someone asks "how many pushes did we drop last week?" and the honest answer is "unknowable."

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

- `enqueueNotificationEvents(stmts, events)` — appends outbox INSERTs **into the caller's existing
  `d1.batch()`** at `src/datastore/d1/learner-projection.ts` (~`:326` challenge summary, `:352` awards,
  lesson fold), honouring the CLAUDE.md rule *"one datastore function owns one complete `d1.batch()`"*.
  Kysely's vendored dialect **throws** on transactions (`src/datastore/d1/kysely-d1.ts:124`) — `batch` is
  the only atomic primitive available.
- `publishPending(env, {limit})` replaces `publishEvents` at the `waitUntil` call site: reads unpublished
  by `id ASC`, sends, stamps `published_at`, increments `attempts` on throw.
- New rider on the hourly cron `"0 * * * *"` in `src/index.ts` — the backstop that drains whatever the
  inline publish missed.

Model the drain on `drainKgOutbox` (`src/datastore/d1/kg-project.ts`) — same `MAX_ATTEMPTS = 5`, same
"hourly cron + weekly full-sweep backstop" cadence. robo-worker already runs two outboxes
(`course_outbox` in DO SQLite, `kg_projection_outbox` in D1); this would be the third, and should look
like them.

**The consumer side does not change.** tuni-noti's inbox (§4.4) is required either way — Queues is
at-least-once, so duplicates arrive regardless of how the producer publishes.

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
| DB | D1 (`tuni-noti-d1`), ~7 small tables |
| Query builder | Kysely ^0.28 + vendored `kysely-d1.ts` |
| Tests | `@cloudflare/vitest-pool-workers`, real D1 in workerd |
| Lint/format | Biome only — 2-space, double quotes, 120 cols |
| Packages | pnpm |
| FCM | hand-rolled HTTP v1 (§4.6) |
| Deploy | `scripts/deploy.sh` 0 % canary + `check-startup.mjs` 300 ms gate |

**Deliberate deviations from robo-worker:**

- **No Durable Objects.** robo-worker needs them for per-child WebSocket sessions; tuni-noti has no
  per-entity concurrency requirement. Coalescing is a cron over a D1 table. Avoids DO migration tags.
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
| `src/auth/{wif,jwt}.ts` | WIF access-token mint for FCM (§4.6) |
| `vitest.config.mts`, `tests/setup.ts`, `biome.json`, `.editorconfig`, `tsconfig.json` | verbatim |
| `scripts/{deploy.sh,check-startup.mjs}` | canary deploy + 300 ms startup gate |

### 4.3 Schema (`tuni-noti-d1`)

| Table | Key columns |
|---|---|
| `inbox` | `event_id` PK, `type`, `state ∈ received\|processed\|failed\|ignored`, `attempts`, `payload_json`, `received_at` |
| `parents` | `parent_id` PK, `timezone` default `Asia/Ho_Chi_Minh`, `locale` default `vi-VN` |
| `children` | `child_id` PK, `parent_id`, `name`, `deleted_at` — **mirror, not source of truth** |
| `push_tokens` | `parent_id`, `token`, `platform`, `last_seen_at`, `disabled_at`, `UNIQUE(parent_id, token)` |
| `preferences` | `parent_id` PK, `progress_enabled`, `weekly_enabled`, `quiet_start`, `quiet_end`, `daily_cap` |
| `notifications` | `id` (UUIDv7), `parent_id`, `child_id`, `kind`, `title`, `body`, `data_json`, `scheduled_for`, `sent_at`, `state`, `dedupe_key` |
| `coalesce_windows` | `child_id` PK, `window_ends_at`, `pending_json` |

### 4.4 Queue consumer — the inbox, done correctly

The naive "insert eventId → exists? ignore" **permanently swallows events**: insert, crash before send,
and the retry sees a duplicate and drops it forever. Required shape:

```ts
// INSERT … ON CONFLICT DO NOTHING, then inspect changes() — never read-then-write
// (concurrent deliveries of the same message race).
const claimed = await claimInboxEvent(d1, event);   // meta.changes === 1 ⇒ we own it
if (!claimed) {
  const row = await readInbox(d1, event.eventId);
  if (row.state === "processed" || row.state === "ignored") return;  // true duplicate
  // state === 'received' ⇒ a prior attempt died mid-flight — fall through and retry
}
```

Only stamp `processed` **after** the notification row is durably scheduled. An unknown `type` from a
newer producer → `ignored` + log, **never** retried into the DLQ.

**Process the queue batch as a batch.** A consumer receives up to 100 messages. D1 executes queries
**sequentially** and up to 250 consumer invocations share one database — 100 individual INSERTs per
batch, multiplied across concurrent consumers, is precisely the contention pattern D1 handles worst. Use
one `d1.batch()` for the whole delivery batch, then inspect `meta.changes` per statement to learn which
events this consumer actually claimed.

**Retention: prune `inbox` to 7 days.** Unbounded, this table alone reaches D1's 10 GB ceiling — see §5.2.

Queue config: `max_retries: 3` plus a dead-letter queue, both declared in `wrangler.jsonc`.

### 4.5 Coalescing, quiet hours, caps — v1, not v2

A single 10-minute session can fire `lesson.completed` + `challenge.achieved` + `star.awarded`. Three
pushes for one sitting, often while the parent is in the same room, is how a service gets muted in
week two. So:

1. Learning events do **not** send directly — they merge into `coalesce_windows` for that child
   (10-minute window, extended by each new event).
2. A `* * * * *` cron flushes due windows into a single rendered `notifications` row.
   (Cron rather than a DO alarm: no new DO class, and 60 s is invisible against a 10-minute window.)
3. Before send: `preferences` → quiet hours in the parent's **local** timezone → `daily_cap`.
   Suppressed rows are marked, not deleted, so the behaviour stays auditable.
4. **The cron enqueues; it never sends.** Due rows go onto the internal `SEND_QUEUE` via `sendBatch`
   (100 per subrequest); a queue consumer performs the FCM calls. This is a scale requirement, not a
   style preference — see §5.1.

> The "queue carries domain events, not notification jobs" principle governs the **inter-service**
> boundary (robo-worker → tuni-noti). `SEND_QUEUE` is internal to tuni-noti and deliberately *does*
> carry jobs. It also wants its own retry policy: retrying a domain event is free, retrying an FCM send
> risks a duplicate push, so `max_retries` is lower and the `notifications.state` machine — not the
> queue — is the source of truth for "already sent".

Copy is **vi-VN**, rendered from the identity mirror. robo-worker has no timezone or locale column on
`parents` — tuni-noti owns both, defaulting to `Asia/Ho_Chi_Minh` / `vi-VN`.

### 4.6 FCM delivery

- HTTP v1 (`/v1/projects/{id}/messages:send`), one call per token.
- **Token lifecycle:** `UNREGISTERED` / `NOT_FOUND` / `INVALID_ARGUMENT` → stamp `disabled_at`, never
  retry. `429` / `5xx` → retry with backoff. Tokens rotate on reinstall; a parent has many devices.

**Auth — WIF, no Google API key.** `mintFreshAccessToken()` (robo-worker `src/auth/wif.ts:200-249`)
already implements exactly the flow FCM needs and returns an **access token**: self-signed ES256 JWT →
STS token-exchange → `iamcredentials…:generateAccessToken`, with per-SA caching, in-flight dedup, and its
own mint timeout. Work required:

1. Copy `src/auth/{wif,jwt}.ts`.
2. Make `scope` a parameter — it is a single constant at `wif.ts:233`
   (`{ scope: [SCOPE], lifetime: "3600s" }`). FCM needs
   `https://www.googleapis.com/auth/firebase.messaging`.
3. Point the impersonated SA at a new dedicated `tuni-noti@` service account — do **not** reuse the
   bridge SA; separate blast radius.
4. Serve `/auth/jwks` via `getPublicJwk()`, and set `WIF_ISSUER` to tuni-noti's own Worker URL.
5. **GCP one-time setup** (the real cost — console work, not code): register a WIF pool provider whose
   issuer is tuni-noti's URL. robo-worker's provider **cannot** be shared, because a provider verifies
   self-signed JWTs against the JWKS served at its configured issuer. Then create the SA, grant it an FCM
   send role, and grant the WIF principal `roles/iam.serviceAccountTokenCreator` on it.

> `WIF_PRIVATE_KEY` is still a long-lived secret — WIF is **not** "keyless". The gain is blast radius and
> revocation: the ECDSA key is useless outside your provider, yields only a 1-hour scoped token, and is
> killed by dropping one IAM binding rather than rotating a Google credential.

### 4.7 Parent API

Validates robo-worker's parent JWT (`aud: "robo-worker/parent"`) via a shared `PARENT_SESSION_SECRET`,
reusing the verification logic at robo-worker `src/auth/parent.ts:30-47`.

| Route | Notes |
|---|---|
| `POST /v1/me/devices` | `{token, platform, appVersion}` — upsert, refresh `last_seen_at`, lazily create the `parents` row from `sub` |
| `DELETE /v1/me/devices/:token` | on sign-out |
| `GET` / `PATCH /v1/me/preferences` | toggles, quiet hours, timezone |
| `GET /healthz` | `{ok, versionId}` from `CF_VERSION_METADATA`, `?deep=1` variant per robo-worker |

Parent sessions are 24 h with **no refresh**, so the app will hit 401 routinely and must re-register its
token after each silent re-login. This needs to be stated in the app-team handoff.

### 4.8 Identity bootstrap

Queues are **unordered**: `learning.lesson.completed` can arrive before any `identity.child.upserted`.
Three mitigations, all required:

1. `subject.childName` is denormalized into every envelope — the mirror is a *cache*, never a dependency.
2. `identity.child.upserted` keeps names fresh and handles renames.
3. **One-time backfill** at launch: an admin-gated robo-worker route replays `identity.child.upserted`
   for every child with `parent_id IS NOT NULL` (`parent_id IS NULL` = test/legacy child, must be
   excluded).

---

## 5. Scale

Platform ceilings as of 2026-08. Recorded so nobody has to re-derive them.

| Limit | Value | Where it bites |
|---|---|---|
| **Simultaneous outgoing connections per invocation** | **6** (awaiting response headers) | **FCM fan-out — the binding constraint** |
| Queue throughput | 5,000 msg/s per queue, 25 GB backlog | not a concern |
| Queue consumer concurrency | **250** concurrent invocations, auto-scaled | the escape hatch from the 6-connection limit |
| Queue batch | 100 messages / 256 KB | one `sendBatch` subrequest per 100 |
| Consumer invocation | 15 min wall / 5 min CPU (default 30 s) | generous |
| Cron CPU | 30 s (< 1 h interval) · 15 min (≥ 1 h) | the 1-min flush cron gets 30 s; the weekly rider gets 15 min |
| Subrequests per invocation | 10,000 (Paid) | ~1M queued messages per invocation |
| **D1 queries per invocation** | **1,000** | kills any per-child query loop |
| D1 max database size | **10 GB** | kills unbounded `inbox` / `notifications` |
| D1 execution | sequential, ~10 writes/s at 100 ms/write | 250 consumers contend on one DB — batch your writes |

### 5.1 The binding constraint

A Worker invocation may have only **6 connections waiting on response headers** at once. FCM HTTP v1 is
**one request per token** — there is no batch send endpoint — so a component that sends N pushes from a
single invocation throttles to roughly tens per second, with no horizontal scaling.

A **cron trigger is one invocation.** Therefore the flush cron must never call FCM (§4.5 step 4). It
enqueues; queue consumers send. Consumers auto-scale to 250 invocations, each with its own connection
budget — three orders of magnitude more fan-out for what is essentially a moved function call.

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
| `inbox` | 1 row per event, forever | **prune to 7 days** — long enough to outlive any redelivery |
| `notifications` | 1 row per push | **prune to 90 days** |
| `coalesce_windows` | transient | deleted on flush; sweep orphans |
| `parents`, `children`, `push_tokens`, `preferences` | bounded by user count | no policy needed |

At 30k events/day with ~500-byte payloads, an unpruned `inbox` reaches the cap in under two years. A
7-day window holds it at ~200k rows. Both sweeps ride the same hourly cron.

### 5.3 Known burst: the Sunday fan-out

`reporting.week.closed` fires for every active child at once (03:00 UTC = 10:00 Vietnam — a live traffic
window). At 5,000 msg/s the enqueue drains quickly, but those messages sit ahead of real-time events in
the same queue.

Acceptable for now: a few minutes of delay on Sunday-morning progress pushes. If it becomes visible,
either give `reporting.week.closed` its own queue or pace the fan-out across the weekly rider's 15-minute
CPU budget. **Do not** solve it by shrinking the batch — that just moves the queueing.

---

## 6. Implementation order

1. **This document** — `docs/design.md`, kept current as the service evolves.
2. **Walking skeleton** — GCP topology + one real push (§7.0). Blocks everything else.
3. **Scaffold** — `package.json`, `wrangler.jsonc`, copy-in list (§4.2), migrations, `/healthz`.
4. **Event contract** — `src/events/v1.ts` + golden fixtures + `docs/events/v1.md` (§2).
5. **Consumer** — inbox (§4.4), identity mirror, coalescing (§4.5), FCM client (§4.6).
6. **Parent API** — devices + preferences (§4.7).
7. **Producer** — robo-worker publisher, wiring, weekly rider (§3). No migration: v1 sends directly.
8. **Backfill + rollout** — identity replay (§4.8), then ship dark behind `PUSH_ENABLED`.

Steps 5–6 and step 7 are independent once the contract (4) is frozen, so they can proceed in parallel.

---

## 7. Verification

0. **Walking skeleton (do first).** The code path is proven, but the **GCP topology is not** — a second
   WIF provider, a new SA, and FCM role bindings have never been exercised together. Stand up the
   provider + SA, deploy a stub Worker serving `/auth/jwks`, mint an FCM access token through the copied
   `wif.ts`, and send one message to a real dev handset. Nothing else gets built until a push arrives.
1. **`pnpm vitest run` (tuni-noti)** — real D1 in workerd via `applyD1Migrations`. Cover: inbox claim
   race (concurrent duplicate delivery), crash-after-claim retry, unknown event type → `ignored`,
   coalescing merges 3 events into 1 push, quiet-hours suppression, `UNREGISTERED` disables the token,
   `identity.child.deleted` purges tokens + history.
2. **`pnpm vitest run` (robo-worker)** — `buildNotificationEvents` maps ledger events to the contract
   (pure, no bindings); **a throwing `NOTI_QUEUE` does not fail the lesson fold** (§3.2); weekly
   aggregate counts match seeded fixtures.
3. **Contract test** — a golden fixture per event type, asserted by both repos, so producer and consumer
   cannot drift.
4. **End-to-end on dev** — seed a child → drive a lesson to completion via the existing e2e harness
   (`pnpm test:e2e`) → assert a queue delivery, an `inbox` row, a `notifications` row, and
   a real push on a dev handset. A `POST /v1/_test/emit` gated by `E2E_ENABLED` lets this run without the
   robot in the loop.
5. **Gates before merge** (robo-worker's de-facto DoD): `type-check` 0 · `biome` clean · `check:deploy`
   under the 300 ms startup ceiling · full vitest green in both repos.
6. **Deploy order** — D1 migrations first, then the Worker (the old Worker never touches the new tables,
   so there is no risky window). Ship tuni-noti **consuming** before robo-worker starts **producing**.

---

## 8. Rollout

Ship dark: the producer emits, the consumer processes and writes `notifications` rows, but the FCM send
sits behind a `PUSH_ENABLED` var. Verify volume and coalescing against real traffic for a few days — this
is the only honest way to size notification fatigue — then enable it for internal parents first.

---

## 9. Out of scope for v1
