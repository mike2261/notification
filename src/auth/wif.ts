// src/auth/wif.ts
//
// Workload Identity Federation auth helper. Copied from robo-worker
// (src/auth/wif.ts) with three deliberate changes — see design.md §4.6:
//
//   1. `scope` is a PARAMETER, not the module constant it is upstream. FCM
//      needs https://www.googleapis.com/auth/firebase.messaging, and a token
//      scoped to cloud-platform would be a far wider credential than this
//      service has any business holding.
//   2. Provider identity comes from `env`, not from hardcoded constants.
//      Upstream hardcodes them as "not secrets, just config", which is true —
//      but tuni-noti's pool/provider/SA do not exist until someone finishes the
//      console work, and a var means that work lands in wrangler.jsonc instead
//      of a code edit.
//   3. `getIdToken` is DROPPED. It exists upstream to authenticate Cloud Run
//      service-to-service calls; tuni-noti calls Google APIs only, which take
//      access tokens. Copying it would carry an unused SA self-impersonation
//      loop (and its IAM binding) for nothing.
//
// Two public surfaces:
//   getPublicJwk(env)              — public half of the ES256 signing key,
//                                    served at /auth/jwks so the WIF provider
//                                    can verify our self-signed assertions.
//   getAccessToken(env, scope)     — cached, deduped Google access token for
//                                    the configured SA, at the given scope.
//
// Module-level caches: the keypair never changes within an isolate, and tokens
// are cached per (SA, scope) so concurrent requests share one STS roundtrip.

import { b64url, jsonBytes } from "./jwt";

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

// Refresh slightly before the server-stated expiry so an in-flight request
// never races a token that is about to fall off.
const TOKEN_EXPIRY_SKEW_MS = 60_000;
// The self-signed JWT is exchanged immediately, so a short life is fine.
const JWT_LIFETIME_SEC = 600;

// Internal per-mint timeout. The mint is shared across callers via the
// in-flight map, so it owns its OWN deadline rather than accepting a caller's
// AbortSignal — one caller timing out must never abort a mint others await.
const MINT_TIMEOUT_MS = 10_000;

export type WifEnv = {
  WIF_PRIVATE_KEY: string;
  WIF_ISSUER: string;
  WIF_SUBJECT: string;
  WIF_AUDIENCE: string;
  FCM_SA_EMAIL: string;
};

export type WifPublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  alg: "ES256";
  use: "sig";
  kid: string;
};

export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = MINT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- public API ---------------------------------------------------------

export function getPublicJwk(env: WifEnv): Promise<WifPublicJwk> {
  return getKeys(env).then((k) => k.publicJwk);
}

/**
 * A Google access token for `env.FCM_SA_EMAIL` at `scope`, cached until just
 * before expiry and deduped while in flight.
 *
 * Upstream keeps both the cache wrapper and the mint module-private and exposes
 * only `getIdToken`; this is the equivalent public entry point (design.md §4.2).
 */
export async function getAccessToken(env: WifEnv, scope: string = FCM_SCOPE): Promise<string> {
  const key = `${env.FCM_SA_EMAIL}|${scope}`;
  const cached = accessTokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
    return cached.value;
  }
  const inflight = accessTokenInflight.get(key);
  if (inflight) return inflight;
  const p = mintFreshAccessToken(env, scope, key);
  accessTokenInflight.set(key, p);
  try {
    return await p;
  } finally {
    accessTokenInflight.delete(key);
  }
}

/** Test seam: drop cached keys and tokens so a suite can re-exercise the mint. */
export function __resetWifCaches(): void {
  cachedKeys = null;
  accessTokenCache.clear();
  accessTokenInflight.clear();
}

// --- key import + JWK derivation ---------------------------------------

let cachedKeys: Promise<{ privateKey: CryptoKey; publicJwk: WifPublicJwk }> | null = null;

function getKeys(env: WifEnv): Promise<{ privateKey: CryptoKey; publicJwk: WifPublicJwk }> {
  if (!cachedKeys) cachedKeys = importKeys(env.WIF_PRIVATE_KEY);
  return cachedKeys;
}

async function importKeys(b64: string): Promise<{ privateKey: CryptoKey; publicJwk: WifPublicJwk }> {
  if (!b64) throw new Error("wif: WIF_PRIVATE_KEY is empty");
  // Secret is the PKCS#8 DER bytes base64-encoded as one line.
  const der = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const full = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey & { x?: string; y?: string };
  if (full.kty !== "EC" || full.crv !== "P-256" || !full.x || !full.y) {
    throw new Error("wif: unexpected EC P-256 JWK shape on export");
  }
  const kid = await jwkThumbprint({ crv: "P-256", kty: "EC", x: full.x, y: full.y });
  return {
    privateKey,
    publicJwk: { kty: "EC", crv: "P-256", x: full.x, y: full.y, alg: "ES256", use: "sig", kid },
  };
}

// --- access-token mint flow --------------------------------------------

const accessTokenCache = new Map<string, { value: string; expiresAt: number }>();
const accessTokenInflight = new Map<string, Promise<string>>();

async function mintFreshAccessToken(env: WifEnv, scope: string, cacheKey: string): Promise<string> {
  const t0 = Date.now();
  const jwt = await mintSelfSignedJwt(env);

  // 1) Token exchange: self-signed JWT → federated access token.
  const stsResp = await fetchWithTimeout("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: env.WIF_AUDIENCE,
      scope,
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: jwt,
    }).toString(),
  });
  if (!stsResp.ok) {
    throw new Error(`wif: STS exchange failed ${stsResp.status}: ${(await stsResp.text()).slice(0, 300)}`);
  }
  const stsData = (await stsResp.json()) as { access_token: string };

  // 2) Service-account impersonation: federated token → SA access token.
  // The WIF principal needs an impersonation grant on this SA — prefer
  // roles/iam.workloadIdentityUser over serviceAccountTokenCreator, which also
  // grants signing (design.md §4.6 step 5).
  const saEmail = env.FCM_SA_EMAIL;
  const iamResp = await fetchWithTimeout(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:generateAccessToken`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${stsData.access_token}`,
      },
      body: JSON.stringify({ scope: [scope], lifetime: "3600s" }),
    },
  );
  if (!iamResp.ok) {
    throw new Error(
      `wif: SA impersonation (${saEmail}) failed ${iamResp.status}: ${(await iamResp.text()).slice(0, 300)}`,
    );
  }
  const iamData = (await iamResp.json()) as { accessToken: string; expireTime: string };

  accessTokenCache.set(cacheKey, {
    value: iamData.accessToken,
    expiresAt: new Date(iamData.expireTime).getTime(),
  });
  console.log(`[wif] minted SA token for ${saEmail} in ${Date.now() - t0}ms (exp ${iamData.expireTime})`);
  return iamData.accessToken;
}

async function mintSelfSignedJwt(env: WifEnv): Promise<string> {
  const { privateKey, publicJwk } = await getKeys(env);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", kid: publicJwk.kid };
  const claim = {
    iss: env.WIF_ISSUER,
    sub: env.WIF_SUBJECT,
    aud: env.WIF_AUDIENCE,
    iat: now,
    exp: now + JWT_LIFETIME_SEC,
  };
  const signingInput = `${b64url(jsonBytes(header))}.${b64url(jsonBytes(claim))}`;
  // Web Crypto's ECDSA sign already returns raw R||S concatenated bytes, which
  // is exactly the JWS ES256 wire format. No DER<->JOSE conversion.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// --- helpers -----------------------------------------------------------

// RFC 7638 JWK thumbprint: SHA-256 of canonical JSON of the required public
// members (for EC: crv, kty, x, y) in lexicographic order, base64url-encoded.
async function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return b64url(new Uint8Array(digest));
}
