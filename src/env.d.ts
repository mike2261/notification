// Secrets are never declared in wrangler.jsonc, so `wrangler types` cannot see
// them. Declaration merging adds them to the generated Env — keep this list in
// sync with `wrangler secret list`.
//
//   WIF_PRIVATE_KEY — PKCS#8 DER of the ES256 signing key, base64, one line.
//                     Long-lived: WIF is not "keyless" (design.md §4.6).
//   E2E_TOKEN       — bearer for POST /v1/_test/emit (design.md §7.4). Only
//                     meaningful while E2E_ENABLED is "1".
interface Env {
  WIF_PRIVATE_KEY: string;
  E2E_TOKEN?: string;
}
