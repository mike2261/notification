// Usage:
//   SKELETON_TOKEN=... node scripts/skeleton-push.mjs <fcmDeviceToken> [title] [body]
//
// The last step of the walking skeleton (design.md §7.0): send one real push to
// one real handset and print exactly how FCM answered. Nothing else gets built
// until this prints "accepted".
const [deviceToken, title, body] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "https://tuni-noti.anhduc22601.workers.dev";
const auth = process.env.SKELETON_TOKEN;

if (!deviceToken || !auth) {
  console.error("usage: SKELETON_TOKEN=<secret> node scripts/skeleton-push.mjs <fcmDeviceToken> [title] [body]");
  console.error("  BASE_URL overrides the target Worker (default: production)");
  process.exit(2);
}

const res = await fetch(`${base}/_skeleton/push`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
  body: JSON.stringify({ token: deviceToken, ...(title ? { title } : {}), ...(body ? { body } : {}) }),
  signal: AbortSignal.timeout(30_000),
});

const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(`HTTP ${res.status} — non-JSON body:\n${text.slice(0, 500)}`);
  process.exit(1);
}

console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(parsed, null, 2));

const kind = parsed?.outcome?.kind;
if (kind === "accepted") {
  console.log("\n✅ FCM accepted the message. Check the handset.");
  console.log("   Note: accepted ≠ delivered — FCM does not tell us the rest (design.md §4.6).");
  process.exit(0);
}

// Map the failure back to the thing that is actually misconfigured, because
// the raw FCM error rarely names it.
const hint =
  {
    auth_error: "WIF or IAM. Check /healthz?deep=1 first — if that fails, the push was never going to work.",
    token_dead: "The device token is stale or from another sender. Re-read it from the handset.",
    token_dead_alert: "SENDER_ID_MISMATCH — the token belongs to a different Firebase project than FCM_PROJECT_ID.",
    payload_bug: "Our message shape is wrong — this is our bug, not the device's.",
    retry: "Transient (quota or 5xx). Retry.",
  }[kind] ?? "Unrecognised outcome.";
console.error(`\n❌ ${kind}: ${hint}`);
process.exit(1);
