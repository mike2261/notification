// src/routes/e2e.ts
//
// The e2e injection surface (design.md §7.4): "A POST /v1/_test/emit gated by
// E2E_ENABLED lets this run without the robot in the loop."
//
// It hands raw envelopes to the SAME consumeBatch the queue consumer runs, so
// an injected event is indistinguishable downstream from one robo-worker
// published — parse gates, inbox idempotency, coalescing membership and all.
// A route that took a shortcut past parseEnvelope would prove nothing about
// the pipeline it exists to exercise, and the first real event would find the
// bugs this route was supposed to catch.
//
// Double-gated for the same reason as the skeleton push (fetch.ts): an open
// version of this on a public URL is a stranger's ability to fabricate
// progress moments for real parents. E2E_ENABLED stays "0" in production
// except while someone is actively driving a verification run.

import { type } from "arktype";
import { Hono } from "hono";
import { consumeBatch } from "../consumer/handler";
import { extractBearer } from "../hxxp/bearer";
import { AppError } from "../hxxp/error";
import { validate } from "../hxxp/validator";

export type E2eEnv = Env & { E2E_ENABLED?: string; E2E_TOKEN?: string };

const emitBody = type({
  // `unknown[]`, not the event contract: parseEnvelope must be the only judge
  // of validity, so a deliberately malformed payload can be injected to prove
  // it lands as `ignored` rather than as a 422 from this route.
  events: "unknown[]",
  // Subtract from the consumer-assigned arrival, so a window is already past
  // its 10-minute quiet period (§4.5 step 1) and the next 1-minute flush tick
  // renders it. Without this, verifying one push means waiting out the real
  // coalescing window.
  "backdateMs?": "number >= 0",
});

export const e2eApp = new Hono<{ Bindings: E2eEnv }>();

e2eApp.use("*", async (c, next) => {
  if (c.env.E2E_ENABLED !== "1") throw new AppError("NotExist", "not found");
  const expected = c.env.E2E_TOKEN;
  if (!expected) throw new AppError("Service", "E2E_TOKEN is unset");
  let presented: string;
  try {
    presented = extractBearer(c.req.header("Authorization"));
  } catch (err) {
    throw new AppError("Authn", (err as Error).message);
  }
  if (!timingSafeEqual(presented, expected)) throw new AppError("Authn", "bad e2e token");
  await next();
});

e2eApp.post("/emit", validate("json", emitBody), async (c) => {
  const { events, backdateMs } = c.req.valid("json");
  const receivedAt = new Date(Date.now() - (backdateMs ?? 0)).toISOString();

  const results = await consumeBatch(c.env.NOTI_D1, events, receivedAt);

  console.log(`[e2e/emit] accepted=${events.length} kinds=${results.map((r) => r.kind).join(",")}`);
  return c.json({
    accepted: events.length,
    receivedAt,
    // The parse verdict per event — the whole point of the route is seeing
    // WHY an event did nothing, and `ignored` is silent by design elsewhere.
    results: results.map((r) => (r.kind === "ok" ? { kind: r.kind, eventId: r.event.eventId } : r)),
  });
});

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
