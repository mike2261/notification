import { beforeEach, describe, expect, it, vi } from "vitest";
import { b64url, parseJwt } from "../src/auth/jwt";
import { __resetWifCaches, FCM_SCOPE, getAccessToken, getPublicJwk, type WifEnv } from "../src/auth/wif";

// The walking skeleton exists to prove the GCP topology, and the half of that
// which does NOT need GCP is provable here: that workerd's Web Crypto produces
// an assertion Google will accept, and that the two requests we build have the
// exact shapes STS and iamcredentials require. Everything in this file would
// otherwise only fail in the console, where the error messages are worst.

const AUDIENCE =
  "//iam.googleapis.com/projects/000/locations/global/workloadIdentityPools/test-pool/providers/test-provider";

async function makeEnv(): Promise<{ env: WifEnv; publicKey: CryptoKey }> {
  // generateKey's return type is the CryptoKey | CryptoKeyPair union; an
  // asymmetric algorithm always yields the pair.
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  return {
    env: {
      WIF_PRIVATE_KEY: btoa(binary),
      WIF_ISSUER: "https://tuni-noti.test",
      WIF_SUBJECT: "tuni-noti",
      WIF_AUDIENCE: AUDIENCE,
      FCM_SA_EMAIL: "tuni-noti@test.iam.gserviceaccount.com",
    },
    publicKey: pair.publicKey,
  };
}

type Captured = { url: string; init: RequestInit };

function stubGoogle(captured: Captured[], expiresInMs = 3_600_000) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    if (url.startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "federated-token" }), { status: 200 });
    }
    if (url.includes("iamcredentials.googleapis.com")) {
      return new Response(
        JSON.stringify({
          accessToken: "sa-access-token",
          expireTime: new Date(Date.now() + expiresInMs).toISOString(),
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("wif", () => {
  beforeEach(() => {
    __resetWifCaches();
  });

  it("derives a public JWK whose kid is the RFC 7638 thumbprint", async () => {
    const { env } = await makeEnv();
    const jwk = await getPublicJwk(env);

    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(jwk.x).toBeTruthy();
    expect(jwk.y).toBeTruthy();

    // Recompute independently: canonical JSON of {crv,kty,x,y}, SHA-256, b64url.
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    expect(jwk.kid).toBe(b64url(new Uint8Array(digest)));
  });

  it("rejects an empty private key rather than minting something unusable", async () => {
    await expect(getPublicJwk({ ...(await makeEnv()).env, WIF_PRIVATE_KEY: "" })).rejects.toThrow(
      /WIF_PRIVATE_KEY is empty/,
    );
  });

  it("signs an assertion GCP can verify, and exchanges it correctly", async () => {
    const { env, publicKey } = await makeEnv();
    const captured: Captured[] = [];
    stubGoogle(captured);

    const token = await getAccessToken(env, FCM_SCOPE);
    expect(token).toBe("sa-access-token");
    expect(captured).toHaveLength(2);

    // --- 1) the STS token exchange -------------------------------------
    const [sts, iam] = captured;
    expect(sts.url).toBe("https://sts.googleapis.com/v1/token");
    const form = new URLSearchParams(sts.init.body as string);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(form.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(form.get("scope")).toBe(FCM_SCOPE);
    // Full resource name: leading `//`, no protocol. The console shows this
    // value with https:// and the API rejects that form.
    expect(form.get("audience")).toBe(AUDIENCE);
    expect(form.get("audience")).not.toMatch(/^https:/);

    // --- 2) the self-signed assertion ----------------------------------
    const assertion = form.get("subject_token") as string;
    const parsed = parseJwt(assertion);
    expect(parsed.header).toMatchObject({ alg: "ES256", typ: "JWT" });
    // The provider fetches our JWKS and picks the key by kid; a mismatch here
    // is an "invalid signature" from Google with nothing pointing at the cause.
    expect(parsed.header.kid).toBe((await getPublicJwk(env)).kid);
    expect(parsed.payload).toMatchObject({ iss: env.WIF_ISSUER, sub: env.WIF_SUBJECT, aud: AUDIENCE });
    expect(parsed.payload.exp as number).toBeGreaterThan(parsed.payload.iat as number);

    // Web Crypto's ECDSA output is raw R||S, which IS the JWS ES256 wire
    // format — no DER unwrapping. If that assumption were wrong, every
    // assertion would be rejected and the topology would look broken instead.
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      parsed.signature,
      new TextEncoder().encode(parsed.signingInput),
    );
    expect(verified).toBe(true);

    // --- 3) SA impersonation -------------------------------------------
    expect(iam.url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/tuni-noti@test.iam.gserviceaccount.com:generateAccessToken",
    );
    expect((iam.init.headers as Record<string, string>).Authorization).toBe("Bearer federated-token");
    expect(JSON.parse(iam.init.body as string)).toEqual({ scope: [FCM_SCOPE], lifetime: "3600s" });
  });

  it("scopes the token to FCM only, never cloud-platform", async () => {
    // Upstream's module constant is cloud-platform. Copying that would give a
    // notification service a credential for the whole project (design.md §4.6).
    expect(FCM_SCOPE).toBe("https://www.googleapis.com/auth/firebase.messaging");
    const { env } = await makeEnv();
    const captured: Captured[] = [];
    stubGoogle(captured);
    await getAccessToken(env);
    expect(new URLSearchParams(captured[0].init.body as string).get("scope")).toBe(FCM_SCOPE);
  });

  it("caches the token and dedupes concurrent mints into one exchange", async () => {
    const { env } = await makeEnv();
    const captured: Captured[] = [];
    stubGoogle(captured);

    // Concurrent callers must share one STS roundtrip, not race into several.
    const [a, b] = await Promise.all([getAccessToken(env), getAccessToken(env)]);
    expect(a).toBe(b);
    expect(captured).toHaveLength(2); // one STS + one impersonation, total

    await getAccessToken(env);
    expect(captured).toHaveLength(2); // served from cache
  });

  it("re-mints when the cached token is inside the expiry skew", async () => {
    const { env } = await makeEnv();
    const captured: Captured[] = [];
    // 30 s of life left, against a 60 s skew — must be treated as expired so an
    // in-flight request never carries a token that dies mid-call.
    stubGoogle(captured, 30_000);

    await getAccessToken(env);
    await getAccessToken(env);
    expect(captured).toHaveLength(4);
  });

  it("surfaces an STS rejection with its status and body", async () => {
    const { env } = await makeEnv();
    vi.stubGlobal("fetch", async () => new Response("bad audience", { status: 400 }));
    // The single most likely first-run failure: the provider's issuer does not
    // match WIF_ISSUER, or the audience carries an https:// prefix.
    await expect(getAccessToken(env)).rejects.toThrow(/STS exchange failed 400: bad audience/);
  });
});
