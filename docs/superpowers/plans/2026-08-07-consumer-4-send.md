# Consumer Part 4: Send Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Actually deliver. `SEND_QUEUE` enqueue (`docs/design.md` §4.5 step 4), the 15-minute re-enqueue
sweeper, the `PUSH_ENABLED` dark gate decided **at send time** (§8), and the FCM send consumer with a 6-slot
semaphore and the §4.6 token lifecycle.

**Architecture:** The flush cron enqueues and never sends — a cron trigger is **one invocation** with **6**
simultaneous outgoing connections, so a cron that called FCM would throttle to tens of pushes/second with no
horizontal scaling (§5.1). Queue consumers auto-scale toward 250 invocations, each with its own connection
budget. The send consumer loads its whole batch's context in one query, fans out through a 6-slot semaphore,
and commits all delivery outcomes in one batch.

**Tech Stack:** Existing `src/fcm/client.ts` (`sendOne` + `classifyFcmResponse`, already written and tested),
Cloudflare Queues producer binding `SEND_QUEUE`, D1 `batch()`.

**This plan is Part 4 of 4** and completes `docs/design.md` §6 step 6.

---

## Before you start

```sh
pnpm test        # 148 passed
pnpm type-check  # clean
git log --oneline -1   # d6f70dc (or later) — Consumer Part 3 merged
```

---

## Task 1: Enqueue + sweeper

**Files:** Create `src/send/enqueue.ts`; modify `src/flush/flush.ts`, `src/index.ts`, `wrangler.jsonc`.
**Test:** `tests/send-enqueue.test.ts`

- [ ] **Step 1** — `enqueueScheduled(d1, queue, now, {olderThanMs})`: selects `state='scheduled'` rows whose
  `scheduled_for <= now` (and, for the sweeper, older than 15 minutes), `sendBatch`es them 100 at a time, and
  flips them to `enqueued` with `enqueued_at` in one batch.

  The **15-minute age floor is required** for the sweeper, not optional: without it the sweeper races a flush
  that is mid-tick and re-enqueues rows that were about to be sent normally. The flush's own inline enqueue
  passes `olderThanMs: 0`.

- [ ] **Step 2** — call it at the end of `flushDueWindows`, and add an hourly `0 * * * *` cron routed by
  `controller.cron` in `scheduled()`.

- [ ] **Step 3** — tests: rows become `enqueued` with a timestamp; `sendBatch` receives one message per
  notification; a `deferred_quiet` row is never enqueued; the sweeper skips rows younger than 15 minutes and
  re-enqueues older ones; re-running is idempotent (an already-`enqueued` row is not enqueued twice).

---

## Task 2: The send consumer

**Files:** Create `src/send/consumer.ts`; modify `src/index.ts`, `wrangler.jsonc` (`PUSH_ENABLED`).
**Test:** `tests/send-consumer.test.ts`

- [ ] **Step 1** — `sendBatchJobs(env, jobs)`:
  1. **One** query loading every job's notification + its parent's live tokens + the child's tombstone.
  2. `PUSH_ENABLED !== "1"` → mark every notification `suppressed_dark` and stop. **Decided here, not at
     flush**, so flipping the flag on releases nothing retroactively (§8).
  3. A tombstoned child → `canceled`, no FCM call. The send consumer re-checks immediately before sending
     because a job already sitting in `SEND_QUEUE` must not push for a deleted child (§4.8 rule 4).
  4. `INSERT OR IGNORE` a `pending` delivery row per (notification, token); skip tokens already `accepted` —
     that is what stops a redelivered job resending to devices that already got it.
  5. Fan out through a **6-slot semaphore**. Never `Promise.all` a 100-message batch: the
     simultaneous-connection limit applies to *every* invocation, consumers included (§5.1).
  6. One batch: delivery state per token, `disabled_at` for dead tokens, notification → `done`.

- [ ] **Step 2** — token lifecycle, exactly §4.6:

  | FCM outcome | Action |
  |---|---|
  | `accepted` | delivery `accepted` + store `fcm_message_name`. **Accepted by FCM, not delivered** — nothing may claim otherwise |
  | `token_dead` (`UNREGISTERED`/`NOT_FOUND`, or `INVALID_ARGUMENT` *naming the token*) | stamp `disabled_at`, never retry |
  | `token_dead_alert` (`SENDER_ID_MISMATCH`) | disable + alert — config drift, not token churn |
  | `payload_bug` (payload-shaped `INVALID_ARGUMENT`) | delivery `failed` + alert, and **do not disable** — disabling a healthy device to mask our own malformed payload is a silent unsubscribe |
  | `retry` / `auth_error` | leave `pending`, increment `attempts`, throw so the queue retries |

- [ ] **Step 3** — message shape (§4.6): deterministic notification id in `data` (the app's dedupe handle),
  an Android **collapse key per child** so a newer progress push replaces a stale one rather than stacking, an
  explicit TTL, a named Android channel, and a versioned deep link.

- [ ] **Step 4** — route `queue()` by `batch.queue`: the send queue goes to `sendBatchJobs`, everything else
  to the existing inbox handler.

- [ ] **Step 5** — tests (real D1, stubbed `fetch`): a batch sends one FCM call per live token; `UNREGISTERED`
  disables the token; a **payload-shaped `INVALID_ARGUMENT` does not**; a redelivered job skips tokens already
  `accepted`; `PUSH_ENABLED=0` marks `suppressed_dark` with **zero** FCM calls; a tombstoned child is
  `canceled` with zero FCM calls; concurrency never exceeds 6 in flight.

---

## Final check

```sh
pnpm type-check && pnpm test && pnpm lint
```

**What remains after this plan** (tracked, not built here): the `NOTI_METRICS` Analytics Engine binding
(§4.1 — counters are `console.log` throughout), the retention sweeps (§5.2 — 30-day `inbox`, 90-day
`notifications`/`deliveries`, now that an hourly cron exists to hang them on), deleting the walking-skeleton
`/_skeleton/push` route, and the pinned-SHA cross-repo fixture CI (§2, needs robo-worker's producer first).
