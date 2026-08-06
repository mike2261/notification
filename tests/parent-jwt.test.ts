import { beforeEach, describe, expect, it, vi } from "vitest";
import { b64url, jsonBytes } from "../src/auth/jwt";
import { __resetParentJwksCache, verifyParentJwt } from "../src/auth/parent-jwt";

const ENV = {
  PARENT_JWKS_URL: "https://robo-worker.test/auth/jwks",
  PARENT_JWT_ISSUER: "https://robo-worker.test",
  PARENT_JWT_AUDIENCE: "robo-worker/parent",
};

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

function stubJwks(keys: unknown[]) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === ENV.PARENT_JWKS_URL) return new Response(JSON.stringify({ keys }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("verifyParentJwt", () => {
  beforeEach(() => {
    __resetParentJwksCache();
  });

  it("accepts a validly signed, current token", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k1", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    });
    const result = await verifyParentJwt(ENV, jwt);
    expect(result).toEqual({ parentId: "par_1" });
  });

  it("refetches the JWKS once on an unknown kid, then verifies", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k2");
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls++;
      if (url !== ENV.PARENT_JWKS_URL) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify({ keys: calls === 1 ? [] : [jwk] }), { status: 200 });
    });
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k2", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    });
    const result = await verifyParentJwt(ENV, jwt);
    expect(result).toEqual({ parentId: "par_1" });
    expect(calls).toBe(2);
  });

  it("rejects a token signed by a key not in the JWKS", async () => {
    const pair = await makeKeyPair();
    const otherPair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    // Signed by otherPair but claims kid "k1" — the JWKS holds pair's key, so
    // verification against the wrong public key must fail.
    const jwt = await signJwt(otherPair.privateKey, "k1", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    });
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/bad signature/);
  });

  it("rejects an expired token", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k1", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now - 7200,
      exp: now - 3600,
    });
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/expired/);
  });

  it("rejects a wrong audience", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k1", {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: "someone-else/parent",
      iat: now,
      exp: now + 3600,
    });
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/aud mismatch/);
  });

  it("rejects a wrong issuer", async () => {
    const pair = await makeKeyPair();
    const jwk = await jwkFromPublicKey(pair.publicKey, "k1");
    stubJwks([jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(pair.privateKey, "k1", {
      sub: "par_1",
      iss: "https://evil.test",
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    });
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/iss mismatch/);
  });

  it("rejects a non-ES256 alg without attempting verification (no algorithm negotiation)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "none", typ: "JWT", kid: "k1" };
    const payload = {
      sub: "par_1",
      iss: ENV.PARENT_JWT_ISSUER,
      aud: ENV.PARENT_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    };
    // Dummy non-empty signature segment so parseJwt's shape check passes and
    // execution reaches the alg check — this test is about alg, not shape.
    const jwt = `${b64url(jsonBytes(header))}.${b64url(jsonBytes(payload))}.AA`;
    await expect(verifyParentJwt(ENV, jwt)).rejects.toThrow(/unsupported alg/);
  });
});
