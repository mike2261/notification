import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { b64url, jsonBytes } from "../src/auth/jwt";
import { __resetParentJwksCache } from "../src/auth/parent-jwt";

async function makeKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function jwkFromPublicKey(publicKey: CryptoKey, kid: string) {
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey & { x: string; y: string };
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" };
}

async function signJwt(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", kid };
  const signingInput = `${b64url(jsonBytes(header))}.${b64url(jsonBytes(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

let keyPair: CryptoKeyPair;

async function tokenFor(parentId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(keyPair.privateKey, "route-test-key", {
    sub: parentId,
    iss: env.PARENT_JWT_ISSUER,
    aud: env.PARENT_JWT_AUDIENCE,
    iat: now,
    exp: now + 3600,
  });
}

beforeEach(async () => {
  __resetParentJwksCache();
  keyPair = await makeKeyPair();
  const jwk = await jwkFromPublicKey(keyPair.publicKey, "route-test-key");
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === env.PARENT_JWKS_URL) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    throw new Error(`unexpected fetch in route test: ${url}`);
  });
});

describe("POST /v1/me/devices", () => {
  it("401s with no Authorization header", async () => {
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "t1", platform: "android", appVersion: "1.0.0" }),
    });
    expect(res.status).toBe(401);
  });

  it("registers a device and returns an opaque deviceId", async () => {
    const jwt = await tokenFor("par_route_1");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ token: "route-tok-1", platform: "android", appVersion: "1.0.0" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: string };
    expect(body.deviceId).toBeTruthy();
  });

  it("422s a malformed body", async () => {
    const jwt = await tokenFor("par_route_1");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ token: "", platform: "android", appVersion: "1.0.0" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("DELETE /v1/me/devices/:deviceId", () => {
  it("404s an unknown deviceId", async () => {
    const jwt = await tokenFor("par_route_2");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/devices/does-not-exist", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
  });

  it("204s and disables an owned device", async () => {
    const jwt = await tokenFor("par_route_3");
    const reg = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ token: "route-tok-3", platform: "android", appVersion: "1.0.0" }),
    });
    const { deviceId } = (await reg.json()) as { deviceId: string };

    const res = await SELF.fetch(`https://tuni-noti.test/v1/me/devices/${deviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(204);
  });

  it("404s a device owned by a different parent", async () => {
    const jwtOwner = await tokenFor("par_route_owner");
    const reg = await SELF.fetch("https://tuni-noti.test/v1/me/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtOwner}` },
      body: JSON.stringify({ token: "route-tok-owner", platform: "android", appVersion: "1.0.0" }),
    });
    const { deviceId } = (await reg.json()) as { deviceId: string };

    const jwtIntruder = await tokenFor("par_route_intruder");
    const res = await SELF.fetch(`https://tuni-noti.test/v1/me/devices/${deviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwtIntruder}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET/PATCH /v1/me/preferences", () => {
  it("401s with no Authorization header", async () => {
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/preferences");
    expect(res.status).toBe(401);
  });

  it("GET returns defaults on first contact", async () => {
    const jwt = await tokenFor("par_route_prefs_1");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      timezone: "Asia/Ho_Chi_Minh",
      progressEnabled: true,
      weeklyEnabled: true,
      quietStart: null,
      quietEnd: null,
      dailyCap: 10,
    });
  });

  it("PATCH updates and GET reflects it", async () => {
    const jwt = await tokenFor("par_route_prefs_2");
    const patchRes = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ weeklyEnabled: false, quietStart: "22:00", quietEnd: "06:30" }),
    });
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({ weeklyEnabled: false, quietStart: "22:00", quietEnd: "06:30" });

    const getRes = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(await getRes.json()).toMatchObject({ weeklyEnabled: false, quietStart: "22:00", quietEnd: "06:30" });
  });

  it("PATCH rejects a malformed quiet-hours time", async () => {
    const jwt = await tokenFor("par_route_prefs_3");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ quietStart: "9pm" }),
    });
    expect(res.status).toBe(422);
  });

  it("PATCH rejects an invalid IANA timezone", async () => {
    const jwt = await tokenFor("par_route_prefs_4");
    const res = await SELF.fetch("https://tuni-noti.test/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ timezone: "Not/AZone" }),
    });
    expect(res.status).toBe(422);
  });
});
