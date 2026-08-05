import { describe, expect, it } from "vitest";
import { classifyFcmResponse } from "../src/fcm/client";

// FCM error envelopes as the HTTP v1 API actually shapes them.
const fcmError = (status: string, code: number, errorCode?: string, extra?: Record<string, unknown>) =>
  JSON.stringify({
    error: {
      code,
      message: `synthetic ${status}`,
      status,
      details: [
        ...(errorCode ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] : []),
        ...(extra ? [extra] : []),
      ],
    },
  });

describe("classifyFcmResponse", () => {
  it("treats 2xx as accepted and keeps the message name", () => {
    const out = classifyFcmResponse(200, JSON.stringify({ name: "projects/p/messages/123" }));
    expect(out).toEqual({ kind: "accepted", messageName: "projects/p/messages/123" });
  });

  it("still accepts a 2xx whose body will not parse", () => {
    // Retrying here would duplicate a push FCM already took. Losing the
    // correlation id is the cheaper failure.
    expect(classifyFcmResponse(200, "<html>")).toEqual({ kind: "accepted", messageName: "" });
  });

  it("disables the token on UNREGISTERED", () => {
    const out = classifyFcmResponse(404, fcmError("NOT_FOUND", 404, "UNREGISTERED"));
    expect(out).toEqual({ kind: "token_dead", reason: "UNREGISTERED" });
  });

  it("disables the token on a bare 404", () => {
    expect(classifyFcmResponse(404, "{}").kind).toBe("token_dead");
  });

  it("disables AND alerts on SENDER_ID_MISMATCH", () => {
    const out = classifyFcmResponse(403, fcmError("SENDER_ID_MISMATCH", 403, "SENDER_ID_MISMATCH"));
    expect(out).toEqual({ kind: "token_dead_alert", reason: "SENDER_ID_MISMATCH" });
  });

  // The rule design.md §4.6 is most emphatic about, and the one a naive
  // implementation gets wrong in the direction that silently unsubscribes
  // healthy devices to hide our own bug.
  describe("INVALID_ARGUMENT is only a dead token when the detail says so", () => {
    it("disables when a fieldViolation names message.token", () => {
      const body = fcmError("INVALID_ARGUMENT", 400, undefined, {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: [{ field: "message.token", description: "Invalid registration token" }],
      });
      expect(classifyFcmResponse(400, body)).toEqual({
        kind: "token_dead",
        reason: "INVALID_ARGUMENT (token)",
      });
    });

    it("does NOT disable when the violation is our own payload", () => {
      const body = fcmError("INVALID_ARGUMENT", 400, undefined, {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: [{ field: "message.android.ttl", description: "Invalid duration" }],
      });
      const out = classifyFcmResponse(400, body);
      expect(out.kind).toBe("payload_bug");
    });

    it("does NOT disable when there is no structured detail at all", () => {
      expect(classifyFcmResponse(400, fcmError("INVALID_ARGUMENT", 400)).kind).toBe("payload_bug");
    });
  });

  it("retries on 429 and honours a numeric Retry-After", () => {
    const out = classifyFcmResponse(429, fcmError("QUOTA_EXCEEDED", 429, "QUOTA_EXCEEDED"), "30");
    expect(out).toEqual({ kind: "retry", reason: "QUOTA_EXCEEDED", retryAfterMs: 30_000 });
  });

  it("retries on 5xx", () => {
    expect(classifyFcmResponse(503, fcmError("UNAVAILABLE", 503, "UNAVAILABLE")).kind).toBe("retry");
    expect(classifyFcmResponse(500, "").kind).toBe("retry");
  });

  it("flags 401/403 as an auth problem, not a token problem", () => {
    // Disabling tokens because our own credential broke would be a
    // self-inflicted mass unsubscribe.
    expect(classifyFcmResponse(401, fcmError("UNAUTHENTICATED", 401)).kind).toBe("auth_error");
    expect(classifyFcmResponse(403, fcmError("PERMISSION_DENIED", 403)).kind).toBe("auth_error");
  });
});
