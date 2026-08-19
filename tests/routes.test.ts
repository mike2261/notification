import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Proves the Worker actually serves. No GCP call succeeds here (env.test has
// no WIF_PRIVATE_KEY), which is itself the point of the /auth/jwks and
// deep-healthz assertions below: they must fail *loudly and legibly*, because
// "misconfigured" is the state these routes will spend their whole first day
// in.

describe("GET /healthz", () => {
  it("answers shallow without touching GCP", async () => {
    const res = await SELF.fetch("https://tuni-noti.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("deep=1 reports the WIF failure instead of pretending to be healthy", async () => {
    // No WIF_PRIVATE_KEY in env.test, so the mint must fail — and a health
    // probe that returned 200 here would defeat its own purpose.
    const res = await SELF.fetch("https://tuni-noti.test/healthz?deep=1");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; wif: { minted: boolean; error: string } };
    expect(body.ok).toBe(false);
    expect(body.wif.minted).toBe(false);
    expect(body.wif.error).toMatch(/WIF_PRIVATE_KEY/);
  });
});

describe("GET /.well-known/openid-configuration", () => {
  it("points jwks_uri at this issuer's /auth/jwks", async () => {
    const res = await SELF.fetch("https://tuni-noti.test/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: "https://tuni-noti.test",
      jwks_uri: "https://tuni-noti.test/auth/jwks",
    });
  });
});

describe("GET /auth/jwks", () => {
  it("503s with a legible reason when the signing key is missing", async () => {
    const res = await SELF.fetch("https://tuni-noti.test/auth/jwks");
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringMatching(/WIF_PRIVATE_KEY/) });
  });
});

