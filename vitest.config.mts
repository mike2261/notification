import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Real workerd, not node: the skeleton's whole point is that Web Crypto ES256
// signing, fetch, and the Workers request phase behave as they will in prod.
// `applyD1Migrations` and the D1 harness arrive with the scaffold (design §6.4).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
    }),
  ],
  test: {
    restoreMocks: true,
    setupFiles: ["tests/setup.ts"],
    teardownTimeout: 5000,
    hookTimeout: 20000,
  },
});
