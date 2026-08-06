// MUST stay the first import in the test entry too: arktype's JIT compiles with
// `new Function`, which workerd forbids outside script startup. See
// src/arktype-config.ts.
import "../src/arktype-config";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  if (!migrations) throw new Error("TEST_MIGRATIONS is required for D1 test setup");
  await applyD1Migrations(env.NOTI_D1, migrations);
});
