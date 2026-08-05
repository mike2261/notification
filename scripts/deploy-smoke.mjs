// Usage: node scripts/deploy-smoke.mjs <baseUrl> <expectedVersionId> [--bootstrap]
//
// Smokes a canary version through the version-override header with strict
// JSON + status + version-identity assertions (a bad override silently falls
// back to the live version — substring checks are not enough).
//
// --bootstrap exists for ONE deploy: the very first one. The walking skeleton
// has a genuine ordering constraint — GCP's WIF provider must be configured
// with an issuer URL that does not exist until this Worker is deployed, so on
// the first pass there is no signing key and no provider, and /auth/jwks and
// /healthz?deep=1 MUST fail. Bootstrap asserts only that the canary responds.
// Every subsequent deploy asserts the full chain, which is the whole point.
const args = process.argv.slice(2);
const bootstrap = args.includes("--bootstrap");
const [base, expected] = args.filter((a) => !a.startsWith("--"));
if (!base || !expected) {
  console.error("usage: node scripts/deploy-smoke.mjs <baseUrl> <expectedVersionId> [--bootstrap]");
  process.exit(2);
}
const headers = { "Cloudflare-Workers-Version-Overrides": `tuni-noti="${expected}"` };
const fail = (msg) => {
  console.error(`smoke FAILED: ${msg}`);
  process.exit(1);
};

// A freshly-created version override takes seconds to propagate, and until it
// does Cloudflare serves the LIVE version — which may predate /healthz
// entirely (404), or answer with a different versionId. Every outcome is
// retryable until the deadline EXCEPT a parsed response that identifies itself
// as the canary: that answer is conclusive.
const deadline = Date.now() + 60_000;
for (;;) {
  let why;
  try {
    const res = await fetch(`${base}/healthz`, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 200) {
      why = `status ${res.status} (live version may predate /healthz)`;
    } else {
      let body;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      if (body === undefined) {
        why = "non-JSON body";
      } else if (body.versionId === expected) {
        if (body.ok !== true) fail(`/healthz answered from the canary with ok=${JSON.stringify(body.ok)}`);
        break;
      } else {
        why = `answered from version ${body.versionId ?? "<none>"}`;
      }
    }
  } catch (e) {
    why = e.message;
  }
  if (Date.now() >= deadline) {
    fail(`/healthz never answered from ${expected} within 60s (last: ${why}) — version override never propagated?`);
  }
  console.log(`smoke: override not propagated yet (${why}) — retrying...`);
  await new Promise((r) => setTimeout(r, 3_000));
}
console.log("smoke: shallow ok — canary version is responding");

if (bootstrap) {
  console.log("smoke: --bootstrap — skipping JWKS and WIF assertions (first deploy, no key/provider yet)");
  process.exit(0);
}

// JWKS must serve a usable ES256 public key. GCP's provider fetches exactly
// this document; a 503 here means WIF_PRIVATE_KEY is unset or malformed, and
// every assertion we ever sign would be rejected with an opaque error.
let jwks;
try {
  const res = await fetch(`${base}/auth/jwks`, { headers, signal: AbortSignal.timeout(20_000) });
  if (res.status !== 200) fail(`/auth/jwks: status ${res.status} — is WIF_PRIVATE_KEY set?`);
  jwks = await res.json();
} catch (e) {
  fail(`/auth/jwks: ${e.message}`);
}
const key = jwks?.keys?.[0];
if (key?.kty !== "EC" || key.crv !== "P-256" || key.alg !== "ES256" || !key.kid) {
  fail(`/auth/jwks: unusable key document ${JSON.stringify(jwks).slice(0, 200)}`);
}
console.log(`smoke: jwks ok — ES256 P-256, kid ${key.kid}`);

// The one that proves the GCP topology: a full self-signed assertion → STS
// exchange → SA impersonation, executed inside the canary isolate.
let deep;
try {
  const res = await fetch(`${base}/healthz?deep=1`, { headers, signal: AbortSignal.timeout(30_000) });
  deep = await res.json();
  if (res.status !== 200) fail(`/healthz?deep=1: status ${res.status} body ${JSON.stringify(deep)}`);
} catch (e) {
  fail(`/healthz?deep=1: ${e.message}`);
}
if (deep.ok !== true || deep.deep !== true) fail(`/healthz?deep=1 body ${JSON.stringify(deep)}`);
if (deep.versionId !== expected) fail(`/healthz?deep=1 answered from version ${deep.versionId}, expected ${expected}`);
if (deep.wif?.minted !== true) fail(`/healthz?deep=1 did not mint a token: ${JSON.stringify(deep.wif)}`);
console.log(`smoke: deep ok — WIF minted an FCM access token in ${deep.wif.ms}ms`);
