import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Real workerd, not node: the skeleton's whole point is that Web Crypto ES256
// signing, fetch, and the Workers request phase behave as they will in prod.
// D1 migrations are read here (Node side) and handed to the worker as a
// binding; `applyD1Migrations` (tests/setup.ts) then runs them inside workerd
// against the local D1 that vitest-pool-workers provisions for env.test.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      restoreMocks: true,
      setupFiles: ["tests/setup.ts"],
      teardownTimeout: 5000,
      hookTimeout: 20000,
    },
  };
});
