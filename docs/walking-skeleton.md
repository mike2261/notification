# Walking skeleton — runbook

Implements `design.md` §7.0. **Nothing else gets built until step 9 prints `accepted`.**

The code is done and tested. What is not proven — and cannot be proven by any amount of code review — is
the **GCP topology**: a second WIF provider, a dedicated service account, and an FCM role binding have
never been exercised together. That is what this runbook exercises.

## The ordering constraint, up front

There is a genuine circular dependency, and it dictates every step below:

> A WIF provider verifies self-signed assertions against the JWKS served at **its configured issuer**.
> tuni-noti's issuer is tuni-noti's own Worker URL. So **the Worker must exist and serve `/auth/jwks`
> before the provider can be created** — which is why the first deploy runs with `BOOTSTRAP=1` and
> deliberately skips the WIF assertions it would otherwise fail.

This is also why robo-worker's provider cannot be reused (`design.md` §4.6 step 5): its issuer is
robo-worker's URL, and a provider trusts exactly one JWKS document.

## Values to fill in

Collect these first; every step references them.

| Placeholder | Where it comes from |
|---|---|
| `PROJECT_ID` | GCP project string id — for robo-worker that is `ai-robotics-496803` |
| `PROJECT_NUMBER` | GCP project **number** — robo-worker uses `273162862419` |
| `FIREBASE_PROJECT_ID` | The Firebase project that owns the Android app's FCM sender |
| `POOL_ID` | A workload identity pool. robo-worker's `robo-cf-worker-pool` **can be reused** — only the *provider* must be new |
| `PROVIDER_ID` | New, e.g. `tuni-noti` |
| `WORKER_URL` | Printed by the first deploy, e.g. `https://tuni-noti.taskfi.workers.dev` |

> **Assumption worth confirming before you start:** that the Firebase project sending pushes to the
> Android app is the same GCP project as robo-worker's. If it is a *different* project, the SA still
> lives in `PROJECT_ID` but the FCM role must be granted **on the Firebase project**, and `FCM_PROJECT_ID`
> is that project's id. Step 5 notes where this changes.

---

## 1. Generate the signing key

```sh
pnpm wif:key            # inspect the keypair and the kid /auth/jwks will serve
```

The secret is PKCS#8 DER, base64, **one line** — not PEM. `src/auth/wif.ts` does `atob()` then imports it
directly, so armour or newlines fail at the first request with an error that names nothing useful.

Keep the printed base64. Do not commit it. `.gitignore` already covers `*.pem`, `.dev.vars*`, and `.env*`,
but this value belongs only in `wrangler secret`.

## 2. First deploy — bootstrap

```sh
pnpm check:deploy       # bundles + 300ms startup gate
pnpm deploy:bootstrap   # BOOTSTRAP=1: shallow smoke only
```

Note the Worker URL it prints. That is `WORKER_URL`, and it is the issuer for step 4.

If `wrangler deployments status` reports no versions yet (brand-new Worker), run `pnpm deploy:direct`
once to create it, then use `pnpm deploy` from step 6 onward.

## 3. Install the signing key

```sh
# Paste the base64 from step 1 — do NOT re-run gen-wif-key, that mints a different key.
npx wrangler secret put WIF_PRIVATE_KEY

curl -s "$WORKER_URL/auth/jwks" | jq
```

Expect one key: `{"kty":"EC","crv":"P-256","alg":"ES256","use":"sig","kid":"..."}`. A 503 here means the
secret is unset or malformed — fix it now, because step 4 configures GCP to trust this exact URL.

## 4. Create the WIF provider

Reuses robo-worker's pool; the provider is new.

```sh
gcloud iam workload-identity-pools providers create-oidc PROVIDER_ID \
  --project=PROJECT_ID \
  --location=global \
  --workload-identity-pool=POOL_ID \
  --issuer-uri="WORKER_URL" \
  --attribute-mapping="google.subject=assertion.sub" \
  --attribute-condition='assertion.sub == "tuni-noti"'
```

Two things that are easy to get wrong and produce unhelpful errors:

- **`--issuer-uri` must be the origin, not the JWKS path.** GCP appends `/.well-known/openid-configuration`
  and `/auth/jwks` discovery itself. If Google cannot reach it, every assertion fails as "invalid signature".
- **The attribute condition is not optional hardening.** Without it, *any* assertion your issuer signs can
  impersonate the SA. Pinning `assertion.sub` is what makes the WIF_SUBJECT in `wrangler.jsonc` load-bearing
  (`design.md` §4.6 step 5).

## 5. Create the service account and grant FCM

A **dedicated** SA — do not reuse robo-worker's bridge SA. The whole point is separate blast radius.

```sh
gcloud iam service-accounts create tuni-noti \
  --project=PROJECT_ID \
  --display-name="tuni-noti FCM sender"
```

Narrowest possible send permission — a custom role with exactly one permission:

```sh
gcloud iam roles create tuniNotiFcmSend \
  --project=FIREBASE_PROJECT_ID \
  --title="FCM send only" \
  --permissions=cloudmessaging.messages.create

gcloud projects add-iam-policy-binding FIREBASE_PROJECT_ID \
  --member="serviceAccount:tuni-noti@PROJECT_ID.iam.gserviceaccount.com" \
  --role="projects/FIREBASE_PROJECT_ID/roles/tuniNotiFcmSend"
```

> If the Firebase project differs from `PROJECT_ID`, the two commands above are the cross-project grant —
> the SA lives in `PROJECT_ID`, the role is granted on `FIREBASE_PROJECT_ID`. If you would rather not
> manage a custom role, `roles/firebasecloudmessaging.admin` works and is still far narrower than
> `roles/firebase.admin`. Do not grant project-level `roles/editor`.

Then let the WIF principal impersonate it:

```sh
gcloud iam service-accounts add-iam-policy-binding \
  tuni-noti@PROJECT_ID.iam.gserviceaccount.com \
  --project=PROJECT_ID \
  --role="roles/iam.workloadIdentityUser" \
  --member="principal://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/subject/tuni-noti"
```

`workloadIdentityUser` — **not** `serviceAccountTokenCreator`. Both permit `generateAccessToken`, but
tokenCreator additionally grants `signBlob`/`signJwt`, which this service never needs (`design.md` §4.6).

## 6. Fill in `wrangler.jsonc` and redeploy

Replace the placeholders in the `vars` block:

```jsonc
"WIF_ISSUER":   "WORKER_URL",
"WIF_SUBJECT":  "tuni-noti",
"WIF_AUDIENCE": "//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID",
"FCM_SA_EMAIL": "tuni-noti@PROJECT_ID.iam.gserviceaccount.com",
"FCM_PROJECT_ID": "FIREBASE_PROJECT_ID",
```

**`WIF_AUDIENCE` starts with `//`, no protocol.** The GCP Console displays it as `https://iam.googleapis.com/...`
and the STS API rejects that form. `tests/wif.test.ts` asserts this, because it is the single most likely
first-run failure.

```sh
pnpm types && pnpm type-check && pnpm test
pnpm deploy        # full smoke: jwks + a REAL token mint in the canary isolate
```

The deploy now fails unless `/healthz?deep=1` actually mints an FCM access token. That is the topology
proven — steps 1–6 are the part `design.md` §7.0 calls "the real cost".

Verify by hand too:

```sh
curl -s "$WORKER_URL/healthz?deep=1" | jq
# { "ok": true, "deep": true, "wif": { "minted": true, "tokenLength": 1000-ish, "ms": 300-ish } }
```

## 7. Get a device token from a dev handset

From the Android app, log the FCM registration token (`FirebaseMessaging.getInstance().token`). It must
come from an app registered to `FIREBASE_PROJECT_ID` — a token from any other sender returns
`SENDER_ID_MISMATCH`, which the client script names explicitly.

## 8. Arm the skeleton route

```sh
npx wrangler secret put SKELETON_TOKEN     # any long random string
```

Set `"SKELETON_ENABLED": "1"` in `wrangler.jsonc`, then `pnpm deploy`.

The route is double-gated (enabled flag **and** bearer) because it mints a Google credential and sends
real pushes; an open version of it is a free push relay backed by our SA.

## 9. Send the push

```sh
SKELETON_TOKEN=<the secret> pnpm skeleton:push <deviceToken> "Tuni" "An vừa hoàn thành một bài học!"
```

`accepted` + a notification on the handset ⇒ **the walking skeleton is done.** Anything else prints the
outcome kind and what is actually misconfigured.

Remember what `accepted` does and does not mean: FCM took the message. It is not a delivery receipt, and
nothing in this service may ever claim otherwise (`design.md` §4.6).

## 10. Disarm

Set `"SKELETON_ENABLED": "0"`, `pnpm deploy`. Delete `POST /_skeleton/push` and
`scripts/skeleton-push.mjs` once the real consumer exists — they have no place in the service.

---

## What this proves, and what it does not

**Proven:** the WIF provider verifies our JWKS · the attribute condition admits our subject · the SA can be
impersonated · the SA may send FCM · a real handset receives a real push · workerd's ES256 output is
accepted by Google.

**Not proven, and not in scope:** anything about D1, Queues, coalescing, or the event contract. Those
arrive with `design.md` §6 step 4 onward, and none of them can start until the above is green.

## If it fails

| Symptom | Almost always |
|---|---|
| `STS exchange failed 400` | `WIF_AUDIENCE` has an `https://` prefix, or `WIF_ISSUER` ≠ the provider's issuer-uri |
| `STS exchange failed 403` | The attribute condition rejects `assertion.sub`; check it matches `WIF_SUBJECT` |
| `invalid signature` from Google | Google cannot reach `WORKER_URL/auth/jwks`, or the key was rotated without redeploying |
| `SA impersonation failed 403` | The `workloadIdentityUser` binding is missing, or points at the wrong pool/subject |
| FCM `PERMISSION_DENIED` | The FCM role is granted on the wrong project, or `cloudmessaging.messages.create` is absent |
| FCM `SENDER_ID_MISMATCH` | The device token is from a different Firebase project than `FCM_PROJECT_ID` |

`/healthz?deep=1` isolates the first four from the last two: if it returns `minted: true`, WIF is fine and
the problem is FCM-side.
