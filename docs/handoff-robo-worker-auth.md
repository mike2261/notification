# Handoff: robo-worker auth migration for tuni-noti's Parent API

> **STATUS 2026-08-07 — steps 1–3 are BUILT** on robo-worker branch
> `feat/noti-producer-auth` (`src/auth/parent-key.ts`, ES256 minting + dual verification in
> `src/auth/parent.ts`, both keys served on `/auth/jwks`). Step 4 (dropping HS256) is scheduled in
> robo-worker's `docs/superpowers/plans/2026-08-08-drop-hs256-parent-sessions.md` for 24 h after that
> deploys. The two values below are now filled into `wrangler.jsonc`.
>
> **Still required before this works end to end:** an operator must run
> `node scripts/gen-parent-key.mjs` in robo-worker and
> `wrangler secret put PARENT_SESSION_PRIVATE_KEY`, then deploy. Until that deploy, robo-worker still
> mints HS256 and this service's verifier correctly 401s.

**For:** whoever picks up `docs/design.md` §1.4 / §6 step 3 in the **robo-worker** repo.
**Status of the other side (tuni-noti):** verification code is built and tested (PR introducing
`src/auth/parent-jwt.ts` + `src/routes/parent.ts`). It currently 401s every request in production because
`PARENT_JWKS_URL` / `PARENT_JWT_ISSUER` in `wrangler.jsonc` are placeholders — this doc is what unblocks
filling those in for real.

## Why

tuni-noti's Parent API (`POST /v1/me/devices`, `DELETE /v1/me/devices/:id`, `GET`/`PATCH /v1/me/preferences`)
needs to know which parent is calling. The original design had tuni-noti verify robo-worker's parent session
JWTs with a **shared HS256 secret** (`PARENT_SESSION_SECRET`) — design review killed that: with a symmetric
key, a verifier IS a signer, so a compromise of tuni-noti's public API would let an attacker mint valid
robo-worker parent sessions. The fix is asymmetric: robo-worker signs with a private ES256 key, tuni-noti
verifies against the public half via JWKS. tuni-noti never holds signing material.

Full rationale: `docs/design.md` §1.4 in the tuni-noti repo.

## What robo-worker needs to do

Four steps, all in robo-worker, independent of anything else in flight there:

1. **Mint a dedicated parent-session ES256 key with a `kid`.** Do **not** reuse the WIF signing key robo-worker
   already has (design.md §1.4 step 1) — different blast radius, different rotation lifecycle.
2. **Publish its public JWK through robo-worker's existing `/auth/jwks`.** This is additive, not a new
   endpoint — robo-worker already serves a JWKS for its own WIF use, per design.md; add the new parent-session
   key as one more entry in that same `keys` array, distinguished by `kid`. tuni-noti's verifier looks up by
   `kid` and ignores keys it doesn't recognize, so this is safe to add without touching whatever else is
   already being served there.
3. **Issue parent sessions as ES256, but verify both during the migration window.** robo-worker's session
   verification (currently `src/auth/parent.ts:30-47` per design.md, HS256 only) needs to accept **both**
   strictly-pinned legacy HS256 **and** the new ES256/JWKS path, while *issuing* ES256 exclusively from the
   moment this ships. This is what makes the migration zero-downtime for already-logged-in parents.
4. **Drop HS256 verification after 24h + clock skew.** Parent sessions are already 24h with no refresh
   (design.md §1.4), so every HS256-signed session naturally expires within a day. Once that window has
   passed, delete the HS256 verification path — don't leave it live longer than the sessions it exists to
   cover.

## The exact contract tuni-noti's verifier expects

This is what `src/auth/parent-jwt.ts` (tuni-noti) actually checks — treat it as the acceptance test, not just
prose:

- **JWKS response shape**, `GET {issuer}/auth/jwks`:
  ```json
  { "keys": [ { "kty": "EC", "crv": "P-256", "x": "...", "y": "...", "kid": "...", "alg": "ES256", "use": "sig" } ] }
  ```
  Standard RFC 7517 JWK Set. Multiple keys in the array is fine and expected (robo-worker's WIF key + the new
  parent-session key, at minimum).
- **JWT header:** `alg` must be exactly `"ES256"` — tuni-noti rejects anything else *before* even fetching the
  JWKS (no algorithm negotiation, by design). `kid` must be present and match an entry in the JWKS.
- **JWT claims:**
  - `sub` — the parent's id. This becomes `parentId` in tuni-noti's route handlers (e.g. what a device gets
    registered against). **Confirm this is genuinely the parent id and not some other subject identifier** —
    tuni-noti's code assumes `sub` = parent id with no further mapping.
  - `iss` — must exactly equal whatever robo-worker's real issuer URL is. tuni-noti pins this via
    `PARENT_JWT_ISSUER`.
  - `aud` — must be exactly `"robo-worker/parent"` (this one's already fixed in tuni-noti's config, not a
    placeholder — see design.md §1.4).
  - `exp` — standard Unix timestamp; tuni-noti rejects anything expired, no leeway added.
- **Signature:** raw ECDSA P-256 SHA-256 over `base64url(header).base64url(payload)`, using Web Crypto's
  native output format (R‖S concatenated, not DER) — this is the standard JWS ES256 wire format, should be
  automatic from any conforming JWT library or the same signing approach robo-worker's own `src/auth/wif.ts`
  already uses for its self-signed assertions.

## What tuni-noti needs from you once this ships

Two values, to fill in `wrangler.jsonc`'s currently-placeholder `PARENT_JWKS_URL` and `PARENT_JWT_ISSUER`
(top-level `vars` block, marked with a `FILL IN` comment):

- `PARENT_JWKS_URL` — the full URL to robo-worker's `/auth/jwks` in production.
  **Delivered:** `https://robo-worker.taskfi.workers.dev/auth/jwks`
- `PARENT_JWT_ISSUER` — the exact `iss` value robo-worker's parent session JWTs carry.
  **Delivered:** `https://robo-worker.taskfi.workers.dev` (robo-worker's `PARENT_SESSION_ISSUER` var —
  the same origin as its `WIF_ISSUER`, because that is the origin serving the JWKS).

`PARENT_JWT_AUDIENCE` is already set (`"robo-worker/parent"`) and doesn't need anything from you.

## How to verify end-to-end once both sides are ready

1. `curl {robo-worker}/auth/jwks` — confirm the parent-session key appears in `keys[]` with a `kid`.
2. Log a parent in through the normal robo-worker flow, decode the resulting session JWT's header (base64url
   of the first segment) — confirm `alg: "ES256"` and a `kid` that matches step 1.
3. With `PARENT_JWKS_URL`/`PARENT_JWT_ISSUER` filled in on the tuni-noti side, call
   `POST {tuni-noti}/v1/me/devices` with that real session token as a Bearer token — expect a 200 with a
   `deviceId`, not a 401.
4. Confirm an intentionally-tampered or expired token still 401s (tuni-noti's existing test suite covers this
   against synthetic tokens; this step is the one real-token sanity check worth doing by hand).

## Out of scope for this handoff

- **Step 8 (producer)** — robo-worker emitting the actual notification domain events
  (`identity.child.upserted`, `learning.*`, etc.) onto `NOTI_QUEUE`/`NOTI_WEEKLY_QUEUE`. That's a separate,
  larger piece of work with its own plan, unrelated to auth. This handoff is scoped to unblocking the Parent
  API only.
- **Dropping `PARENT_SESSION_SECRET` entirely** — only relevant if robo-worker's session code still has the
  original HS256-only path lying around from before this migration was designed; steps 3–4 above cover
  retiring it on the timeline that's actually safe.
