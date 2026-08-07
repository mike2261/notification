# Demo runbook — the full notification flow

Shows the real path end to end: **robo-worker publishes → Cloudflare Queue → tuni-noti coalesces →
FCM → a push on a real handset.** No robot, no lesson, no LLM in the loop.

Read `## What this demo does NOT prove` before showing it to anyone who might take it for a launch.

## The stack it runs on

Both Workers live in the **anhduc22601** Cloudflare account. That is not cosmetic: Cloudflare Queues
are account-scoped, so a robo-worker deployed anywhere else **cannot bind `tuni-noti-events`** at all.
The taskfi robo-worker (what the app normally talks to) therefore cannot participate.

| | URL | Notes |
|---|---|---|
| tuni-noti | `https://tuni-noti.anhduc22601.workers.dev` | production config, `PUSH_ENABLED=1`, demo flush windows |
| robo-worker (staging) | `https://robo-worker.anhduc22601.workers.dev` | branch `send-noti`, deployed with `wrangler.personal.jsonc`, **empty D1/DO** — a parallel stack, not a migration |

Two tokens live in the operator's hands, not in any repo: robo-worker's `ADMIN_API_TOKEN` and
tuni-noti's `E2E_TOKEN`.

## Before the demo (once)

1. **Build the app against the staging stack.** A dev build, not Expo Go —
   `getDevicePushTokenAsync()` needs the native FCM module.

   ```sh
   # .env
   EXPO_PUBLIC_API_BASE_URL=https://robo-worker.anhduc22601.workers.dev
   EXPO_PUBLIC_NOTI_BASE_URL=https://tuni-noti.anhduc22601.workers.dev
   # EXPO_PUBLIC_USE_MOCKS must be unset or 0
   npx expo run:android
   ```

   Pointing at taskfi instead is the one mistake that silently breaks everything: that deployment
   still mints HS256 sessions, and tuni-noti rejects them with a 401 before it ever looks at a
   token.

2. **Sign in with Google, accept the notification permission.** Registration is automatic from
   there (`src/features/notifications/pushRegistration.ts`) — nothing to copy by hand.

3. **Create a child in the app.** This is a real `identity.child.upserted` on the real queue, and it
   is what makes the push say the child's name instead of falling back to the envelope.

4. **Note the child's id** — the demo trigger takes it:

   ```sh
   npx wrangler d1 execute robo-d1 -c wrangler.personal.jsonc --remote \
     --command "SELECT id, name FROM children WHERE parent_id IS NOT NULL"
   ```

## The demo

### Act 1 — identity crosses the boundary

Show that the child created in the app is already mirrored in a different service's database:

```sh
npx wrangler d1 execute NOTI_D1 --remote \
  --command "SELECT child_id, name FROM children"
```

That row arrived as a queue message, not a database read. tuni-noti never touches robo-worker's D1.

### Act 2 — three progress moments, ONE push

Press it three times in a row:

```sh
for i in 1 2 3; do
  curl -s -X POST https://robo-worker.anhduc22601.workers.dev/api/admin/noti/emit-progress \
    -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'Content-Type: application/json' \
    -d '{"childId":"<CHILD_ID>","totalStars":7}'
  echo
done
```

Six events (each press publishes a completion **and** a star). Then the handset buzzes **once**,
about 30–90 seconds later:

> **An vừa học xong!**
> An hoàn thành 3 bài học, nhận 21 sao.

That single push is the whole argument for the service. The naive version of this feature sends six
notifications and gets muted in week two.

While waiting, this is what the pipeline did:

```sh
# each event recorded exactly once, replay-safe
npx wrangler d1 execute NOTI_D1 --remote \
  --command "SELECT state, COUNT(*) FROM inbox GROUP BY state"
# one rendered notification, and its per-token delivery row
npx wrangler d1 execute NOTI_D1 --remote \
  --command "SELECT title, body, state FROM notifications ORDER BY rowid DESC LIMIT 1"
```

### Act 3 — a REAL lesson, end to end

This is the one that answers "but is it wired to actual learning?". It runs the course engine: a
published course, a Mission Can-do, a judged outcome, `commitFold`, and the events derived from the
fold's projected outputs — not fabricated ones.

```sh
# in robo-worker, on branch send-noti
ADMIN_TOKEN=$ADMIN_API_TOKEN ORIGIN=https://robo-worker.anhduc22601.workers.dev \
  node scripts/noti-lesson-e2e.mjs <CHILD_ID> 6
```

Six short English answers ("Hello!", "Hi, I am An. Nice to meet you!", …) drive the demo course
(`tests/fixtures/noti-demo.course.json`: one mission, one review slot, a wrap-up) to completion. The
fold then publishes **three** events — completion, challenge achieved, star awarded — and tuni-noti
folds all three into one push:

> **An vừa học xong!**
> An hoàn thành 1 bài học, chinh phục 1 thử thách, nhận 1 sao.

The child must have a `parent_id` first (`/_test/course/bootstrap` does not set one) — an unparented
child has nobody to notify and publishes nothing, correctly and silently.

**This cannot be demoed from `wrangler dev`.** A queue producer marked `remote: true` in local dev
accepts `sendBatch()` and delivers nothing, from the Worker context and from inside the Tutor DO
alike. A local run looks like a passing integration test and proves nothing.

### Act 4 (optional) — the parent is in control

Preferences are per parent and enforced at flush time, not at send time:

```sh
curl -s https://tuni-noti.anhduc22601.workers.dev/v1/me/preferences -H "Authorization: Bearer <session JWT>"
```

Quiet hours defer to a single catch-up push at quiet-end; a daily cap refuses a parent's whole batch
rather than half of it.

## What this demo does NOT prove

Say these out loud if anyone asks "so it's done?":

- **The flush windows are wrong on purpose.** `FLUSH_CHILD_QUIET_MS=30000` in `wrangler.jsonc`
  replaces the designed 10 minutes so nobody watches a demo for ten minutes. At the real window the
  same three presses still produce one push; at 30 seconds a genuinely spread-out session would
  produce several. Delete those four vars before real parents arrive.
- **`emit-progress` (Act 2) fabricates events.** It publishes through the real publisher onto the
  real queue, so transport and contract are proven — but it does not run `commitFold`. Act 3 is the
  one that closes that gap.
- **The staging worker holds a copy of production's WIF signing key.** Its issuer and audience are
  hardcoded to taskfi's URL (`src/auth/wif.ts`), so the only way this deployment can reach the
  LLM/TTS bridges is to sign with the same key, which Google verifies against taskfi's JWKS. Same
  GCP identity, second holder. Give it its own WIF provider before this stack outlives the demo.
- **The demo course is one lesson with one mission.** Real courses have teaching, practice and
  quiz activities whose grading paths this never touches.
- **`PUSH_ENABLED=1` and `E2E_ENABLED=1` are demo settings.** Design §8 ships dark first: process
  events for days, measure real volume, *then* enable sending. The dark gate is evaluated at send
  time, so turning it back off releases nothing retroactively.
- **The staging robo-worker has an empty D1 and empty Durable Objects.** It is not production data,
  and Durable Object state cannot be migrated between accounts at all.
- **Analytics Engine is off on this account**, so `NOTI_METRICS` — the publish-drop counter that
  design §3.2 calls the honest answer to "how many pushes did we drop?" — is not recording.

## After the demo

```jsonc
// wrangler.jsonc
"PUSH_ENABLED": "0",
"E2E_ENABLED": "0",
// delete the four FLUSH_* vars
```

then `pnpm deploy`. Also delete `POST /_skeleton/push` and `scripts/skeleton-push.mjs` — the walking
skeleton has been superseded by the real pipeline and has no place in the service.
