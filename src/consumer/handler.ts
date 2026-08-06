// src/consumer/handler.ts
//
// The queue consumer's entire effect for a delivery batch is ONE d1.batch()
// (design.md §4.4). Raw prepared statements, not Kysely: the vendored dialect
// throws on transactions (src/datastore/d1/kysely-d1.ts) and batch() is the
// only atomic primitive D1 offers. One batch per delivery batch, never one
// per message — D1 executes sequentially and up to 250 consumer invocations
// share one database, so per-message round trips are the exact contention
// pattern it handles worst.

import { type ParseResult, parseEnvelope } from "./parse";
import { planBatch } from "./plan";

/**
 * Which of these children already carry a terminal tombstone (§4.8 rule 3).
 * ONE query per delivery batch — not per message. Deciding this inside the
 * batch is impossible: the inbox state depends on it, and a single batch
 * cannot branch on a read.
 */
async function tombstonedChildIds(d1: D1Database, childIds: string[]): Promise<Set<string>> {
  if (childIds.length === 0) return new Set();
  // json_each keeps this ONE bound parameter regardless of batch size — D1
  // caps bound parameters well below 100 (§5).
  const { results } = await d1
    .prepare(
      `SELECT child_id FROM children
        WHERE deleted_at IS NOT NULL
          AND child_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(childIds))
    .all<{ child_id: string }>();
  return new Set(results.map((r) => r.child_id));
}

/**
 * `receivedAt` is a parameter, not a `Date.now()` inside: the e2e injection
 * route (src/routes/e2e.ts) backdates it so a window is already past its
 * coalescing quiet period, and the queue path simply takes the default. It
 * stays the CONSUMER's clock either way — never the event's occurredAt
 * (design.md §4.5 step 2).
 *
 * Returns the parse verdicts so a caller that wants them (only the e2e route
 * does) can report why an event did nothing; the queue path discards them.
 */
export async function consumeBatch(
  d1: D1Database,
  payloads: unknown[],
  receivedAt: string = new Date().toISOString(),
): Promise<ParseResult[]> {
  const results = payloads.map(parseEnvelope);

  const childIds = [...new Set(results.flatMap((r) => (r.kind === "ok" ? [r.event.subject.childId] : [])))];
  const tombstoned = await tombstonedChildIds(d1, childIds);

  const planned = planBatch(results, receivedAt, tombstoned);

  for (const result of results) {
    if (result.kind === "ok") continue;
    // Logs are the fallback until NOTI_METRICS lands (design.md §4.1). Each
    // non-ok kind gets its OWN line prefix: a premature 2.0 producer rollout
    // announcing itself must be distinguishable from a genuinely broken
    // payload, which is exactly what §4.4 asks these counters to separate.
    console.log(`[consumer] ${result.kind} eventId=${result.eventId ?? "<unidentifiable>"}`);
  }

  if (planned.length === 0) return results;

  const statements = planned.map((s) => d1.prepare(s.sql).bind(...s.params));
  await d1.batch(statements);
  return results;
}

export async function handleQueueBatch(d1: D1Database, batch: MessageBatch<unknown>): Promise<void> {
  await consumeBatch(
    d1,
    batch.messages.map((m) => m.body),
  );
  // Explicit ack of the whole batch: every effect above is idempotent, so a
  // redelivery is harmless — but acking means we don't pay for one.
  batch.ackAll();
}
