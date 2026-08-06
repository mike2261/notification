// TEST_MIGRATIONS is a Miniflare-only binding (vitest.config.mts's
// `miniflare.bindings`) — it never appears in wrangler.jsonc, so `wrangler
// types` can't see it and it's absent from the generated Env. Declaration
// merging adds it to `Cloudflare.Env`, which backs the `env` export from both
// `cloudflare:workers` and `cloudflare:test` (tests/setup.ts uses the former).
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
