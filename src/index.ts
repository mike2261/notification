// MUST stay the first import: switches arktype to jitless before any schema
// module can evaluate (Workers forbids `new Function` outside script startup).
import "./arktype-config";
import { handleQueueBatch } from "./consumer/handler";
import { app } from "./fetch";
import { flushDueWindows, flushQuietEndCatchup } from "./flush/flush";

// Static import, no lazy-load boundary. robo-worker's dynamic-import gymnastics
// exist to dodge deploy-validator error 10021 on a much larger dependency
// graph; tuni-noti has no such graph (design.md §4.1). `check:deploy` keeps the
// 300 ms startup tripwire so we find out if that ever stops being true.
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Route by queue name. NOTI_QUEUE and NOTI_WEEKLY_QUEUE take the same
    // path here — the weekly queue exists for retry/DLQ isolation
    // (design.md §5.3), not because its events need different handling at
    // the inbox stage. The send queue is Part 3 of this plan series.
    await handleQueueBatch(env.NOTI_D1, batch);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // The 1-minute flush. Part 3 adds the hourly sweeper and the retention
    // sweeps on their own cron expressions, routed by controller.cron.
    const count = await flushDueWindows(env.NOTI_D1);
    if (count > 0) console.log(`[flush] rendered ${count} notification(s)`);
    // Quiet hours that ended since the last tick: fold each parent's deferred
    // rows into one catch-up push rather than releasing them individually.
    const catchup = await flushQuietEndCatchup(env.NOTI_D1);
    if (catchup > 0) console.log(`[flush] folded ${catchup} quiet-end catch-up push(es)`);
  },
} satisfies ExportedHandler<Env>;
