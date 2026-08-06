# Consumer Part 3: Preference Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the flush its preference gates (`docs/design.md` §4.5 step 3) — quiet hours in the parent's
local timezone with a folded catch-up push, and an atomic all-or-nothing daily cap reserved for the whole
page in one statement.

**Architecture:** Two new pure modules — `src/flush/localtime.ts` (local date + quiet-window arithmetic) and
`src/flush/gates.ts` (given rendered notifications + parent preferences + now → a state decision per
notification, plus the cap reservation request). `flush.ts` gains one context column set (`preferences`), one
cap-reservation query whose `RETURNING` names the winners, and a state assignment before the existing insert.
A second entry point `flushQuietEndCatchup()` folds each parent's `deferred_quiet` rows into one catch-up
push and cancels the folded rows in the same batch.

**Tech Stack:** `Intl.DateTimeFormat` for timezone arithmetic (no tz library — Workers ships full ICU),
D1 `INSERT … ON CONFLICT … WHERE … RETURNING` for the atomic cap reservation.

**This plan is Part 3 of 4.** Part 4 is `SEND_QUEUE` enqueue, the re-enqueue sweeper, the `PUSH_ENABLED`
dark gate (which is decided at **send** time, not here — flipping the flag on must not release days of
backlog), and the FCM send consumer. **Part 3 still sends nothing**; it decides which notifications *would*
be sent, which is the part with all the semantics in it.

---

## Before you start

```sh
cd /home/ducmai/work/tuni-noti
pnpm test        # 121 passed
pnpm type-check  # clean
git log --oneline -1   # cf0179f (or later) — Consumer Part 2 merged
```

Read `docs/design.md` §4.5 step 3 in full. "Suppressed rows are marked" is not a semantics — each of the
three gates has a defined, different outcome, and getting cap-vs-quiet precedence wrong is silent.

---

## Task 1: Local-time arithmetic

**Files:**
- Create: `src/flush/localtime.ts`
- Test: `tests/localtime.test.ts`

Everything user-facing in this service is local-time — quiet hours here, `caps.local_date` below, and the
weekly rider's week boundaries in §3.4. Same rule, one module.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/localtime.test.ts
import { describe, expect, it } from "vitest";
import { inQuietHours, localDate, localMinutes, nextQuietEnd } from "../src/flush/localtime";

const TZ = "Asia/Ho_Chi_Minh"; // UTC+7, no DST

describe("localDate / localMinutes", () => {
  it("reports the parent's local date, not UTC's", () => {
    // 2026-08-07T18:30Z is already 2026-08-08 01:30 in Vietnam.
    const instant = new Date("2026-08-07T18:30:00Z");
    expect(localDate(instant, TZ)).toBe("2026-08-08");
    expect(localMinutes(instant, TZ)).toBe(1 * 60 + 30);
  });

  it("handles a non-offset-7 zone too", () => {
    const instant = new Date("2026-08-07T18:30:00Z");
    expect(localDate(instant, "UTC")).toBe("2026-08-07");
    expect(localMinutes(instant, "UTC")).toBe(18 * 60 + 30);
  });
});

describe("inQuietHours", () => {
  it("is false when the parent set no quiet hours", () => {
    expect(inQuietHours(new Date("2026-08-07T15:00:00Z"), TZ, null, null)).toBe(false);
    expect(inQuietHours(new Date("2026-08-07T15:00:00Z"), TZ, "21:00", null)).toBe(false);
  });

  it("handles a window that wraps past midnight", () => {
    // 21:00 → 07:00 local. 2026-08-07T15:00Z = 22:00 local → inside.
    expect(inQuietHours(new Date("2026-08-07T15:00:00Z"), TZ, "21:00", "07:00")).toBe(true);
    // 2026-08-07T22:00Z = 05:00 next day local → still inside.
    expect(inQuietHours(new Date("2026-08-07T22:00:00Z"), TZ, "21:00", "07:00")).toBe(true);
    // 2026-08-07T05:00Z = 12:00 local → outside.
    expect(inQuietHours(new Date("2026-08-07T05:00:00Z"), TZ, "21:00", "07:00")).toBe(false);
  });

  it("handles a same-day window", () => {
    // 13:00 → 15:00 local (a nap window). 2026-08-07T07:00Z = 14:00 local.
    expect(inQuietHours(new Date("2026-08-07T07:00:00Z"), TZ, "13:00", "15:00")).toBe(true);
    expect(inQuietHours(new Date("2026-08-07T09:00:00Z"), TZ, "13:00", "15:00")).toBe(false);
  });

  it("treats the end minute as outside the window", () => {
    // 2026-08-08T00:00Z = 07:00 local, exactly quiet-end → deliverable.
    expect(inQuietHours(new Date("2026-08-08T00:00:00Z"), TZ, "21:00", "07:00")).toBe(false);
  });
});

describe("nextQuietEnd", () => {
  it("returns today's quiet-end when the window has not wrapped yet", () => {
    // 2026-08-07T22:00Z = 05:00 local; quiet-end 07:00 local = 2026-08-08T00:00Z.
    const out = nextQuietEnd(new Date("2026-08-07T22:00:00Z"), TZ, "07:00");
    expect(out.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });

  it("returns tomorrow's quiet-end when the local clock is already past it", () => {
    // 2026-08-07T15:00Z = 22:00 local; next 07:00 local = 2026-08-08T00:00Z.
    const out = nextQuietEnd(new Date("2026-08-07T15:00:00Z"), TZ, "07:00");
    expect(out.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run it — expect failure**, then write `src/flush/localtime.ts`

```ts
// src/flush/localtime.ts
//
// Local-time arithmetic for the parent's timezone (design.md §4.5 step 3).
// Everything user-facing in this service is local: quiet hours here,
// caps.local_date in gates.ts, the weekly rider's week boundaries in §3.4.
//
// Intl.DateTimeFormat, not a tz library — Workers ships full ICU, and the one
// thing a library would buy (historical DST tables) does not apply to
// Asia/Ho_Chi_Minh, which has had no DST since 1975.

type Parts = { date: string; minutes: number };

function partsIn(instant: Date, timeZone: string): Parts {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape caps.local_date
  // stores and the shape that sorts correctly as a string.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  // hourCycle h23 can render midnight as "24" in some ICU versions.
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute),
  };
}

export function localDate(instant: Date, timeZone: string): string {
  return partsIn(instant, timeZone).date;
}

export function localMinutes(instant: Date, timeZone: string): number {
  return partsIn(instant, timeZone).minutes;
}

/** "HH:MM" → minutes since local midnight, or null if unparseable/absent. */
export function parseClock(value: string | null): number | null {
  if (!value) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Quiet hours need BOTH ends set; one alone is not a window. The end minute
 * is exclusive, so a notification landing exactly at quiet-end is delivered
 * rather than deferred by another whole day.
 */
export function inQuietHours(
  instant: Date,
  timeZone: string,
  quietStart: string | null,
  quietEnd: string | null,
): boolean {
  const start = parseClock(quietStart);
  const end = parseClock(quietEnd);
  if (start === null || end === null) return false;

  const now = localMinutes(instant, timeZone);
  // A window like 21:00 → 07:00 wraps past local midnight.
  return start > end ? now >= start || now < end : now >= start && now < end;
}

/**
 * The next instant at which the parent's local clock reads `quietEnd`.
 *
 * Computed as a minute delta from `instant` rather than by constructing a
 * local wall-clock time, because there is no way to build a Date at "07:00 in
 * zone X" without a tz-offset lookup. The delta is exact for fixed-offset
 * zones; a DST transition inside the deferral window would shift it by an
 * hour, which for Asia/Ho_Chi_Minh cannot happen.
 */
export function nextQuietEnd(instant: Date, timeZone: string, quietEnd: string): Date {
  const end = parseClock(quietEnd);
  if (end === null) return instant;
  const now = localMinutes(instant, timeZone);
  const deltaMinutes = end > now ? end - now : 1440 - now + end;
  return new Date(instant.getTime() + deltaMinutes * 60_000);
}
```

- [ ] **Step 3: Run — expect pass. Commit.**

```sh
pnpm test tests/localtime.test.ts
git add src/flush/localtime.ts tests/localtime.test.ts
git commit -m "feat(flush): local-time arithmetic for quiet hours and cap dates (design.md §4.5)"
```

---

## Task 2: Gate decisions (pure)

**Files:**
- Create: `src/flush/gates.ts`
- Test: `tests/flush-gates.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/flush-gates.test.ts
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
```

- [ ] **Step 2: Run it — expect failure**, then write `src/flush/gates.ts`

```ts
// src/flush/gates.ts
//
// Preference gates, decided at flush (design.md §4.5 step 3). Pure — the
// caller supplies `now` and the preference map, and gets back a state per
// notification plus the cap reservation requests. "Suppressed rows are
// marked" is not a semantics; each gate has a defined, different outcome:
//
//   quiet hours → deferred_quiet, scheduled_for = quiet-end (delivered later)
//   daily cap   → suppressed_cap, TERMINAL (never delivered later)
//   toggles off → canceled
//
// PUSH_ENABLED is deliberately NOT here: it is decided at SEND time (Part 4),
// because flipping the flag on must not release days of accumulated backlog.

import { inQuietHours, localDate, nextQuietEnd } from "./localtime";
import type { RenderedNotification } from "./render";

export type ParentPrefs = {
  timezone: string;
  quietStart: string | null;
  quietEnd: string | null;
  dailyCap: number;
  progressEnabled: boolean;
  weeklyEnabled: boolean;
};

// A parent whose row does not exist yet — a learning event can arrive before
// they have ever opened the app. Permissive, matching the schema defaults.
const DEFAULT_PREFS: ParentPrefs = {
  timezone: "Asia/Ho_Chi_Minh",
  quietStart: null,
  quietEnd: null,
  dailyCap: 10,
  progressEnabled: true,
  weeklyEnabled: true,
};

export type GateState = "scheduled" | "pending_cap" | "deferred_quiet" | "suppressed_cap" | "canceled";

export type GateDecision = {
  notification: RenderedNotification;
  state: GateState;
  scheduledFor: string;
};

export type CapRequest = { parent_id: string; local_date: string; cap: number; want: number };

export function decideGates(
  notifications: RenderedNotification[],
  prefsByParent: ReadonlyMap<string, ParentPrefs>,
  now: Date,
): { decisions: GateDecision[]; capRequests: CapRequest[] } {
  const decisions: GateDecision[] = [];
  const wantByParent = new Map<string, CapRequest>();

  for (const notification of notifications) {
    const prefs = prefsByParent.get(notification.parentId) ?? DEFAULT_PREFS;

    const enabled = notification.kind === "weekly" ? prefs.weeklyEnabled : prefs.progressEnabled;
    if (!enabled) {
      decisions.push({ notification, state: "canceled", scheduledFor: now.toISOString() });
      continue;
    }

    if (inQuietHours(now, prefs.timezone, prefs.quietStart, prefs.quietEnd)) {
      // Deferred, not suppressed — and deliberately NOT counted against the
      // cap, because it has not been sent.
      const end = prefs.quietEnd as string; // non-null whenever inQuietHours is true
      decisions.push({
        notification,
        state: "deferred_quiet",
        scheduledFor: nextQuietEnd(now, prefs.timezone, end).toISOString(),
      });
      continue;
    }

    // Weekly digests bypass the cap entirely — one per week by construction.
    if (notification.kind === "weekly") {
      decisions.push({ notification, state: "scheduled", scheduledFor: now.toISOString() });
      continue;
    }

    decisions.push({ notification, state: "pending_cap", scheduledFor: now.toISOString() });

    const local_date = localDate(now, prefs.timezone);
    const key = notification.parentId;
    const existing = wantByParent.get(key);
    if (existing) existing.want += 1;
    else wantByParent.set(key, { parent_id: key, local_date, cap: prefs.dailyCap, want: 1 });
  }

  return { decisions, capRequests: [...wantByParent.values()] };
}

/**
 * `winners` is exactly the set `RETURNING parent_id` named. Every other
 * parent in the page breached their cap and is refused WHOLE — a partial fill
 * would make *which child gets through* depend on scan order, which is
 * arbitrary, unstable between ticks, and impossible to explain to a parent.
 */
export function applyCapOutcome(decisions: GateDecision[], winners: ReadonlySet<string>): GateDecision[] {
  return decisions.map((d) => {
    if (d.state !== "pending_cap") return d;
    return { ...d, state: winners.has(d.notification.parentId) ? "scheduled" : "suppressed_cap" };
  });
}
```

- [ ] **Step 3: Run — expect pass. Commit.**

```sh
pnpm test tests/flush-gates.test.ts
git add src/flush/gates.ts tests/flush-gates.test.ts
git commit -m "feat(flush): preference gate decisions — quiet hours, cap requests, toggles (design.md §4.5)"
```

---

## Task 3: Wire gates into the flush + quiet-end catch-up

**Files:**
- Modify: `src/flush/flush.ts`
- Modify: `src/index.ts`
- Test: `tests/flush-gates-integration.test.ts`

- [ ] **Step 1: Extend the render-context query to carry preferences**

`RENDER_CONTEXT_SQL` gains a `LEFT JOIN preferences` (left, because the row may not exist yet) and its
columns; `ContextRow` gains them. Still **one** query for the whole page.

- [ ] **Step 2: Add the cap reservation** — one statement for the entire page, `RETURNING` the winners

```sql
INSERT INTO caps (parent_id, local_date, daily_cap, sent_count)
SELECT json_extract(value,'$.parent_id'), json_extract(value,'$.local_date'),
       json_extract(value,'$.cap'),       json_extract(value,'$.want')
  FROM json_each(?1)
 -- first write of the day still has to respect the cap
 WHERE json_extract(value,'$.want') <= json_extract(value,'$.cap')
ON CONFLICT (parent_id, local_date) DO UPDATE
   SET sent_count = caps.sent_count + excluded.sent_count
 WHERE caps.sent_count + excluded.sent_count <= caps.daily_cap
RETURNING parent_id
```

`daily_cap` is compared against the **snapshotted** column, not the live preference, because one bound
parameter cannot express a page's worth of different limits — and because snapshotting gives the right
behaviour when a parent edits their cap mid-day: the new limit applies from tomorrow rather than
retroactively re-judging notifications already sent.

- [ ] **Step 3: Assign state in the insert.** `INSERT_NOTIFICATIONS_SQL`'s hardcoded `'scheduled'` becomes
`json_extract(value, '$.state')`, and `scheduled_for` comes from the decision rather than the tick time.

- [ ] **Step 4: Add `flushQuietEndCatchup()`** — folds each parent's due `deferred_quiet` rows into ONE
catch-up push with `dedupe_key = '{parentId}:catchup:{local_date}'`, and flips the folded rows to `canceled`
in the same batch so they cannot also send individually.

- [ ] **Step 5: Call it from `scheduled()`** right after `flushDueWindows`.

- [ ] **Step 6: Write the integration tests** (real D1) covering: quiet hours defer + catch-up folds N rows
into one push + folded rows become `canceled`; cap refuses a 3-notification parent with 2 slots left
**whole**; weekly bypasses the cap; the cap is snapshotted so a mid-day preference edit applies tomorrow.

- [ ] **Step 7: Full suite, type-check, lint, commit.**

---

## Final check for this plan

```sh
pnpm type-check && pnpm test && pnpm lint
```

**What this does NOT do yet:** nothing is sent. `SEND_QUEUE` enqueue, the 15-minute re-enqueue sweeper, the
`PUSH_ENABLED` dark gate, and the FCM send consumer are all Part 4.

**Known imperfection to carry into Part 4's review:** the cap reserves *before* the notification insert, so
two overlapping ticks that both reserve for the same window consume two slots while only one notification
row survives the `dedupe_key` conflict. The design's ordering requires this (the cap outcome must be known
before the rows are written so the INSERT can share a batch with the DELETE), and the failure mode is
conservative — a parent may occasionally receive slightly fewer pushes than their cap allows, never more.
Worth a metric in Part 4 rather than a redesign here.
