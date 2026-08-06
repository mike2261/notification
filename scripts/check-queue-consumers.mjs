#!/usr/bin/env node
// Asserts every queue this Worker declares a consumer for actually HAS a
// consumer registered on Cloudflare.
//
// Why this exists, concretely: the first full deploy of this service went out
// through `wrangler versions upload` + `versions deploy` (scripts/deploy.sh),
// every smoke passed, /healthz was green — and all three queues reported
// `Number of Consumers: 0`. Queue consumer registration is a NON-VERSIONED
// setting, and the versions path syncs only some of those (it names the ones
// it syncs: logpush, observability, tail_consumers). Nothing warned. Events
// would have piled up in a queue nobody read until the retention window ate
// them.
//
// A plain `wrangler deploy` (pnpm deploy:direct) registers them. Once
// registered they survive later versions-based deploys, which is exactly what
// makes this dangerous: the gap is invisible except on the FIRST deploy that
// introduces or changes a consumer — a new queue, a changed max_batch_size, a
// changed DLQ. That is a bad day to find out.
//
// Run after promotion. Exit 1 names the queues and the remedy.

import { execFileSync } from "node:child_process";
import { unstable_readConfig } from "wrangler";

const config = unstable_readConfig({ config: "wrangler.jsonc" });
const declared = (config.queues?.consumers ?? []).map((c) => c.queue);

if (declared.length === 0) {
  console.log("queue-consumers: none declared — nothing to check");
  process.exit(0);
}

const missing = [];
for (const queue of declared) {
  // `queues info` has no --json, so parse its one relevant line. A parse miss
  // is treated as missing rather than passing: the whole point is that silence
  // must not read as success.
  const out = execFileSync("npx", ["wrangler", "queues", "info", queue], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const match = out.match(/Number of Consumers:\s*(\d+)/);
  const count = match ? Number(match[1]) : 0;
  console.log(`queue-consumers: ${queue} → ${match ? count : "unparseable"}`);
  if (count < 1) missing.push(queue);
}

if (missing.length > 0) {
  console.error(`\nqueue-consumers: NO consumer registered for: ${missing.join(", ")}`);
  console.error("The deploy succeeded and the Worker is healthy, but these queues have no reader.");
  console.error("Fix with one direct deploy (it registers non-versioned settings):\n");
  console.error("  pnpm deploy:direct\n");
  process.exit(1);
}

console.log("queue-consumers: ok — every declared consumer is registered");
