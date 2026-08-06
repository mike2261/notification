// src/consumer/handler.ts
//
// The queue consumer's entire effect for a delivery batch is ONE d1.batch()
// (design.md §4.4). Raw prepared statements, not Kysely: the vendored dialect
// throws on transactions (src/datastore/d1/kysely-d1.ts) and batch() is the
// only atomic primitive D1 offers. One batch per delivery batch, never one
// per message — D1 executes sequentially and up to 250 consumer invocations
// share one database, so per-message round trips are the exact contention
// pattern it handles worst.

import { parseEnvelope } from "./parse";
import { planBatch } from "./plan";

export async function consumeBatch(d1: D1Database, payloads: unknown[]): Promise<void> {
  const results = payloads.map(parseEnvelope);
  const planned = planBatch(results, new Date().toISOString());

  for (const result of results) {
    if (result.kind === "ok") continue;
    // Logs are the fallback until NOTI_METRICS lands (design.md §4.1). Each
    // non-ok kind gets its OWN line prefix: a premature 2.0 producer rollout
    // announcing itself must be distinguishable from a genuinely broken
    // payload, which is exactly what §4.4 asks these counters to separate.
    console.log(`[consumer] ${result.kind} eventId=${result.eventId ?? "<unidentifiable>"}`);
  }

  if (planned.length === 0) return;

  const statements = planned.map((s) => d1.prepare(s.sql).bind(...s.params));
  await d1.batch(statements);
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
