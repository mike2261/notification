// Usage: node scripts/gen-wif-key.mjs
//
// Mints the ES256 keypair that WIF_PRIVATE_KEY holds. The format is exact and
// unforgiving: src/auth/wif.ts does `atob(secret)` then imports the result as
// PKCS#8 DER, so the secret must be the DER bytes, base64, on ONE line — not
// PEM, no armour, no newlines. Getting this wrong produces an import error at
// the first request and nothing that points at the format.
//
// The private key is printed once and never stored. Pipe it straight into
// wrangler:
//
//   node scripts/gen-wif-key.mjs                       # inspect
//   node scripts/gen-wif-key.mjs --raw | npx wrangler secret put WIF_PRIVATE_KEY
import { webcrypto } from "node:crypto";

const raw = process.argv.includes("--raw");

const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");

if (raw) {
  // No trailing newline: `wrangler secret put` would otherwise store it, and
  // wif.ts only survives that because it calls .trim(). Don't rely on that.
  process.stdout.write(pkcs8);
  process.exit(0);
}

const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
// RFC 7638 thumbprint — the same derivation src/auth/wif.ts uses for `kid`.
const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
const kid = Buffer.from(digest).toString("base64url");

console.log("WIF_PRIVATE_KEY (PKCS#8 DER, base64, one line) — store as a secret, never commit:\n");
console.log(pkcs8);
console.log("\nPublic JWK that /auth/jwks will serve:\n");
console.log(JSON.stringify({ ...jwk, alg: "ES256", use: "sig", kid }, null, 2));
console.log(`\nkid: ${kid}`);
console.log("\nNext: node scripts/gen-wif-key.mjs --raw | npx wrangler secret put WIF_PRIVATE_KEY");
console.log("(that regenerates a DIFFERENT key — to keep this one, paste the base64 above instead)");
