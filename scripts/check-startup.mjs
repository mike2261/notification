#!/usr/bin/env node
// Startup-CPU gate for the structural refactor (spec 2026-07-31 §6.4).
// `wrangler deploy --dry-run` only proves the Worker BUNDLES; deploy-validator
// error 10021 measures top-level execution, which only `wrangler check startup`
// exercises locally. Local CPU ≠ Cloudflare CPU, so this is an order-of-
// magnitude tripwire, not a precise mirror: baseline ~91ms (2026-07-31),
// Cloudflare's hard limit 400ms. A section that accidentally makes
// src/index.ts static-import the deferred app/course graph lands far above
// the ceiling; normal drift stays far below it.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const OUTFILE = "dist/worker-startup.cpuprofile";
const CEILING_MS = 300;

execFileSync("npx", ["wrangler", "check", "startup", "--outfile", OUTFILE], { stdio: "inherit" });
const profile = JSON.parse(readFileSync(OUTFILE, "utf8"));
const ms = (profile.endTime - profile.startTime) / 1000;
rmSync(OUTFILE, { force: true });

if (ms > CEILING_MS) {
  console.error(
    `startup profile ${ms.toFixed(0)}ms exceeds the ${CEILING_MS}ms ceiling — ` +
      "did a section break the src/index.ts lazy-load boundary?",
  );
  process.exit(1);
}
console.log(`startup ${ms.toFixed(0)}ms (ceiling ${CEILING_MS}ms) — ok`);
