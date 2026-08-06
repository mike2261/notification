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

// Vite's import.meta.glob (used by tests/fixtures-contract.test.ts to bundle
// fixture JSON at build time, since workerd has no host filesystem access).
// `vite/client` isn't a resolvable types entry here (vite is a transitive dep
// of vitest, not a direct one), so declare just the shape actually used.
interface ImportMeta {
  glob(pattern: string, options?: { eager?: boolean; import?: string }): Record<string, unknown>;
}
