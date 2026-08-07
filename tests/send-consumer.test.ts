import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWifCaches } from "../src/auth/wif";
import { getDb } from "../src/datastore/d1/schema";
import { type SendEnv, sendBatchJobs } from "../src/send/consumer";

// A REAL P-256 key: sendOne mints through the full WIF chain before it ever
// reaches FCM, so a bogus key would make every outcome `auth_error` and the
// token-lifecycle assertions below would silently test nothing.
let wifPrivateKey: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  wifPrivateKey = btoa(binary);
});

function sendEnv(overrides: Partial<SendEnv> = {}): SendEnv {
  return {
    NOTI_D1: env.NOTI_D1,
    PUSH_ENABLED: "1",
    WIF_PRIVATE_KEY: wifPrivateKey,
    WIF_ISSUER: "https://tuni-noti.test",
    WIF_SUBJECT: "tuni-noti",
    WIF_AUDIENCE: "//iam.googleapis.com/x",
    FCM_SA_EMAIL: "tuni-noti@test.iam.gserviceaccount.com",
    FCM_PROJECT_ID: "test-firebase-project",
    ...overrides,
  } as SendEnv;
}

/**
 * Stubs the whole WIF + FCM chain. `fcm` decides what FCM answers; `calls`
 * records every messages:send so the tests can assert fan-out and payload.
 */
function stubFcm(fcm: (body: unknown) => { status: number; json: unknown }) {
  const calls: unknown[] = [];
  let inFlight = 0;
  let peak = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.startsWith("https://sts.googleapis.com/")) {
      return new Response(JSON.stringify({ access_token: "federated" }), { status: 200 });
    }
    if (url.includes("iamcredentials.googleapis.com")) {
      return new Response(
        JSON.stringify({ accessToken: "sa-token", expireTime: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 200 },
      );
    }
    if (url.includes("fcm.googleapis.com")) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const body = JSON.parse(init.body as string);
      calls.push(body);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const out = fcm(body);
      return new Response(JSON.stringify(out.json), { status: out.status });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { calls, peak: () => peak };
}

const ACCEPTED = () => ({ status: 200, json: { name: "projects/p/messages/123" } });

async function seed(params: {
  notificationId: string;
  parentId: string;
  childId?: string | null;
  tokens: string[];
  state?: string;
  childDeletedAt?: string | null;
}) {
  const db = getDb(env.NOTI_D1);
  await db
    .insertInto("parents")
    .values({ parent_id: params.parentId, timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" })
    .onConflict((oc) => oc.column("parent_id").doNothing())
    .execute();
  if (params.childId) {
    await db
      .insertInto("children")
      .values({
        child_id: params.childId,
        parent_id: params.parentId,
        name: "An",
        identity_updated_at: "2026-08-01T00:00:00Z",
        deleted_at: params.childDeletedAt ?? null,
      })
      .onConflict((oc) => oc.column("child_id").doNothing())
      .execute();
  }
  for (const [i, token] of params.tokens.entries()) {
    await db
      .insertInto("push_tokens")
      .values({
        token,
        device_id: `${token}_dev_${i}`,
        parent_id: params.parentId,
        platform: "android",
        last_seen_at: "2026-08-01T00:00:00Z",
        disabled_at: null,
      })
      .execute();
  }
  await db
    .insertInto("notifications")
    .values({
      id: params.notificationId,
      parent_id: params.parentId,
      child_id: params.childId ?? null,
      kind: "progress",
      title: "An vừa học xong!",
      body: "An hoàn thành 1 bài học.",
      data_json: "{}",
      scheduled_for: "2026-08-07T12:00:00.000Z",
      enqueued_at: "2026-08-07T12:00:00.000Z",
      state: (params.state ?? "enqueued") as "enqueued",
      dedupe_key: `dk_${params.notificationId}`,
    })
    .execute();
}

beforeEach(async () => {
  __resetWifCaches();
  const db = getDb(env.NOTI_D1);
  await db.deleteFrom("deliveries").execute();
  await db.deleteFrom("notifications").execute();
  await db.deleteFrom("push_tokens").execute();
  await db.deleteFrom("children").execute();
});

describe("sendBatchJobs — happy path (design.md §4.6)", () => {
  it("sends one FCM call per live token and records per-token deliveries", async () => {
    await seed({ notificationId: "s_1", parentId: "s_par_1", childId: "s_chi_1", tokens: ["tok_a", "tok_b"] });
    const { calls } = stubFcm(ACCEPTED);

    await sendBatchJobs(sendEnv(), [{ notificationId: "s_1" }]);

    expect(calls).toHaveLength(2);
    const db = getDb(env.NOTI_D1);
    const deliveries = await db.selectFrom("deliveries").selectAll().where("notification_id", "=", "s_1").execute();
    expect(deliveries).toHaveLength(2);
    // "accepted", never "delivered" — FCM 200 means accepted by FCM only.
    expect(deliveries.every((d) => d.state === "accepted")).toBe(true);
    expect(deliveries[0].fcm_message_name).toBe("projects/p/messages/123");

    const noti = await db.selectFrom("notifications").selectAll().where("id", "=", "s_1").executeTakeFirstOrThrow();
    expect(noti.state).toBe("done");
  });

  it("carries the deterministic id, a per-child collapse key, a TTL and a channel", async () => {
    await seed({ notificationId: "s_shape", parentId: "s_par_shape", childId: "s_chi_shape", tokens: ["tok_shape"] });
    const { calls } = stubFcm(ACCEPTED);

    await sendBatchJobs(sendEnv(), [{ notificationId: "s_shape" }]);

    const msg = (calls[0] as { message: Record<string, never> }).message as unknown as {
      data: Record<string, string>;
      android: Record<string, unknown>;
    };
    expect(msg.data.notificationId).toBe("s_shape");
    // A newer progress push must REPLACE a stale one rather than stacking.
    expect(msg.android.collapse_key).toBe("s_chi_shape");
    expect(msg.android.ttl).toBeTruthy();
    expect((msg.android.notification as { channel_id: string }).channel_id).toBeTruthy();
  });

  it("never runs more than 6 FCM calls concurrently", async () => {
    // The connection limit applies to EVERY invocation, consumers included
    // (§5.1) — never Promise.all a whole batch.
    await seed({
      notificationId: "s_many",
      parentId: "s_par_many",
      childId: "s_chi_many",
      tokens: Array.from({ length: 20 }, (_, i) => `tok_many_${i}`),
    });
    const { calls, peak } = stubFcm(ACCEPTED);

    await sendBatchJobs(sendEnv(), [{ notificationId: "s_many" }]);

    expect(calls).toHaveLength(20);
    expect(peak()).toBeLessThanOrEqual(6);
  });
});

describe("sendBatchJobs — token lifecycle (design.md §4.6)", () => {
  it("disables a token on UNREGISTERED", async () => {
    await seed({ notificationId: "s_dead", parentId: "s_par_dead", childId: "s_chi_dead", tokens: ["tok_dead"] });
    stubFcm(() => ({
      status: 404,
      json: {
        error: {
          status: "NOT_FOUND",
          message: "requested entity was not found",
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
        },
      },
    }));

    await sendBatchJobs(sendEnv(), [{ notificationId: "s_dead" }]);

    const token = await getDb(env.NOTI_D1)
      .selectFrom("push_tokens")
      .selectAll()
      .where("token", "=", "tok_dead")
      .executeTakeFirstOrThrow();
    expect(token.disabled_at).not.toBeNull();
  });

  it("does NOT disable a token on a payload-shaped INVALID_ARGUMENT", async () => {
    // Disabling a healthy device to mask our own malformed payload is a
    // silent unsubscribe — the failure §4.6 calls out by name.
    await seed({ notificationId: "s_bug", parentId: "s_par_bug", childId: "s_chi_bug", tokens: ["tok_healthy"] });
    stubFcm(() => ({
      status: 400,
      json: {
        error: {
          status: "INVALID_ARGUMENT",
          message: "Invalid value at 'message.android.ttl'",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [{ field: "message.android.ttl", description: "bad" }],
            },
          ],
        },
      },
    }));

    await sendBatchJobs(sendEnv(), [{ notificationId: "s_bug" }]);

    const db = getDb(env.NOTI_D1);
    const token = await db
      .selectFrom("push_tokens")
      .selectAll()
      .where("token", "=", "tok_healthy")
      .executeTakeFirstOrThrow();
    expect(token.disabled_at).toBeNull();
    const delivery = await db
      .selectFrom("deliveries")
      .selectAll()
      .where("token", "=", "tok_healthy")
      .executeTakeFirstOrThrow();
    expect(delivery.state).toBe("failed");
  });

  it("skips a token already accepted when a job is redelivered", async () => {
    await seed({ notificationId: "s_re", parentId: "s_par_re", childId: "s_chi_re", tokens: ["tok_re"] });
    const first = stubFcm(ACCEPTED);
    await sendBatchJobs(sendEnv(), [{ notificationId: "s_re" }]);
    expect(first.calls).toHaveLength(1);

    // Queues are at-least-once; the same job arrives again.
    const db = getDb(env.NOTI_D1);
    await db.updateTable("notifications").set({ state: "enqueued" }).where("id", "=", "s_re").execute();
    const second = stubFcm(ACCEPTED);
    await sendBatchJobs(sendEnv(), [{ notificationId: "s_re" }]);
    expect(second.calls).toHaveLength(0);
  });
});

describe("sendBatchJobs — gates at send time", () => {
  it("marks suppressed_dark and makes ZERO FCM calls when PUSH_ENABLED is off", async () => {
    await seed({ notificationId: "s_dark", parentId: "s_par_dark", childId: "s_chi_dark", tokens: ["tok_dark"] });
    const { calls } = stubFcm(ACCEPTED);

    await sendBatchJobs(sendEnv({ PUSH_ENABLED: "0" }), [{ notificationId: "s_dark" }]);

    expect(calls).toHaveLength(0);
    const noti = await getDb(env.NOTI_D1)
      .selectFrom("notifications")
      .selectAll()
      .where("id", "=", "s_dark")
      .executeTakeFirstOrThrow();
    // Decided at SEND time, so flipping the flag on releases nothing
    // retroactively (design.md §8).
    expect(noti.state).toBe("suppressed_dark");
  });

  it("cancels and makes ZERO FCM calls for a child tombstoned after enqueue", async () => {
    await seed({
      notificationId: "s_tomb",
      parentId: "s_par_tomb",
      childId: "s_chi_tomb",
      tokens: ["tok_tomb"],
      childDeletedAt: "2026-08-07T11:00:00Z",
    });
    const { calls } = stubFcm(ACCEPTED);

    await sendBatchJobs(sendEnv(), [{ notificationId: "s_tomb" }]);

    // A job already sitting in SEND_QUEUE must not push for a deleted child.
    expect(calls).toHaveLength(0);
    const noti = await getDb(env.NOTI_D1)
      .selectFrom("notifications")
      .selectAll()
      .where("id", "=", "s_tomb")
      .executeTakeFirstOrThrow();
    expect(noti.state).toBe("canceled");
  });
});

describe("PUSH_BROADCAST — demo prop, not a feature", () => {
  it("off: a notification reaches only its OWN parent's devices", async () => {
    await seed({ notificationId: "n_own", parentId: "par_a", childId: "chi_a", tokens: ["tok_a"] });
    await seed({ notificationId: "n_other", parentId: "par_b", childId: "chi_b", tokens: ["tok_b"] });
    const { calls } = stubFcm(() => ({ status: 200, json: { name: "projects/x/messages/1" } }));

    await sendBatchJobs(sendEnv(), [{ notificationId: "n_own" }]);

    expect(calls).toHaveLength(1);
    expect((calls[0] as { message: { token: string } }).message.token).toBe("tok_a");
  });

  it("on: every enabled device receives it, whoever it was rendered for", async () => {
    // The privacy trade this makes is the whole reason it is a temporary demo
    // prop: par_a's child's progress lands on par_b's handset.
    await seed({ notificationId: "n_bc", parentId: "par_a", childId: "chi_a", tokens: ["tok_a"] });
    await seed({ notificationId: "n_other", parentId: "par_b", childId: "chi_b", tokens: ["tok_b"] });
    const { calls } = stubFcm(() => ({ status: 200, json: { name: "projects/x/messages/1" } }));

    await sendBatchJobs(sendEnv({ PUSH_BROADCAST: "1" }), [{ notificationId: "n_bc" }]);

    const tokens = (calls as { message: { token: string } }[]).map((c) => c.message.token).sort();
    expect(tokens).toEqual(["tok_a", "tok_b"]);
  });

  it("on: still respects PUSH_ENABLED — the dark gate outranks it", async () => {
    await seed({ notificationId: "n_dark", parentId: "par_a", childId: "chi_a", tokens: ["tok_a"] });
    const { calls } = stubFcm(() => ({ status: 200, json: { name: "projects/x/messages/1" } }));

    await sendBatchJobs(sendEnv({ PUSH_BROADCAST: "1", PUSH_ENABLED: "0" }), [{ notificationId: "n_dark" }]);

    expect(calls).toHaveLength(0);
  });

  it("on: a disabled token stays disabled — broadcast is not a resurrection", async () => {
    await seed({ notificationId: "n_dis", parentId: "par_a", childId: "chi_a", tokens: ["tok_a"] });
    await getDb(env.NOTI_D1)
      .updateTable("push_tokens")
      .set({ disabled_at: "2026-08-01T00:00:00Z" })
      .where("token", "=", "tok_a")
      .execute();
    const { calls } = stubFcm(() => ({ status: 200, json: { name: "projects/x/messages/1" } }));

    await sendBatchJobs(sendEnv({ PUSH_BROADCAST: "1" }), [{ notificationId: "n_dis" }]);

    expect(calls).toHaveLength(0);
  });
});
