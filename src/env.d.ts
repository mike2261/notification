// Secrets are never declared in wrangler.jsonc, so `wrangler types` cannot see
// them. Declaration merging adds them to the generated Env — keep this list in
// sync with `wrangler secret list`.
//
//   WIF_PRIVATE_KEY — PKCS#8 DER of the ES256 signing key, base64, one line.
//                     Long-lived: WIF is not "keyless" (design.md §4.6).
//   SKELETON_TOKEN  — bearer for POST /_skeleton/push. Walking skeleton only;
//                     goes away with the route.
interface Env {
  WIF_PRIVATE_KEY: string;
  SKELETON_TOKEN?: string;
}
