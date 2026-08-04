# tuni-noti

Parent notification service for **Tuni**, an English tutoring robot for Vietnamese children aged 5–8.

One job: turn domain events from `robo-worker` into well-timed FCM pushes to the parent's Android app —
progress moments as they happen, plus a Sunday weekly nudge.

- **tuni-noti never reads robo-worker's D1.** The only coupling is a versioned event contract carried
  over a Cloudflare Queue.
- **tuni-noti owns** FCM tokens, notification preferences, timezone/locale, and notification history.
- **robo-worker owns** parents, children, learning progress, and everything educational.

## Status

Design complete, implementation not started. See **[`docs/design.md`](docs/design.md)**.

## Stack

Cloudflare Workers · Hono · arktype (not zod) · Kysely + D1 · Cloudflare Queues · Biome ·
vitest-pool-workers · pnpm. Mirrors `robo-worker`'s conventions — see `docs/design.md` §4.1 for the
deliberate deviations.
