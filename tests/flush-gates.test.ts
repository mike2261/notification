import { describe, expect, it } from "vitest";
import { applyCapOutcome, decideGates, type ParentPrefs } from "../src/flush/gates";
import type { RenderedNotification } from "../src/flush/render";

const NOW = new Date("2026-08-07T15:00:00Z"); // 22:00 in Asia/Ho_Chi_Minh

function noti(overrides: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    id: "n1",
    parentId: "par_1",
    childId: "chi_1",
    kind: "progress",
    title: "t",
    body: "b",
    dataJson: "{}",
    dedupeKey: "chi_1:e1",
    ...overrides,
  };
}

function prefs(overrides: Partial<ParentPrefs> = {}): ParentPrefs {
  return {
    timezone: "Asia/Ho_Chi_Minh",
    quietStart: null,
    quietEnd: null,
    dailyCap: 10,
    progressEnabled: true,
    weeklyEnabled: true,
    ...overrides,
  };
}

describe("decideGates — quiet hours (design.md §4.5 step 3)", () => {
  it("defers to quiet-end when the parent is inside their quiet window", () => {
    const out = decideGates([noti()], new Map([["par_1", prefs({ quietStart: "21:00", quietEnd: "07:00" })]]), NOW);
    expect(out.decisions[0].state).toBe("deferred_quiet");
    // scheduled_for is the quiet-end instant, not now.
    expect(out.decisions[0].scheduledFor).toBe("2026-08-08T00:00:00.000Z");
  });

  it("leaves a notification outside quiet hours alone", () => {
    const out = decideGates([noti()], new Map([["par_1", prefs({ quietStart: "01:00", quietEnd: "05:00" })]]), NOW);
    expect(out.decisions[0].state).toBe("pending_cap");
  });

  it("does not ask the cap for a deferred notification", () => {
    // A deferred push has not been sent, so it must not consume a slot today.
    const out = decideGates([noti()], new Map([["par_1", prefs({ quietStart: "21:00", quietEnd: "07:00" })]]), NOW);
    expect(out.capRequests).toHaveLength(0);
  });
});

describe("decideGates — preference toggles", () => {
  it("suppresses a progress push when progressEnabled is false", () => {
    const out = decideGates([noti()], new Map([["par_1", prefs({ progressEnabled: false })]]), NOW);
    expect(out.decisions[0].state).toBe("canceled");
  });

  it("suppresses a weekly digest when weeklyEnabled is false", () => {
    const out = decideGates([noti({ kind: "weekly" })], new Map([["par_1", prefs({ weeklyEnabled: false })]]), NOW);
    expect(out.decisions[0].state).toBe("canceled");
  });
});

describe("decideGates — daily cap", () => {
  it("asks for one slot per logical notification, not per device", () => {
    const out = decideGates(
      [noti({ id: "a", dedupeKey: "k_a" }), noti({ id: "b", childId: "chi_2", dedupeKey: "k_b" })],
      new Map([["par_1", prefs()]]),
      NOW,
    );
    expect(out.capRequests).toHaveLength(1);
    expect(out.capRequests[0]).toMatchObject({ parent_id: "par_1", want: 2, cap: 10 });
  });

  it("uses the parent's LOCAL date for the cap row", () => {
    // NOW is 2026-08-07T15:00Z = 2026-08-07 22:00 local, so local_date is the 7th.
    const out = decideGates([noti()], new Map([["par_1", prefs()]]), NOW);
    expect(out.capRequests[0].local_date).toBe("2026-08-07");
  });

  it("exempts weekly digests from the cap entirely", () => {
    // One per week by construction (design.md §4.5 step 3).
    const out = decideGates([noti({ kind: "weekly" })], new Map([["par_1", prefs()]]), NOW);
    expect(out.capRequests).toHaveLength(0);
    expect(out.decisions[0].state).toBe("scheduled");
  });

  it("falls back to permissive defaults when a parent has no preferences row", () => {
    // A learning event can arrive before the parent has ever opened the app.
    const out = decideGates([noti()], new Map(), NOW);
    expect(out.decisions[0].state).toBe("pending_cap");
    expect(out.capRequests[0].cap).toBe(10);
  });
});

describe("applyCapOutcome", () => {
  it("promotes winners to scheduled and marks losers suppressed_cap", () => {
    const decisions = [
      { notification: noti({ id: "a" }), state: "pending_cap" as const, scheduledFor: "2026-08-07T15:00:00.000Z" },
      {
        notification: noti({ id: "b", parentId: "par_2" }),
        state: "pending_cap" as const,
        scheduledFor: "2026-08-07T15:00:00.000Z",
      },
    ];
    const out = applyCapOutcome(decisions, new Set(["par_1"]));
    expect(out[0].state).toBe("scheduled");
    // Terminal — never delivered later (design.md §4.5 step 3).
    expect(out[1].state).toBe("suppressed_cap");
  });

  it("leaves non-cap states untouched", () => {
    const decisions = [
      { notification: noti(), state: "deferred_quiet" as const, scheduledFor: "2026-08-08T00:00:00.000Z" },
    ];
    expect(applyCapOutcome(decisions, new Set())[0].state).toBe("deferred_quiet");
  });
});
