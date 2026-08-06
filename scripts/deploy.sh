#!/bin/sh
# Safe deploy pipeline, mirroring robo-worker's (design.md §4.1 — one deploy
# protocol across both services):
#   1. `versions upload`  — Cloudflare-side startup validation, retried (10021 flake).
#   2. 0%-traffic canary  — deploy <live>@100% + <new>@0%.
#   3. smoke via version-override header (scripts/deploy-smoke.mjs): asserts the
#      RESPONDING version id equals the new one, that /auth/jwks serves a usable
#      ES256 key, and that /healthz?deep=1 mints a real FCM access token through
#      the full WIF chain IN the new isolate.
#   4. promote to 100%.
# A state-aware EXIT trap restores <live>@100% on ANY exit between canary
# creation and successful promotion. After promotion there is deliberately no
# auto-rollback: flapping traffic is worse than a loud error.
#
# BOOTSTRAP=1 relaxes the smoke to shallow-only. Use it for the FIRST deploy
# only — the WIF provider's issuer is this Worker's URL, so the Worker must
# exist before the provider can be created (docs/walking-skeleton.md §1).
set -eu

BASE_URL="${BASE_URL:-https://tuni-noti.anhduc22601.workers.dev}"
SMOKE_ARGS=""
if [ "${BOOTSTRAP:-0}" = "1" ]; then
  SMOKE_ARGS="--bootstrap"
  echo "BOOTSTRAP=1 — smoke will assert shallow health only"
fi

status_out=$(npx wrangler deployments status 2>/dev/null || true)
# Exactly ONE version total: a lone (100%). A leftover 0% canary from an
# aborted run also fails this check — clean it up first, so this run starts
# from an unambiguous state.
version_count=$(printf '%s\n' "$status_out" | grep -cE "\([0-9]+%\)" || true)
live_count=$(printf '%s\n' "$status_out" | grep -c "(100%)" || true)
if [ "$version_count" != "1" ] || [ "$live_count" != "1" ]; then
  echo "expected exactly one version, at 100%, in 'wrangler deployments status' (found $version_count version(s), $live_count at 100%) — aborting before any change" >&2
  echo "if a leftover canary exists: npx wrangler versions deploy <live-id>@100% -y" >&2
  printf '%s\n' "$status_out" >&2
  exit 1
fi
live=$(printf '%s\n' "$status_out" | sed -n 's/.*(100%)[[:space:]]*\([0-9a-f-]\{36\}\).*/\1/p' | head -1)
if [ -z "$live" ]; then
  echo "could not parse the live version id — aborting before any change" >&2
  exit 1
fi
echo "live version: $live"

canary_active=0
restore_live() {
  if [ "$canary_active" = "1" ]; then
    echo "deploy did not complete — restoring $live@100%" >&2
    if npx wrangler versions deploy "$live@100%" -y >/dev/null 2>&1; then
      echo "restored $live@100% (canary dropped)" >&2
    else
      echo "CRITICAL: could not restore the live version automatically." >&2
      echo "Run manually: npx wrangler versions deploy $live@100% -y" >&2
    fi
  fi
}
trap restore_live EXIT
trap 'exit 130' HUP INT TERM

attempts=1
max_attempts=3
while true; do
  if out=$(npx wrangler versions upload --minify 2>&1); then
    printf '%s\n' "$out"
    break
  fi
  printf '%s\n' "$out" >&2
  if [ "$attempts" -ge "$max_attempts" ]; then
    echo "versions upload failed $attempts times — likely a real startup regression, not validator flake." >&2
    echo "profile with: npx wrangler check startup" >&2
    exit 1
  fi
  attempts=$((attempts + 1))
  echo "upload failed — retrying ($attempts/$max_attempts)..." >&2
done

id=$(printf '%s\n' "$out" | sed -n 's/^Worker Version ID: \([0-9a-f-]*\).*/\1/p' | head -1)
if [ -z "$id" ]; then
  echo "could not parse Worker Version ID from upload output" >&2
  exit 1
fi

echo "deploying canary: $live@100% + $id@0%"
canary_active=1
npx wrangler versions deploy "$live@100%" "$id@0%" -y

# shellcheck disable=SC2086 # SMOKE_ARGS is intentionally word-split
node scripts/deploy-smoke.mjs "$BASE_URL" "$id" $SMOKE_ARGS

npx wrangler versions deploy "$id@100%" -y
# Promoted and healthy — from here on, never auto-revert traffic.
canary_active=0

# Queue consumer registration is a NON-VERSIONED setting that this versions
# path does NOT sync (it prints the ones it does: logpush, observability,
# tail_consumers). The first full deploy of this service passed every smoke
# with all three queues at zero consumers. Loud failure, after promotion,
# because the fix is a separate command rather than a rollback.
node scripts/check-queue-consumers.mjs
