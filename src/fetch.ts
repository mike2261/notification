import { type } from "arktype";
import { type ErrorHandler, Hono, type MiddlewareHandler } from "hono";
import { getPublicJwk } from "./auth/wif";
import { type FcmEnv, sendOne } from "./fcm/client";
import { extractBearer } from "./hxxp/bearer";
import { AppError, appErrorToBody, wrapError } from "./hxxp/error";
import { validate } from "./hxxp/validator";

export type AppContext = {
  Bindings: Env;
};

const app = new Hono<AppContext>();

export const appOnError: ErrorHandler<AppContext> = (err, c) => {
  const errAppMaybe = AppError.fromPrimitiveError(err);
  const errApp = errAppMaybe || wrapError(err);
  c.status(errApp.httpCode);

  if (errApp.code === "Database" || errApp.code === "Service" || errApp.code === "Other") {
    console.debug("api:error", err);
  }

  return c.json(appErrorToBody(errApp));
};

app.onError(appOnError);

// --- Routes ---

// Deploy-time health probe. Shallow: proves the app serves and reports which
// Worker version answered (deploy.sh asserts this id, because a version-override
// header falls back to the live version silently when it is wrong).
//
// deep=1 mints a REAL FCM access token through the full WIF chain — self-signed
// ES256 assertion → STS exchange → SA impersonation. That is this service's
// analogue of robo-worker's ensureCourseRuntime() probe: the failure it catches
// (a WIF provider that cannot verify our JWKS, a missing IAM binding, a wrong
// audience form) is invisible to bundling and to a shallow ping, and it is
// exactly what the walking skeleton exists to prove.
app.get("/healthz", async (c) => {
  const versionId = c.env.CF_VERSION_METADATA?.id ?? null;
  if (c.req.query("deep") === undefined) return c.json({ ok: true, versionId });

  const t0 = Date.now();
  try {
    const token = await getAccessTokenForHealth(c.env);
    return c.json({
      ok: true,
      versionId,
      deep: true,
      // Never the token itself — only enough to prove one was minted.
      wif: { minted: true, tokenLength: token.length, ms: Date.now() - t0 },
    });
  } catch (err) {
    return c.json({ ok: false, versionId, deep: true, wif: { minted: false, error: (err as Error).message } }, 503);
  }
});

async function getAccessTokenForHealth(env: Env): Promise<string> {
  const { getAccessToken } = await import("./auth/wif");
  return getAccessToken(env as unknown as FcmEnv);
}

// JWKS endpoint for Workload Identity Federation. GCP's WIF provider fetches
// this URL to verify our self-signed assertions, so it must be reachable from
// Google's servers and must sit at exactly the issuer the provider is
// configured with. The public JWK is derived at runtime from WIF_PRIVATE_KEY by
// src/auth/wif.ts — one source of truth, no drift between endpoint and signer.
app.get("/auth/jwks", async (c) => {
  try {
    const publicJwk = await getPublicJwk(c.env as unknown as FcmEnv);
    // JWKS rotation is rare; clients (including GCP) re-fetch on a
    // verification miss.
    c.header("Cache-Control", "public, max-age=86400");
    return c.json({ keys: [publicJwk] });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 503);
  }
});

const skeletonPushBody = type({
  // A real device registration token from a dev handset.
  token: "string > 0",
  "title?": "string",
  "body?": "string",
});

// The walking skeleton's one endpoint (design.md §7.0): send a single real push
// and report exactly how FCM answered.
//
// Double-gated on purpose. This route mints a Google credential and sends real
// pushes, so an unauthenticated version of it on a public URL would be a free
// push relay backed by our SA. SKELETON_ENABLED stays "0" in wrangler.jsonc and
// is flipped only while someone is actively running §7.0; SKELETON_TOKEN is a
// dashboard secret. Delete this route once the consumer exists — it has no
// place in the real service.
//
// Middleware order is load-bearing: gate → auth → validate. A disabled route
// must 404 before anything else runs (otherwise a malformed body returns 422
// and advertises that the route exists), and an unauthenticated request must
// never get its body parsed.
const skeletonGate: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.env.SKELETON_ENABLED !== "1") throw new AppError("NotExist", "not found");
  const expected = c.env.SKELETON_TOKEN;
  if (!expected) throw new AppError("Service", "SKELETON_TOKEN is unset");
  let presented: string;
  try {
    presented = extractBearer(c.req.header("Authorization"));
  } catch (err) {
    throw new AppError("Authn", (err as Error).message);
  }
  if (!timingSafeEqual(presented, expected)) throw new AppError("Authn", "bad skeleton token");
  await next();
};

app.post("/_skeleton/push", skeletonGate, validate("json", skeletonPushBody), async (c) => {
  const { token, title, body } = c.req.valid("json");
  const outcome = await sendOne(c.env as unknown as FcmEnv, {
    token,
    notification: {
      title: title ?? "Tuni",
      body: body ?? "Xin chào! Đây là thông báo thử nghiệm từ Tuni.",
    },
    android: {
      // Mirrors the real message shape (design.md §4.6): a per-child collapse
      // key so a newer progress push replaces a stale one instead of stacking,
      // and a TTL because a progress push older than a few hours is noise.
      collapse_key: "skeleton",
      ttl: "3600s",
      priority: "high",
    },
  });

  console.log(`[skeleton] fcm outcome=${outcome.kind}`);
  // 200 only when FCM accepted it. Anything else is a topology problem the
  // skeleton exists to surface, so it must not look like success.
  return c.json({ outcome }, outcome.kind === "accepted" ? 200 : 502);
});

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export { app };
