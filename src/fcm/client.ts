// src/fcm/client.ts
//
// FCM HTTP v1 send + response classification (design.md §4.6).
//
// The classifier is a PURE function on (httpStatus, body, headers) and the
// network call is a thin wrapper around it. That split is deliberate: the token
// lifecycle rules below are the part that is easy to get quietly wrong and
// expensive to get wrong in production, and they should be testable without a
// handset, a Google project, or a network.

import { getAccessToken, type WifEnv } from "../auth/wif";

export type FcmEnv = WifEnv & { FCM_PROJECT_ID: string };

/**
 * What the caller must do about a send. `token_dead` is the only outcome that
 * may stamp `disabled_at`; `payload_bug` deliberately does NOT, because
 * disabling a healthy device to mask our own malformed payload is a silent
 * unsubscribe (design.md §4.6).
 */
export type FcmOutcome =
  | { kind: "accepted"; messageName: string }
  | { kind: "token_dead"; reason: string }
  | { kind: "token_dead_alert"; reason: string }
  | { kind: "payload_bug"; reason: string }
  | { kind: "auth_error"; reason: string }
  | { kind: "retry"; reason: string; retryAfterMs?: number };

type FcmErrorBody = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<Record<string, unknown>>;
  };
};

const FCM_ERROR_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError";
const BAD_REQUEST_TYPE = "type.googleapis.com/google.rpc.BadRequest";

function fcmErrorCode(body: FcmErrorBody): string | undefined {
  for (const detail of body.error?.details ?? []) {
    if (detail["@type"] === FCM_ERROR_TYPE && typeof detail.errorCode === "string") {
      return detail.errorCode;
    }
  }
  return undefined;
}

/**
 * True when the structured detail blames the registration token specifically.
 * This is the whole reason INVALID_ARGUMENT needs inspecting rather than
 * pattern-matching on the status string.
 */
function blamesToken(body: FcmErrorBody): boolean {
  for (const detail of body.error?.details ?? []) {
    if (detail["@type"] !== BAD_REQUEST_TYPE) continue;
    const violations = detail.fieldViolations;
    if (!Array.isArray(violations)) continue;
    for (const v of violations) {
      const field = (v as { field?: unknown }).field;
      // FCM reports the offending field as `message.token`.
      if (typeof field === "string" && /(^|\.)token$/.test(field)) return true;
    }
  }
  return false;
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(headerValue);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

export function classifyFcmResponse(status: number, rawBody: string, retryAfter: string | null = null): FcmOutcome {
  if (status >= 200 && status < 300) {
    let name = "";
    try {
      name = (JSON.parse(rawBody) as { name?: string }).name ?? "";
    } catch {
      // A 2xx with an unparseable body still means FCM accepted it. Correlation
      // is lost, delivery is not — don't turn that into a retry and a duplicate.
    }
    return { kind: "accepted", messageName: name };
  }

  let body: FcmErrorBody = {};
  try {
    body = JSON.parse(rawBody) as FcmErrorBody;
  } catch {
    // fall through with an empty body; status alone still classifies
  }
  const code = fcmErrorCode(body);
  const gstatus = body.error?.status ?? "";
  const message = body.error?.message ?? rawBody.slice(0, 200);

  // Unambiguous dead-token signals, whatever the HTTP status says.
  if (code === "UNREGISTERED" || gstatus === "UNREGISTERED") {
    return { kind: "token_dead", reason: "UNREGISTERED" };
  }
  if (status === 404 || gstatus === "NOT_FOUND") {
    return { kind: "token_dead", reason: "NOT_FOUND" };
  }
  // Configuration drift, not token churn: the token belongs to another sender.
  if (code === "SENDER_ID_MISMATCH" || gstatus === "SENDER_ID_MISMATCH") {
    return { kind: "token_dead_alert", reason: "SENDER_ID_MISMATCH" };
  }

  if (status === 401 || status === 403 || gstatus === "UNAUTHENTICATED" || gstatus === "PERMISSION_DENIED") {
    return { kind: "auth_error", reason: `${gstatus || status}: ${message}` };
  }

  if (status === 429 || gstatus === "QUOTA_EXCEEDED" || code === "QUOTA_EXCEEDED") {
    return { kind: "retry", reason: "QUOTA_EXCEEDED", retryAfterMs: parseRetryAfterMs(retryAfter) };
  }
  if (status >= 500 || gstatus === "UNAVAILABLE" || gstatus === "INTERNAL") {
    return { kind: "retry", reason: gstatus || `HTTP ${status}`, retryAfterMs: parseRetryAfterMs(retryAfter) };
  }

  // The nuanced one. INVALID_ARGUMENT means "dead token" ONLY when the detail
  // names the token; otherwise OUR payload is malformed and disabling the
  // device would hide our bug behind a silently unsubscribed parent.
  if (status === 400 || gstatus === "INVALID_ARGUMENT") {
    return blamesToken(body)
      ? { kind: "token_dead", reason: "INVALID_ARGUMENT (token)" }
      : { kind: "payload_bug", reason: `INVALID_ARGUMENT: ${message}` };
  }

  return { kind: "payload_bug", reason: `unclassified ${status}: ${message}` };
}

export type FcmMessage = {
  token: string;
  notification?: { title?: string; body?: string };
  data?: Record<string, string>;
  android?: Record<string, unknown>;
};

/**
 * One message, one token — FCM HTTP v1 has no batch send endpoint, which is the
 * root of the fan-out constraint in design.md §5.1. Callers must respect the
 * 6-simultaneous-connection limit; this function deliberately does not manage
 * concurrency for you.
 *
 * A 2xx means FCM ACCEPTED the message. It does not mean a handset received it,
 * and nothing downstream may report it as "delivered".
 */
export async function sendOne(env: FcmEnv, message: FcmMessage): Promise<FcmOutcome> {
  let accessToken: string;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    // A mint failure is config or transient network, never the token's fault.
    return { kind: "auth_error", reason: `wif mint failed: ${(err as Error).message}` };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ message }),
    });
  } catch (err) {
    // Ambiguous by construction: FCM may have accepted it. Retrying is correct;
    // the collapse key (design.md §4.6) is what makes the retry cosmetically
    // safe rather than a stacked duplicate on the lock screen.
    return { kind: "retry", reason: `network: ${(err as Error).message}` };
  }

  return classifyFcmResponse(resp.status, await resp.text(), resp.headers.get("Retry-After"));
}
