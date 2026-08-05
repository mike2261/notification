import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Proves the Worker actually serves — the skeleton's own smoke test. No GCP
// call succeeds here (env.test has no WIF_PRIVATE_KEY), which is itself the
// point of the /auth/jwks and deep-healthz assertions below: they must fail
// *loudly and legibly*, because "misconfigured" is the state this route will
// spend its whole first day in.

const push = (body: unknown, auth?: string) =>
  SELF.fetch("https://tuni-noti.test/_skeleton/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });

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

describe("GET /auth/jwks", () => {
  it("503s with a legible reason when the signing key is missing", async () => {
    const res = await SELF.fetch("https://tuni-noti.test/auth/jwks");
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringMatching(/WIF_PRIVATE_KEY/) });
  });
});

describe("POST /_skeleton/push", () => {
  it("401s with no Authorization header", async () => {
    expect((await push({ token: "t" })).status).toBe(401);
  });

  it("401s on a wrong bearer", async () => {
    expect((await push({ token: "t" }, "Bearer nope")).status).toBe(401);
  });

  it("401s on a non-bearer scheme", async () => {
    expect((await push({ token: "t" }, "Basic dGVzdA==")).status).toBe(401);
  });

  // The ordering assertion: auth runs before validation, so a bad body from an
  // unauthenticated caller is 401 — never 422. A 422 here would mean we parse
  // untrusted input before deciding whether the caller may speak to us at all.
  it("rejects an unauthenticated malformed body as 401, not 422", async () => {
    expect((await push({ nope: 1 })).status).toBe(401);
  });

  it("422s an authenticated malformed body", async () => {
    expect((await push({ nope: 1 }, "Bearer test-skeleton-token")).status).toBe(422);
    expect((await push({ token: "" }, "Bearer test-skeleton-token")).status).toBe(422);
  });

  it("does not report success when the send could not happen", async () => {
    // Authenticated and well-formed, but there is no signing key, so the mint
    // fails and the outcome is auth_error → 502. The skeleton must never make
    // a topology failure look like a delivered push.
    const res = await push({ token: "dev-handset-token" }, "Bearer test-skeleton-token");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { outcome: { kind: string; reason: string } };
    expect(body.outcome.kind).toBe("auth_error");
    expect(body.outcome.reason).toMatch(/wif mint failed/);
  });
});
