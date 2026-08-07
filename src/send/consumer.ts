// src/send/consumer.ts
//
// The FCM send consumer (design.md §4.6). One FCM call per token — HTTP v1
// has no batch endpoint, which is the root of the fan-out constraint in §5.1.
//
// Delivery is AT-LEAST-ONCE and this file says so plainly: FCM cannot
// participate in a transaction, so a crash between "FCM accepted" and
// "delivery row updated" resends on redelivery. The per-token `deliveries`
// rows prevent *systematic* duplicates (a redelivered job skips tokens
// already `accepted`), and the deterministic notification id plus the Android
// collapse key bound the *visible* cost to a replaced notification rather
// than a stacked one.

import { type FcmEnv, sendOne } from "../fcm/client";
import type { SendJob } from "./enqueue";

/**
 * The simultaneous-connection limit applies to EVERY invocation, consumers
 * included (§5.1) — never `Promise.all()` a 100-message batch.
 */
const CONNECTION_SLOTS = 6;

// A progress push older than a few hours is noise; let it expire rather than
// surprising a parent the next morning (§4.6).
const PUSH_TTL = "10800s";
const ANDROID_CHANNEL = "tuni_progress";
// Versioned deep-link contract agreed with the app team (§4.6).
const DEEP_LINK_VERSION = "1";

const LOAD_BATCH_SQL = `
SELECT n.id, n.parent_id, n.child_id, n.kind, n.title, n.body, n.data_json, n.state,
       c.deleted_at AS child_deleted_at,
       t.token, t.disabled_at,
       d.state AS delivery_state
  FROM notifications n
  LEFT JOIN children c ON c.child_id = n.child_id
  LEFT JOIN push_tokens t ON t.parent_id = n.parent_id AND t.disabled_at IS NULL
  LEFT JOIN deliveries d ON d.notification_id = n.id AND d.token = t.token
 WHERE n.id IN (SELECT value FROM json_each(?1))`;

// DEMO ONLY (PUSH_BROADCAST=1). Identical to LOAD_BATCH_SQL except the token
// join drops `t.parent_id = n.parent_id`, so EVERY enabled device receives
// EVERY notification regardless of which parent it was rendered for.
//
// This exists because the app is temporarily skipping login, so no device can
// register against a real parent (POST /v1/me/devices needs the parent JWT) and
// nothing would ever be delivered. It is a demo prop, not a feature:
//
//   - It sends one family's child's progress to every registered handset. With
//     real parents on the service that is a privacy incident, not a bug report.
//   - It is safe TODAY only because push_tokens holds nothing but hand-inserted
//     demo devices.
//
// DELETE this constant, its branch, and the var the moment login is back.
const LOAD_BATCH_BROADCAST_SQL = `
SELECT n.id, n.parent_id, n.child_id, n.kind, n.title, n.body, n.data_json, n.state,
       c.deleted_at AS child_deleted_at,
       t.token, t.disabled_at,
       d.state AS delivery_state
  FROM notifications n
  LEFT JOIN children c ON c.child_id = n.child_id
  LEFT JOIN push_tokens t ON t.disabled_at IS NULL
  LEFT JOIN deliveries d ON d.notification_id = n.id AND d.token = t.token
 WHERE n.id IN (SELECT value FROM json_each(?1))`;

const INSERT_DELIVERY_SQL = `
INSERT OR IGNORE INTO deliveries (notification_id, token, state, attempts, fcm_message_name)
SELECT json_extract(value,'$.notification_id'), json_extract(value,'$.token'), 'pending', 0, NULL
  FROM json_each(?1)`;

const UPDATE_DELIVERY_SQL = `
UPDATE deliveries
   SET state = (SELECT json_extract(v.value,'$.state') FROM json_each(?1) v
                 WHERE json_extract(v.value,'$.notification_id') = deliveries.notification_id
                   AND json_extract(v.value,'$.token') = deliveries.token),
       attempts = attempts + 1,
       fcm_message_name = (SELECT json_extract(v.value,'$.message_name') FROM json_each(?1) v
                            WHERE json_extract(v.value,'$.notification_id') = deliveries.notification_id
                              AND json_extract(v.value,'$.token') = deliveries.token)
 WHERE EXISTS (SELECT 1 FROM json_each(?1) v
                WHERE json_extract(v.value,'$.notification_id') = deliveries.notification_id
                  AND json_extract(v.value,'$.token') = deliveries.token)
   -- Conditional: a token already accepted is never regressed by a
   -- redelivered job (design.md §4.6).
   AND deliveries.state = 'pending'`;

const DISABLE_TOKENS_SQL = `
UPDATE push_tokens SET disabled_at = ?2
 WHERE token IN (SELECT value FROM json_each(?1)) AND disabled_at IS NULL`;

const SET_NOTIFICATION_STATE_SQL = `
UPDATE notifications SET state = ?2
 WHERE id IN (SELECT value FROM json_each(?1))`;

type BatchRow = {
  id: string;
  parent_id: string;
  child_id: string | null;
  kind: string;
  title: string;
  body: string;
  data_json: string;
  state: string;
  child_deleted_at: string | null;
  token: string | null;
  disabled_at: string | null;
  delivery_state: string | null;
};

type Target = { notificationId: string; token: string };

export type SendEnv = FcmEnv & { NOTI_D1: D1Database; PUSH_ENABLED?: string; PUSH_BROADCAST?: string };

/** Bounded-concurrency map. Six in flight, never more. */
async function withSlots<T, R>(items: T[], slots: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(slots, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function sendBatchJobs(env: SendEnv, jobs: SendJob[]): Promise<void> {
  const ids = [...new Set(jobs.map((j) => j.notificationId))];
  if (ids.length === 0) return;

  const d1 = env.NOTI_D1;
  const broadcast = env.PUSH_BROADCAST === "1";
  if (broadcast) console.log("[send] PUSH_BROADCAST is on — every enabled device receives every notification");
  const { results: rows } = await d1
    .prepare(broadcast ? LOAD_BATCH_BROADCAST_SQL : LOAD_BATCH_SQL)
    .bind(JSON.stringify(ids))
    .all<BatchRow>();
  if (rows.length === 0) return;

  const byNotification = new Map<string, BatchRow[]>();
  for (const row of rows) {
    const existing = byNotification.get(row.id);
    if (existing) existing.push(row);
    else byNotification.set(row.id, [row]);
  }

  // PUSH_ENABLED is decided HERE, at send time — not at flush. Flipping the
  // flag on must not release days of accumulated backlog (design.md §8).
  if (env.PUSH_ENABLED !== "1") {
    await d1
      .prepare(SET_NOTIFICATION_STATE_SQL)
      .bind(JSON.stringify([...byNotification.keys()]), "suppressed_dark")
      .run();
    console.log(`[send] suppressed_dark x${byNotification.size} (PUSH_ENABLED off)`);
    return;
  }

  const canceled: string[] = [];
  const targets: Target[] = [];
  const contextById = new Map<string, BatchRow>();

  for (const [notificationId, group] of byNotification) {
    const first = group[0];
    contextById.set(notificationId, first);

    // A job already sitting in SEND_QUEUE must not push for a deleted child —
    // re-checked immediately before sending (design.md §4.8 rule 4).
    if (first.child_deleted_at) {
      canceled.push(notificationId);
      continue;
    }
    // Something else already finished or canceled this one.
    if (first.state !== "enqueued") continue;

    for (const row of group) {
      // Tokens already `accepted` are skipped — that is what stops a
      // redelivered job resending to devices that already got it.
      if (!row.token || row.delivery_state === "accepted") continue;
      targets.push({ notificationId, token: row.token });
    }
  }

  if (targets.length > 0) {
    await d1
      .prepare(INSERT_DELIVERY_SQL)
      .bind(JSON.stringify(targets.map((t) => ({ notification_id: t.notificationId, token: t.token }))))
      .run();
  }

  const outcomes = await withSlots(targets, CONNECTION_SLOTS, async (target) => {
    const ctx = contextById.get(target.notificationId) as BatchRow;
    return { target, outcome: await sendOne(env, buildMessage(ctx, target.token)) };
  });

  const deliveryUpdates: Array<{ notification_id: string; token: string; state: string; message_name: string | null }> =
    [];
  const tokensToDisable: string[] = [];
  let retryable = 0;

  for (const { target, outcome } of outcomes) {
    const base = { notification_id: target.notificationId, token: target.token };
    switch (outcome.kind) {
      case "accepted":
        // Accepted by FCM, NOT delivered to a handset. Nothing in this system
        // may claim "delivered" (design.md §4.6).
        deliveryUpdates.push({ ...base, state: "accepted", message_name: outcome.messageName });
        break;
      case "token_dead":
        deliveryUpdates.push({ ...base, state: "failed", message_name: null });
        tokensToDisable.push(target.token);
        break;
      case "token_dead_alert":
        deliveryUpdates.push({ ...base, state: "failed", message_name: null });
        tokensToDisable.push(target.token);
        console.log(`[send] ALERT sender-id mismatch token=${target.token.slice(0, 12)}… — configuration drift`);
        break;
      case "payload_bug":
        // Deliberately does NOT disable: silently unsubscribing a healthy
        // device to mask our own malformed payload is the failure §4.6 calls
        // out by name.
        deliveryUpdates.push({ ...base, state: "failed", message_name: null });
        console.log(`[send] ALERT payload bug: ${outcome.reason}`);
        break;
      default:
        // retry / auth_error — leave the row `pending` so the queue's own
        // retry picks it up; counted so the throw below is legible.
        retryable++;
        console.log(`[send] retryable: ${outcome.kind} ${outcome.reason}`);
        break;
    }
  }

  const statements: D1PreparedStatement[] = [];
  if (deliveryUpdates.length > 0) {
    statements.push(d1.prepare(UPDATE_DELIVERY_SQL).bind(JSON.stringify(deliveryUpdates)));
  }
  if (tokensToDisable.length > 0) {
    statements.push(d1.prepare(DISABLE_TOKENS_SQL).bind(JSON.stringify(tokensToDisable), new Date().toISOString()));
  }
  if (canceled.length > 0) {
    statements.push(d1.prepare(SET_NOTIFICATION_STATE_SQL).bind(JSON.stringify(canceled), "canceled"));
  }

  // Only notifications whose every target resolved terminally are `done`.
  const unresolved = new Set(
    outcomes
      .filter((o) => o.outcome.kind === "retry" || o.outcome.kind === "auth_error")
      .map((o) => o.target.notificationId),
  );
  const done = [...byNotification.keys()].filter(
    (id) => !unresolved.has(id) && !canceled.includes(id) && contextById.get(id)?.state === "enqueued",
  );
  if (done.length > 0) {
    statements.push(d1.prepare(SET_NOTIFICATION_STATE_SQL).bind(JSON.stringify(done), "done"));
  }

  if (statements.length > 0) await d1.batch(statements);

  // Throwing hands the batch back to the queue's retry policy (max_retries: 2
  // for SEND_QUEUE — FCM's own classifier already retried what it could, so a
  // consumer-level retry storm on top just wastes budget, §5.3).
  if (retryable > 0) throw new Error(`[send] ${retryable} delivery(ies) need retry`);
}

function buildMessage(ctx: BatchRow, token: string) {
  return {
    token,
    notification: { title: ctx.title, body: ctx.body },
    data: {
      // The app's dedupe handle — deterministic, so a resend after the crash
      // window is recognizable as the same notification.
      notificationId: ctx.id,
      kind: ctx.kind,
      deepLinkVersion: DEEP_LINK_VERSION,
      deepLink: ctx.child_id ? `tuni://child/${ctx.child_id}/progress` : "tuni://home",
    },
    android: {
      // Collapse key per child: a newer progress push REPLACES a stale one on
      // the lock screen rather than stacking (design.md §4.6).
      collapse_key: ctx.child_id ?? ctx.parent_id,
      tag: ctx.child_id ?? ctx.parent_id,
      ttl: PUSH_TTL,
      priority: "high",
      // Parents mute channels, not apps.
      notification: { channel_id: ANDROID_CHANNEL },
    },
  };
}
