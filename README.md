# tuni-noti

Parent notification service for **Tuni**, an English tutoring robot for Vietnamese children aged 5–8.

One job: turn domain events from `robo-worker` into well-timed FCM pushes to the parent's Android app —
progress moments as they happen, plus a Sunday weekly nudge.

- **tuni-noti never reads robo-worker's D1.** The only coupling is a versioned event contract carried
  over a Cloudflare Queue.
- **tuni-noti owns** FCM tokens, notification preferences, timezone/locale, and notification history.
- **robo-worker owns** parents, children, learning progress, and everything educational.

## Status

Design r3 complete (**[`docs/design.md`](docs/design.md)**). Implementation is at step 2 of §6 — the
**walking skeleton**: WIF → FCM auth, `/auth/jwks`, `/healthz?deep=1`, and a gated one-push endpoint.

The code is written and green. What remains is the GCP console work it exists to prove — a second WIF
provider, a dedicated service account, and an FCM role binding, none of which have been exercised
together. **[`docs/walking-skeleton.md`](docs/walking-skeleton.md)** is the runbook; nothing else gets
built until step 9 of it prints `accepted`.

No D1, Queues, event contract, or coalescing yet — those start at §6 step 4.

## Commands

```sh
pnpm test          # vitest in real workerd
pnpm type-check    # tsc --noEmit
pnpm lint          # biome
pnpm check:deploy  # bundle + 300ms startup gate
pnpm wif:key       # mint the ES256 keypair for WIF_PRIVATE_KEY
pnpm deploy        # 0% canary → smoke → promote
```

## Stack

Cloudflare Workers · Hono · arktype (not zod) · Kysely + D1 · Cloudflare Queues · Biome ·
vitest-pool-workers · pnpm. Mirrors `robo-worker`'s conventions — see `docs/design.md` §4.1 for the
deliberate deviations.
