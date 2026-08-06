// src/auth/parent-jwt.ts
//
// Verifies robo-worker's parent-session JWT (design.md §1.4, §4.7): ES256,
// aud "robo-worker/parent", verified against a cached JWKS fetch. tuni-noti
// never holds a signing key for this — it only verifies.
//
// Deliberately hand-rolled (no JWT library), matching the convention already
// established by src/auth/wif.ts for the WIF signing side.

import type { MiddlewareHandler } from "hono";
import { extractBearer } from "../hxxp/bearer";
import { AppError } from "../hxxp/error";
import { parseJwt } from "./jwt";

export type ParentAuthEnv = {
  PARENT_JWKS_URL: string;
  PARENT_JWT_ISSUER: string;
  PARENT_JWT_AUDIENCE: string;
  /**
   * Optional service binding to the Worker serving PARENT_JWKS_URL.
   *
   * REQUIRED whenever that Worker sits on the SAME `*.workers.dev` subdomain
   * as this one: a plain `fetch()` to a sibling workers.dev hostname in the
   * same account does not reach the target Worker — it answers 404, while the
   * very same URL fetched from anywhere else answers 200. That failure looks
   * exactly like a misconfigured JWKS path, which is how it costs an hour.
   *
   * Left undefined when the two services are on different accounts (the
   * arrangement design.md §1.4 assumes), where the URL fetch is the only
   * option and works fine. Code keeps both paths for that reason.
   */
  PARENT_JWKS_SERVICE?: Fetcher;
};

type Jwk = { kty: string; crv: string; x: string; y: string; kid: string };

let jwksCache: Jwk[] | null = null;
let jwksInflight: Promise<Jwk[]> | null = null;

async function fetchJwks(env: ParentAuthEnv): Promise<Jwk[]> {
  // The URL is the single source of truth for the path either way: a service
  // binding routes by binding, not by hostname, so it takes the same URL and
  // simply ignores the host part.
  const resp = env.PARENT_JWKS_SERVICE
    ? await env.PARENT_JWKS_SERVICE.fetch(env.PARENT_JWKS_URL)
    : await fetch(env.PARENT_JWKS_URL);
  if (!resp.ok) throw new Error(`parent-jwt: JWKS fetch failed ${resp.status}`);
  const body = (await resp.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("parent-jwt: JWKS response missing keys[]");
  return body.keys;
}

async function getJwks(env: ParentAuthEnv, forceRefresh: boolean): Promise<Jwk[]> {
  if (jwksCache && !forceRefresh) return jwksCache;
  if (!jwksInflight) {
    jwksInflight = fetchJwks(env).finally(() => {
      jwksInflight = null;
    });
  }
  const keys = await jwksInflight;
  jwksCache = keys;
  return keys;
}

async function findKey(env: ParentAuthEnv, kid: string): Promise<Jwk> {
  let keys = await getJwks(env, false);
  let key = keys.find((k) => k.kid === kid);
  if (!key) {
    // Unknown kid → exactly one refetch (design.md §1.4 step 5), not a retry
    // loop — a kid that's still unknown after a fresh fetch is not ours.
    keys = await getJwks(env, true);
    key = keys.find((k) => k.kid === kid);
  }
  if (!key) throw new Error(`parent-jwt: unknown kid ${kid}`);
  return key;
}

/** Test seam: drop the cached JWKS so a suite can re-exercise the fetch. */
export function __resetParentJwksCache(): void {
  jwksCache = null;
  jwksInflight = null;
}

export async function verifyParentJwt(env: ParentAuthEnv, token: string): Promise<{ parentId: string }> {
  const parsed = parseJwt(token);

  // Strict alg pinning — no algorithm negotiation (design.md §1.4 step 5).
  // Checked BEFORE any key lookup or verify call so a token asserting "none"
  // or an unexpected alg is rejected without ever touching the JWKS.
  if (parsed.header.alg !== "ES256") {
    throw new Error("parent-jwt: unsupported alg");
  }

  const kid = parsed.header.kid;
  if (typeof kid !== "string" || !kid) {
    throw new Error("parent-jwt: missing kid");
  }

  const jwk = await findKey(env, kid);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    parsed.signature,
    new TextEncoder().encode(parsed.signingInput),
  );
  if (!valid) throw new Error("parent-jwt: bad signature");

  const payload = parsed.payload;
  if (payload.iss !== env.PARENT_JWT_ISSUER) throw new Error("parent-jwt: iss mismatch");
  if (payload.aud !== env.PARENT_JWT_AUDIENCE) throw new Error("parent-jwt: aud mismatch");

  const exp = payload.exp;
  const now = Math.floor(Date.now() / 1000);
  if (typeof exp !== "number" || exp <= now) throw new Error("parent-jwt: expired");

  const sub = payload.sub;
  if (typeof sub !== "string" || !sub) throw new Error("parent-jwt: missing sub");

  return { parentId: sub };
}

export type ParentAuthVariables = { parentId: string };

/**
 * Hono middleware: extracts the bearer token, verifies it, and sets
 * `parentId` in context. Any failure — missing header, bad signature, wrong
 * aud/iss, expired, unsupported alg — becomes a 401 (AppError "Authn"), never
 * a distinguishable error to the caller (design.md §1.4: never leak which
 * check failed to an unauthenticated caller beyond "not authenticated").
 */
export const requireParentAuth: MiddlewareHandler<{
  Bindings: ParentAuthEnv;
  Variables: ParentAuthVariables;
}> = async (c, next) => {
  let token: string;
  try {
    token = extractBearer(c.req.header("Authorization"));
  } catch (err) {
    throw new AppError("Authn", (err as Error).message);
  }
  try {
    const { parentId } = await verifyParentJwt(c.env, token);
    c.set("parentId", parentId);
  } catch (err) {
    throw new AppError("Authn", (err as Error).message);
  }
  await next();
};
