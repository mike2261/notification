// MUST stay the first import: switches arktype to jitless before any schema
// module can evaluate (Workers forbids `new Function` outside script startup).
import "./arktype-config";
import { handleQueueBatch } from "./consumer/handler";
import { app } from "./fetch";
import { flushDueWindows, flushQuietEndCatchup, windowsFromEnv } from "./flush/flush";
import { type SendEnv, sendBatchJobs } from "./send/consumer";
import { enqueueScheduled, type SendJob } from "./send/enqueue";

// The sweeper's age floor (design.md §4.5 step 4). REQUIRED, not a tuning
// knob: without it the sweeper races a flush that is mid-tick and re-enqueues
// rows that were about to be sent normally.
const SWEEPER_AGE_MS = 15 * 60_000;

/** Both production and env.test queue names end with the same suffix. */
function isSendQueue(name: string): boolean {
  return name.startsWith("tuni-noti-send");
}

// Static import, no lazy-load boundary. robo-worker's dynamic-import gymnastics
// exist to dodge deploy-validator error 10021 on a much larger dependency
// graph; tuni-noti has no such graph (design.md §4.1). `check:deploy` keeps the
// 300 ms startup tripwire so we find out if that ever stops being true.
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (isSendQueue(batch.queue)) {
      await sendBatchJobs(
        env as unknown as SendEnv,
        batch.messages.map((m) => m.body as SendJob),
      );
      batch.ackAll();
      return;
    }
    // NOTI_QUEUE and NOTI_WEEKLY_QUEUE take the same path — the weekly queue
    // exists for retry/DLQ isolation (design.md §5.3), not because its events
    // need different handling at the inbox stage.
    await handleQueueBatch(env.NOTI_D1, batch);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // The hourly cron is the backstop, not the main path: it re-enqueues rows
    // that never reached `enqueued` because a flush crashed between its commit
    // and its sendBatch (design.md §4.5 step 4).
    if (controller.cron === "0 * * * *") {
      const swept = await enqueueScheduled(env.NOTI_D1, env.SEND_QUEUE, new Date(), {
        olderThanMs: SWEEPER_AGE_MS,
      });
      if (swept > 0) console.log(`[sweeper] re-enqueued ${swept} stale notification(s)`);
      return;
    }

    const now = new Date();
    const count = await flushDueWindows(env.NOTI_D1, now, windowsFromEnv(env as unknown as Record<string, unknown>));
    if (count > 0) console.log(`[flush] rendered ${count} notification(s)`);

    // Quiet hours that ended since the last tick: fold each parent's deferred
    // rows into one catch-up push rather than releasing them individually.
    const catchup = await flushQuietEndCatchup(env.NOTI_D1, now);
    if (catchup > 0) console.log(`[flush] folded ${catchup} quiet-end catch-up push(es)`);

    // The cron enqueues; it never sends (design.md §5.1).
    const enqueued = await enqueueScheduled(env.NOTI_D1, env.SEND_QUEUE, now);
    if (enqueued > 0) console.log(`[flush] enqueued ${enqueued} notification(s)`);
  },
} satisfies ExportedHandler<Env>;
