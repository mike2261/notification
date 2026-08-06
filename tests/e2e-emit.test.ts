import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// The e2e injection surface (design.md §7.4): "A POST /v1/_test/emit gated by
// E2E_ENABLED lets this run without the robot in the loop." It feeds the SAME
// consumeBatch the queue consumer runs, so an event injected here is
// indistinguishable downstream from one robo-worker published — which is the
// only version of this route worth having. A route that took a shortcut past
// parseEnvelope would prove nothing about the pipeline it exists to exercise.

const AUTH = "Bearer test-e2e-token";

// `null` — not `undefined` — for "send no Authorization header": a default
// parameter treats an explicit undefined as absent and would silently
// authenticate the very request the test means to reject.
const emit = (body: unknown, auth: string | null = AUTH) =>
  SELF.fetch("https://tuni-noti.test/v1/_test/emit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

const starEvent = (eventId: string) => ({
  specVersion: "1.0",
  eventId,
  type: "learning.star.awarded",
  occurredAt: "2026-08-04T10:00:00Z",
  producer: "robo-worker",
  subject: { parentId: "par_e2e", childId: "chi_e2e", childName: "An" },
  data: { courseId: "c1", challengeId: "ch1", totalStars: 12 },
});

beforeEach(async () => {
  await env.NOTI_D1.batch([
    env.NOTI_D1.prepare("DELETE FROM coalesce_events"),
    env.NOTI_D1.prepare("DELETE FROM inbox"),
    env.NOTI_D1.prepare("DELETE FROM parents"),
  ]);
});

describe("POST /v1/_test/emit", () => {
  it("stages a valid event exactly as the queue consumer would", async () => {
    const res = await emit({ events: [starEvent("e2e_1:star_awarded")] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1, results: [{ kind: "ok" }] });

    const inbox = await env.NOTI_D1.prepare("SELECT state FROM inbox WHERE event_id = ?1")
      .bind("e2e_1:star_awarded")
      .first<{ state: string }>();
    expect(inbox?.state).toBe("processed");

    const staged = await env.NOTI_D1.prepare("SELECT window_key, scope FROM coalesce_events WHERE event_id = ?1")
      .bind("e2e_1:star_awarded")
      .first<{ window_key: string; scope: string }>();
    expect(staged).toMatchObject({ window_key: "chi_e2e", scope: "child" });
  });

  it("backdates arrival so the next flush tick finds the window due", async () => {
    // Without this the tester waits out CHILD_QUIET_MS (10 min) for a single
    // push, which turns "does the pipeline work?" into a coffee break. The
    // backdate is applied to `arrived_at` — the flush's only clock (§4.5).
    const before = Date.now();
    const res = await emit({ events: [starEvent("e2e_2:star_awarded")], backdateMs: 20 * 60_000 });
    expect(res.status).toBe(200);

    const row = await env.NOTI_D1.prepare("SELECT arrived_at FROM coalesce_events WHERE event_id = ?1")
      .bind("e2e_2:star_awarded")
      .first<{ arrived_at: string }>();
    const arrived = Date.parse(row?.arrived_at ?? "");
    expect(before - arrived).toBeGreaterThanOrEqual(20 * 60_000 - 5_000);
  });

  it("reports a malformed event as ignored rather than failing the request", async () => {
    // Identical to the queue path: a bad payload is terminal-but-recorded, so
    // the route must not turn it into a 5xx and invite a pointless retry.
    const res = await emit({ events: [{ specVersion: "1.0", eventId: "e2e_3", type: "nope.not.a.type" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1, results: [{ kind: "type_unsupported" }] });

    const inbox = await env.NOTI_D1.prepare("SELECT state FROM inbox WHERE event_id = ?1")
      .bind("e2e_3")
      .first<{ state: string }>();
    expect(inbox?.state).toBe("ignored");
  });

  it("rejects a wrong bearer without staging anything", async () => {
    const res = await emit({ events: [starEvent("e2e_4:star_awarded")] }, "Bearer wrong");
    expect(res.status).toBe(401);
    const staged = await env.NOTI_D1.prepare("SELECT COUNT(*) AS n FROM coalesce_events").first<{ n: number }>();
    expect(staged?.n).toBe(0);
  });

  it("rejects a missing bearer", async () => {
    const res = await emit({ events: [starEvent("e2e_5:star_awarded")] }, null);
    expect(res.status).toBe(401);
  });

  it("404s when E2E_ENABLED is off, before the token is even consulted", async () => {
    // A disabled route must be indistinguishable from a route that does not
    // exist — same reasoning as the skeleton gate in fetch.ts. Returning 401
    // here would advertise the surface to anyone probing production.
    const original = env.E2E_ENABLED;
    env.E2E_ENABLED = "0";
    try {
      const res = await emit({ events: [starEvent("e2e_6:star_awarded")] });
      expect(res.status).toBe(404);
    } finally {
      env.E2E_ENABLED = original;
    }
  });
});
