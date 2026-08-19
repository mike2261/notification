import { type ErrorHandler, Hono } from "hono";
import { getPublicJwk } from "./auth/wif";
import type { FcmEnv } from "./fcm/client";
import { AppError, appErrorToBody, wrapError } from "./hxxp/error";
import { e2eApp } from "./routes/e2e";
import { parentApp } from "./routes/parent";

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

app.route("/v1/me", parentApp);
// Verification-only injection surface (design.md §7.4). Gated OFF in
// production; see src/routes/e2e.ts for why it is double-gated.
app.route("/v1/_test", e2eApp);

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
// exactly what the walking skeleton proved once and this probe keeps proving.
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

// OIDC discovery document. GCP's WIF provider fetches {issuer}/.well-known/
// openid-configuration first to learn jwks_uri before it ever requests
// /auth/jwks — skip this route and every STS exchange fails with "Error
// connecting to the given credential's issuer" (docs/walking-skeleton.md §4).
app.get("/.well-known/openid-configuration", (c) => {
  const issuer = c.env.WIF_ISSUER;
  return c.json({
    issuer,
    jwks_uri: `${issuer}/auth/jwks`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
  });
});

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

export { app };
