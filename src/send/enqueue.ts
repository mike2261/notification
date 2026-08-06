// src/send/enqueue.ts
//
// The cron enqueues; it never sends (design.md §4.5 step 4, §5.1).
//
// A cron trigger is ONE invocation, and an invocation may have only 6
// connections waiting on response headers. FCM HTTP v1 is one request per
// token with no batch endpoint, so a cron that called FCM directly would
// throttle to roughly tens of pushes per second with no horizontal scaling.
// Queue consumers auto-scale toward 250 invocations, each with its own
// connection budget — orders of magnitude more fan-out for what is
// essentially a moved function call.

export type SendJob = { notificationId: string };

// Queues accept 100 messages per sendBatch subrequest (§5).
const SEND_BATCH_SIZE = 100;

// `state = 'scheduled'` already means "never reached enqueued" — the flush
// writes that state and only this function moves rows out of it.
const DUE_SCHEDULED_SQL = `
SELECT id FROM notifications
 WHERE state = 'scheduled'
   AND scheduled_for <= ?1
 ORDER BY scheduled_for
 LIMIT ?2`;

const MARK_ENQUEUED_SQL = `
UPDATE notifications
   SET state = 'enqueued', enqueued_at = ?2
 WHERE id IN (SELECT value FROM json_each(?1))
   AND state = 'scheduled'`;

const PAGE_SIZE = 500;

/**
 * Moves due `scheduled` notifications onto SEND_QUEUE and marks them
 * `enqueued`.
 *
 * `olderThanMs` is the sweeper's age floor. The notification row doubles as
 * this service's internal outbox: a crash between the flush's commit and its
 * `sendBatch` leaves a `scheduled` row nobody will ever pick up, so an hourly
 * sweeper re-enqueues them. That floor is REQUIRED, not a tuning knob —
 * without it the sweeper races a flush that is mid-tick and re-enqueues rows
 * that were about to be sent normally. The flush's own inline call passes 0.
 */
export async function enqueueScheduled(
  d1: D1Database,
  queue: Queue,
  now: Date = new Date(),
  options: { olderThanMs?: number } = {},
): Promise<number> {
  const olderThanMs = options.olderThanMs ?? 0;
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();

  const { results } = await d1.prepare(DUE_SCHEDULED_SQL).bind(cutoff, PAGE_SIZE).all<{ id: string }>();

  if (results.length === 0) return 0;

  const ids = results.map((r) => r.id);
  for (let i = 0; i < ids.length; i += SEND_BATCH_SIZE) {
    const slice = ids.slice(i, i + SEND_BATCH_SIZE);
    await queue.sendBatch(slice.map((notificationId) => ({ body: { notificationId } satisfies SendJob })));
  }

  // Marked AFTER the send, so a crash between the two leaves the rows
  // `scheduled` and the sweeper picks them up again. The alternative — mark
  // first — would lose them silently, which is the one outcome the internal
  // outbox exists to prevent. Duplicate queue delivery is already handled:
  // the consumer's per-token delivery rows make a resend a no-op.
  await d1.prepare(MARK_ENQUEUED_SQL).bind(JSON.stringify(ids), now.toISOString()).run();

  return ids.length;
}
