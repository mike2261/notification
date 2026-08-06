# Consumer Part 2: Coalescing + Set-Based Flush Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn recorded-but-inert learning/reporting events into coalesced `notifications` rows — the
`coalesce_events` membership write (`docs/design.md` §4.5 step 1) plus the `* * * * *` **set-based** flush cron
(§4.5 step 2) that renders one push per window instead of three per session.

**Architecture:** The consumer's existing single-`batch()` gains one conditional `INSERT OR IGNORE` into
`coalesce_events` per learning/reporting event. A new `scheduled()` handler runs the flush: **one** query for
due windows *and* their full membership, **one** query for render context, rendering in memory, then **one**
batch of exactly two statements for the entire page — a multi-row `INSERT OR IGNORE` into `notifications` via
`json_each(?)`, and a guarded `DELETE` from `coalesce_events`. Query count per tick is a small constant,
independent of how many windows are due; §5.1's middle column (a per-window loop dying at ~200 due children
against D1's 1,000-query invocation budget) is the failure this shape exists to prevent.

**Tech Stack:** Cloudflare cron triggers, D1 `batch()` with `json_each(?)` parameter expansion (D1 caps bound
parameters well below a page's worth of ids, so `IN (?,?,?…)` is not an option), existing
`src/consumer/plan.ts` seam.

**This plan is Part 2 of 4.** Part 1 (inbox + identity mirror) is merged. Part 3 is preference gates —
quiet hours, daily caps, `PUSH_ENABLED` — plus `SEND_QUEUE` enqueue and the re-enqueue sweeper (§4.5 steps
3–4). Part 4 is the FCM send consumer (§4.6). **Part 2 therefore writes every notification as `scheduled`
with no gating and sends nothing.** That is a real increment — coalescing correctness and the query-budget
invariant are both fully testable without gates, and they are the two things §5.1 says are easiest to get
quietly wrong.

---

## Before you start

```sh
cd /home/ducmai/work/tuni-noti
pnpm test        # 95 passed
pnpm type-check  # clean
git log --oneline -1   # 0cbc64a (or later) — Consumer Part 1 merged
```

Read `docs/design.md` §4.5 and §5.1 in full before starting. The `dedupe_key`-on-arrival-order argument and
the fixed-query-count requirement are the whole point; a change that violates either is wrong even if its
tests pass.

---

## Task 1: Coalescing membership write

**Files:**
- Modify: `src/consumer/plan.ts`
- Modify: `src/consumer/handler.ts`
- Test: `tests/consumer-coalesce.test.ts`

Learning events land as `scope='child'` membership keyed on `child_id`; `reporting.week.closed` lands as
`scope='parent'` keyed on `parent_id`, so one grouped query serves both scopes (§4.3).

**Tombstone handling changes `planBatch`'s signature.** §4.8 rule 3 says a late `learning.*` or `reporting.*`
event for a tombstoned child is `ignored` — but the inbox state can't be decided conditionally inside a single
batch without knowing which children are already tombstoned. So `consumeBatch` does **one** SELECT first (one
query per delivery batch, not per message) and passes the tombstoned set into `planBatch`, which stays pure.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/consumer-coalesce.test.ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { consumeBatch } from "../src/consumer/handler";
import { parseEnvelope } from "../src/consumer/parse";
import { planBatch } from "../src/consumer/plan";
import { getDb } from "../src/datastore/d1/schema";

const RECEIVED_AT = "2026-08-07T10:00:00.000Z";

function lesson(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: "1.0",
    eventId: "led_1:lesson_completed",
    type: "learning.lesson.completed",
    occurredAt: "2026-08-04T10:00:00Z",
    producer: "robo-worker",
    subject: { parentId: "c_par_1", childId: "c_chi_1", childName: "An" },
    data: { courseId: "co1", lessonId: "l1", outcome: "achieved", durationS: 300 },
    ...overrides,
  };
}

function weekClosed(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: "1.0",
    eventId: "c_chi_1:2026-08-03",
    type: "reporting.week.closed",
    occurredAt: "2026-08-09T03:00:00Z",
    producer: "tuni-noti",
    subject: { parentId: "c_par_1", childId: "c_chi_1", childName: "An" },
    data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
    ...overrides,
  };
}

describe("planBatch — coalescing membership (design.md §4.5 step 1)", () => {
  it("writes a child-scoped coalesce row for a learning event, keyed on child_id", () => {
    const stmts = planBatch([parseEnvelope(lesson())], RECEIVED_AT, new Set());
    const ce = stmts.find((s) => s.sql.includes("INTO coalesce_events"));
    expect(ce).toBeDefined();
    expect(ce?.sql).toMatch(/INSERT OR IGNORE/);
    expect(ce?.params).toContain("child");
    expect(ce?.params).toContain("c_chi_1"); // window_key
  });

  it("writes a parent-scoped coalesce row for reporting.week.closed, keyed on parent_id", () => {
    const stmts = planBatch([parseEnvelope(weekClosed())], RECEIVED_AT, new Set());
    const ce = stmts.find((s) => s.sql.includes("INTO coalesce_events"));
    expect(ce).toBeDefined();
    expect(ce?.params).toContain("parent");
    expect(ce?.params).toContain("c_par_1"); // window_key
  });

  it("uses the consumer-assigned receivedAt as arrived_at, never the event's occurredAt", () => {
    // design.md §4.5 step 2: arrived_at is what the flush orders and keys by.
    // occurredAt is ledger order, which is NOT stable under unordered queues.
    const stmts = planBatch([parseEnvelope(lesson())], RECEIVED_AT, new Set());
    const ce = stmts.find((s) => s.sql.includes("INTO coalesce_events"));
    expect(ce?.params).toContain(RECEIVED_AT);
    expect(ce?.params).not.toContain("2026-08-04T10:00:00Z");
  });

  it("skips the coalesce row and marks the inbox ignored for a tombstoned child", () => {
    const stmts = planBatch([parseEnvelope(lesson())], RECEIVED_AT, new Set(["c_chi_1"]));
    expect(stmts.some((s) => s.sql.includes("INTO coalesce_events"))).toBe(false);
    const inbox = stmts.find((s) => s.sql.includes("INTO inbox"));
    expect(inbox?.params).toContain("ignored");
  });

  it("still records the inbox row as processed for a live child", () => {
    const stmts = planBatch([parseEnvelope(lesson())], RECEIVED_AT, new Set(["someone_else"]));
    const inbox = stmts.find((s) => s.sql.includes("INTO inbox"));
    expect(inbox?.params).toContain("processed");
  });
});

describe("consumeBatch — coalescing against real D1", () => {
  it("appends one membership row per learning event", async () => {
    const db = getDb(env.NOTI_D1);
    await consumeBatch(env.NOTI_D1, [
      lesson({ eventId: "cd_1:lesson", subject: { parentId: "cd_par", childId: "cd_chi", childName: "An" } }),
      lesson({
        eventId: "cd_2:star",
        type: "learning.star.awarded",
        subject: { parentId: "cd_par", childId: "cd_chi", childName: "An" },
        data: { courseId: "co1", challengeId: "ch1", totalStars: 12 },
      }),
    ]);
    const rows = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "cd_chi").execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scope === "child")).toBe(true);
  });

  it("a replayed batch does not duplicate membership", async () => {
    const db = getDb(env.NOTI_D1);
    const event = lesson({
      eventId: "cd_replay:lesson",
      subject: { parentId: "cd_par2", childId: "cd_chi2", childName: "Bình" },
    });
    await consumeBatch(env.NOTI_D1, [event]);
    await consumeBatch(env.NOTI_D1, [event]);
    const rows = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "cd_chi2").execute();
    expect(rows).toHaveLength(1);
  });

  it("a late learning event for a tombstoned child writes no membership", async () => {
    const db = getDb(env.NOTI_D1);
    const subject = { parentId: "cd_par3", childId: "cd_chi3", childName: "Cường" };
    await consumeBatch(env.NOTI_D1, [
      {
        specVersion: "1.0",
        eventId: "cd_tomb:deleted",
        type: "identity.child.deleted",
        occurredAt: "2026-08-05T10:00:00Z",
        producer: "robo-worker",
        subject,
        data: {},
      },
    ]);
    await consumeBatch(env.NOTI_D1, [lesson({ eventId: "cd_tomb:late-lesson", subject })]);

    const rows = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "cd_chi3").execute();
    expect(rows).toHaveLength(0);
    const inbox = await db
      .selectFrom("inbox")
      .selectAll()
      .where("event_id", "=", "cd_tomb:late-lesson")
      .executeTakeFirstOrThrow();
    expect(inbox.state).toBe("ignored");
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/consumer-coalesce.test.ts
```

Expected: FAIL — `planBatch` takes two arguments, not three, and writes no `coalesce_events` rows.

- [ ] **Step 3: Update `src/consumer/plan.ts`**

Add the statement constant near the other SQL:

```ts
// Append-only pending membership (design.md §4.5 step 1). window_key is
// child_id for learning events and parent_id for reporting ones, so ONE
// grouped query in the flush serves both scopes (§4.3).
const INSERT_COALESCE = `
INSERT OR IGNORE INTO coalesce_events
  (event_id, window_key, scope, child_id, parent_id, kind, payload_json, arrived_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
```

Replace `planRecordOnly` with:

```ts
/**
 * Learning and reporting events stage as coalescing membership rather than
 * sending directly (design.md §4.5 step 1) — three pushes for one 10-minute
 * sitting is how a service gets muted in week two.
 *
 * `arrived_at` is the CONSUMER-assigned receivedAt, never the event's
 * occurredAt: the flush orders and keys by arrival, because ledger order is
 * not stable under unordered queues (§4.5 step 2).
 */
function planCoalesced(event: EventV1, receivedAt: string, tombstoned: ReadonlySet<string>): PlannedStatement[] {
  const { parentId, childId } = event.subject;

  // §4.8 rule 3: a late event for a tombstoned child is `ignored`, and stages
  // nothing. The tombstone is terminal, so this can never become processable.
  if (tombstoned.has(childId)) {
    return [inboxRow(event.eventId, event.type, "ignored", event, receivedAt)];
  }

  const isReporting = event.type === "reporting.week.closed";
  const scope = isReporting ? "parent" : "child";
  const windowKey = isReporting ? parentId : childId;

  return [
    { sql: INSERT_PARENT, params: [parentId] },
    {
      sql: INSERT_COALESCE,
      params: [
        event.eventId,
        windowKey,
        scope,
        childId,
        parentId,
        event.type,
        JSON.stringify(event),
        receivedAt,
      ],
    },
    inboxRow(event.eventId, event.type, "processed", event, receivedAt),
  ];
}
```

Change `planBatch`'s signature and its `default:` branch:

```ts
export function planBatch(
  results: ParseResult[],
  receivedAt: string,
  tombstoned: ReadonlySet<string>,
): PlannedStatement[] {
```

```ts
        default:
          stmts.push(...planCoalesced(event, receivedAt, tombstoned));
          break;
```

- [ ] **Step 4: Update `src/consumer/handler.ts` to look up tombstones first**

```ts
import { parseEnvelope } from "./parse";
import { planBatch } from "./plan";

/**
 * Which of these children already carry a terminal tombstone (§4.8 rule 3).
 * ONE query per delivery batch — not per message. Deciding this inside the
 * batch is impossible: the inbox state depends on it, and a single batch
 * cannot branch on a read.
 */
async function tombstonedChildIds(d1: D1Database, childIds: string[]): Promise<Set<string>> {
  if (childIds.length === 0) return new Set();
  // json_each keeps this ONE bound parameter regardless of batch size — D1
  // caps bound parameters well below 100 (§5).
  const { results } = await d1
    .prepare(
      `SELECT child_id FROM children
        WHERE deleted_at IS NOT NULL
          AND child_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(childIds))
    .all<{ child_id: string }>();
  return new Set(results.map((r) => r.child_id));
}

export async function consumeBatch(d1: D1Database, payloads: unknown[]): Promise<void> {
  const results = payloads.map(parseEnvelope);

  const childIds = [
    ...new Set(results.flatMap((r) => (r.kind === "ok" ? [r.event.subject.childId] : []))),
  ];
  const tombstoned = await tombstonedChildIds(d1, childIds);

  const planned = planBatch(results, new Date().toISOString(), tombstoned);

  for (const result of results) {
    if (result.kind === "ok") continue;
    console.log(`[consumer] ${result.kind} eventId=${result.eventId ?? "<unidentifiable>"}`);
  }

  if (planned.length === 0) return;

  const statements = planned.map((s) => d1.prepare(s.sql).bind(...s.params));
  await d1.batch(statements);
}
```

`handleQueueBatch` is unchanged.

- [ ] **Step 5: Fix the existing `tests/consumer-plan.test.ts` call sites**

Every `planBatch(x, RECEIVED_AT)` becomes `planBatch(x, RECEIVED_AT, new Set())`. Do not change any
assertion — if one now fails, that's a real regression to investigate, not a test to adjust.

- [ ] **Step 6: Run the tests — expect pass**

```sh
pnpm test tests/consumer-coalesce.test.ts tests/consumer-plan.test.ts tests/consumer-handler.test.ts
```

Expected: PASS — 8 new + 10 existing plan + 8 existing handler.

- [ ] **Step 7: Commit**

```sh
git add src/consumer/plan.ts src/consumer/handler.ts tests/consumer-coalesce.test.ts tests/consumer-plan.test.ts
git commit -m "feat(consumer): stage learning and reporting events as coalescing membership (design.md §4.5)"
```

---

## Task 2: Window rendering (pure)

**Files:**
- Create: `src/flush/render.ts`
- Test: `tests/flush-render.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/flush-render.test.ts
import { describe, expect, it } from "vitest";
import { dedupeKeyFor, renderWindow, type WindowMember } from "../src/flush/render";

function member(overrides: Partial<WindowMember> = {}): WindowMember {
  return {
    eventId: "led_1:lesson_completed",
    windowKey: "chi_1",
    scope: "child",
    childId: "chi_1",
    parentId: "par_1",
    kind: "learning.lesson.completed",
    payload: {
      subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
      data: { courseId: "co1", lessonId: "l1", outcome: "achieved", durationS: 300 },
    },
    arrivedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

const context = { childName: "An", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" };

describe("dedupeKeyFor (design.md §4.5 step 2)", () => {
  it("keys on the oldest member by arrived_at", () => {
    const key = dedupeKeyFor([
      member({ eventId: "b", arrivedAt: "2026-08-07T10:05:00.000Z" }),
      member({ eventId: "a", arrivedAt: "2026-08-07T10:00:00.000Z" }),
    ]);
    expect(key).toBe("chi_1:a");
  });

  it("breaks ties within one batch by event_id", () => {
    const same = "2026-08-07T10:00:00.000Z";
    const key = dedupeKeyFor([
      member({ eventId: "zzz", arrivedAt: same }),
      member({ eventId: "aaa", arrivedAt: same }),
    ]);
    expect(key).toBe("chi_1:aaa");
  });

  it("is STABLE when a late arrival carries a smaller ledger eventId", () => {
    // The case a ledger-ordered key gets wrong (design.md §4.5 step 2):
    // ledger UUIDv7s land out of order, so min(event_id) would LOWER the key
    // on a late arrival, two overlapping ticks would compute different keys,
    // both INSERTs would succeed, and the parent gets two pushes.
    const first = member({ eventId: "zzz_high_ledger_id", arrivedAt: "2026-08-07T10:00:00.000Z" });
    const lateButSmaller = member({ eventId: "aaa_low_ledger_id", arrivedAt: "2026-08-07T10:09:00.000Z" });
    expect(dedupeKeyFor([first])).toBe("chi_1:zzz_high_ledger_id");
    expect(dedupeKeyFor([first, lateButSmaller])).toBe("chi_1:zzz_high_ledger_id");
  });
});

describe("renderWindow", () => {
  it("renders one child-scope notification for three events in a session", () => {
    const out = renderWindow(
      [
        member({ eventId: "e1", kind: "learning.lesson.completed" }),
        member({ eventId: "e2", kind: "learning.challenge.achieved" }),
        member({ eventId: "e3", kind: "learning.star.awarded" }),
      ],
      context,
    );
    expect(out.kind).toBe("progress");
    expect(out.parentId).toBe("par_1");
    expect(out.childId).toBe("chi_1");
    expect(out.dedupeKey).toBe("chi_1:e1");
    expect(out.title).toContain("An");
    expect(out.body).toBeTruthy();
  });

  it("prefers the identity mirror's name over the envelope's denormalized one", () => {
    // The mirror is fresh and handles renames (design.md §4.8 rule 1).
    const out = renderWindow([member()], { ...context, childName: "An Nguyễn" });
    expect(out.title).toContain("An Nguyễn");
  });

  it("falls back to the envelope name when the mirror has no row yet", () => {
    // Queues are unordered: a learning event CAN arrive before any
    // identity.child.upserted. An event is never unrenderable (§4.8 rule 1).
    const out = renderWindow([member()], { ...context, childName: null });
    expect(out.title).toContain("An");
  });

  it("renders a parent-scope weekly digest keyed on parentId", () => {
    const out = renderWindow(
      [
        member({
          eventId: "w1",
          windowKey: "par_1",
          scope: "parent",
          kind: "reporting.week.closed",
          payload: {
            subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
            data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
          },
        }),
      ],
      context,
    );
    expect(out.kind).toBe("weekly");
    expect(out.parentId).toBe("par_1");
    // A parent-scope digest is not about one child — §4.5 step 5.
    expect(out.childId).toBeNull();
  });

  it("folds a multi-child parent's weekly events into ONE digest", () => {
    // design.md §4.5 step 5: three children must not mean three pushes.
    const out = renderWindow(
      [
        member({
          eventId: "w1",
          windowKey: "par_1",
          scope: "parent",
          childId: "chi_1",
          kind: "reporting.week.closed",
          payload: {
            subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
            data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
          },
        }),
        member({
          eventId: "w2",
          windowKey: "par_1",
          scope: "parent",
          childId: "chi_2",
          kind: "reporting.week.closed",
          payload: {
            subject: { parentId: "par_1", childId: "chi_2", childName: "Bình" },
            data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 3, stars: 6, missionsAchieved: 2 },
          },
        }),
      ],
      context,
    );
    expect(out.dedupeKey).toBe("par_1:w1");
    // Both children's totals are in one body — the sum is what a parent sees.
    expect(out.body).toMatch(/8/); // 5 + 3 lessons
  });

  it("reports stars and missions as separate numbers", () => {
    // They are NOT derivable from each other (design.md §3.4).
    const out = renderWindow(
      [
        member({
          eventId: "w1",
          windowKey: "par_1",
          scope: "parent",
          kind: "reporting.week.closed",
          payload: {
            subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
            data: { weekStart: "2026-08-03", weekEnd: "2026-08-09", lessons: 5, stars: 14, missionsAchieved: 3 },
          },
        }),
      ],
      context,
    );
    const data = JSON.parse(out.dataJson);
    expect(data.stars).toBe(14);
    expect(data.missionsAchieved).toBe(3);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/flush-render.test.ts
```

Expected: FAIL — `../src/flush/render` does not exist.

- [ ] **Step 3: Write `src/flush/render.ts`**

```ts
// src/flush/render.ts
//
// Pure rendering: a window's membership + its render context → one
// notification (design.md §4.5). No bindings, no clock, no I/O — the flush
// renders the whole page in memory between its two queries and its one batch.
//
// Copy is vi-VN (§4.5). Names come from the identity mirror when it has a
// row and from the envelope's denormalized childName when it doesn't —
// queues are unordered, so a learning event can arrive before any identity
// event, and an event is never unrenderable (§4.8 rule 1).

import { uuidV7 } from "../utils/uuid";

export type WindowMember = {
  eventId: string;
  windowKey: string;
  scope: "child" | "parent";
  childId: string;
  parentId: string;
  kind: string;
  payload: {
    subject: { parentId: string; childId: string; childName: string };
    data: Record<string, unknown>;
  };
  arrivedAt: string;
};

export type RenderContext = {
  childName: string | null;
  timezone: string;
  locale: string;
};

export type RenderedNotification = {
  id: string;
  parentId: string;
  childId: string | null;
  kind: "progress" | "weekly";
  title: string;
  body: string;
  dataJson: string;
  dedupeKey: string;
};

/**
 * `'{window_key}:{event_id of the oldest row by (arrived_at, event_id)}'`.
 *
 * The obvious `min(event_id)` is WRONG. `eventId` for `learning.*` is
 * `{ledgerEventId}:{kind}`, ledger UUIDv7s land out of order as different
 * child DOs drain their outboxes, and queues are unordered — so a late
 * arrival carrying a SMALLER ledger id would lower the key, two overlapping
 * ticks would compute different keys, both INSERTs would succeed, and the
 * parent gets two pushes for one window. `arrived_at` is consumer-assigned,
 * so membership only ever grows later in the ordering and the key is stable
 * by construction. `event_id` breaks ties within a batch.
 */
export function dedupeKeyFor(members: WindowMember[]): string {
  let oldest = members[0];
  for (const m of members) {
    if (m.arrivedAt < oldest.arrivedAt || (m.arrivedAt === oldest.arrivedAt && m.eventId < oldest.eventId)) {
      oldest = m;
    }
  }
  return `${oldest.windowKey}:${oldest.eventId}`;
}

function nameFor(members: WindowMember[], context: RenderContext): string {
  return context.childName ?? members[0].payload.subject.childName;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function renderProgress(members: WindowMember[], context: RenderContext): RenderedNotification {
  const name = nameFor(members, context);
  const lessons = members.filter((m) => m.kind === "learning.lesson.completed").length;
  const challenges = members.filter((m) => m.kind === "learning.challenge.achieved").length;
  const stars = members
    .filter((m) => m.kind === "learning.star.awarded")
    .reduce((sum, m) => sum + num(m.payload.data.totalStars), 0);

  const parts: string[] = [];
  if (lessons > 0) parts.push(`hoàn thành ${lessons} bài học`);
  if (challenges > 0) parts.push(`chinh phục ${challenges} thử thách`);
  if (stars > 0) parts.push(`nhận ${stars} sao`);

  return {
    id: uuidV7(),
    parentId: members[0].parentId,
    childId: members[0].childId,
    kind: "progress",
    title: `${name} vừa học xong!`,
    body: parts.length > 0 ? `${name} ${parts.join(", ")}.` : `${name} vừa có một buổi học mới.`,
    dataJson: JSON.stringify({ lessons, challenges, stars, eventIds: members.map((m) => m.eventId) }),
    dedupeKey: dedupeKeyFor(members),
  };
}

function renderWeekly(members: WindowMember[], context: RenderContext): RenderedNotification {
  // One digest per PARENT, not per child (design.md §4.5 step 5) — a
  // three-child parent gets one push, so the numbers are summed across the
  // window's members.
  const lessons = members.reduce((sum, m) => sum + num(m.payload.data.lessons), 0);
  const stars = members.reduce((sum, m) => sum + num(m.payload.data.stars), 0);
  // stars and missionsAchieved are DIFFERENT numbers — one is an award value,
  // the other a row count (design.md §3.4). Never derive one from the other.
  const missionsAchieved = members.reduce((sum, m) => sum + num(m.payload.data.missionsAchieved), 0);
  const weekStart = String(members[0].payload.data.weekStart ?? "");
  const weekEnd = String(members[0].payload.data.weekEnd ?? "");

  return {
    id: uuidV7(),
    parentId: members[0].parentId,
    childId: null,
    kind: "weekly",
    title: "Tuần học vừa qua của bé",
    body: `Tuần này: ${lessons} bài học, ${missionsAchieved} nhiệm vụ hoàn thành, ${stars} sao.`,
    dataJson: JSON.stringify({ weekStart, weekEnd, lessons, stars, missionsAchieved }),
    dedupeKey: dedupeKeyFor(members),
  };
}

export function renderWindow(members: WindowMember[], context: RenderContext): RenderedNotification {
  return members[0].scope === "parent" ? renderWeekly(members, context) : renderProgress(members, context);
}
```

- [ ] **Step 4: Run the tests — expect pass**

```sh
pnpm test tests/flush-render.test.ts
```

Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```sh
git add src/flush/render.ts tests/flush-render.test.ts
git commit -m "feat(flush): pure window rendering with arrival-ordered dedupe_key (design.md §4.5)"
```

---

## Task 3: The set-based flush

**Files:**
- Create: `src/flush/flush.ts`
- Modify: `src/index.ts` (export `scheduled`)
- Modify: `wrangler.jsonc` (cron triggers)
- Test: `tests/flush.test.ts`

- [ ] **Step 1: Write the failing tests** — these prove §4.5's concurrency and coalescing claims against real D1

```ts
// tests/flush.test.ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { flushDueWindows } from "../src/flush/flush";
import { getDb } from "../src/datastore/d1/schema";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

async function seedMember(params: {
  eventId: string;
  windowKey: string;
  scope: "child" | "parent";
  childId: string;
  parentId: string;
  kind: string;
  arrivedAt: string;
}) {
  const db = getDb(env.NOTI_D1);
  await db
    .insertInto("coalesce_events")
    .values({
      event_id: params.eventId,
      window_key: params.windowKey,
      scope: params.scope,
      child_id: params.childId,
      parent_id: params.parentId,
      kind: params.kind,
      payload_json: JSON.stringify({
        subject: { parentId: params.parentId, childId: params.childId, childName: "An" },
        data: { courseId: "co1", lessonId: "l1", outcome: "achieved", durationS: 300 },
      }),
      arrived_at: params.arrivedAt,
    })
    .execute();
}

beforeEach(async () => {
  const db = getDb(env.NOTI_D1);
  await db.deleteFrom("coalesce_events").execute();
  await db.deleteFrom("notifications").execute();
});

describe("flushDueWindows — coalescing (design.md §4.5)", () => {
  it("merges three events in one session into ONE notification", async () => {
    for (const [i, kind] of [
      "learning.lesson.completed",
      "learning.challenge.achieved",
      "learning.star.awarded",
    ].entries()) {
      await seedMember({
        eventId: `f_merge_${i}`,
        windowKey: "f_chi_1",
        scope: "child",
        childId: "f_chi_1",
        parentId: "f_par_1",
        kind,
        arrivedAt: minutesAgo(15),
      });
    }
    await flushDueWindows(env.NOTI_D1, NOW);

    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_1").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("scheduled");
    // Membership is consumed by the guarded delete.
    const left = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "f_chi_1").execute();
    expect(left).toHaveLength(0);
  });

  it("leaves a window that is not yet due", async () => {
    await seedMember({
      eventId: "f_fresh",
      windowKey: "f_chi_fresh",
      scope: "child",
      childId: "f_chi_fresh",
      parentId: "f_par_fresh",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(2), // newest < 10 min, oldest < 30 min
    });
    await flushDueWindows(env.NOTI_D1, NOW);
    const db = getDb(env.NOTI_D1);
    expect(await db.selectFrom("notifications").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("coalesce_events").selectAll().execute()).toHaveLength(1);
  });

  it("fires the 30-minute hard cap for a continuously active session", async () => {
    // Newest is only 2 min old, so the 10-min rule does NOT fire — but the
    // oldest is past the hard cap, which exists precisely so a busy session
    // cannot postpone its push indefinitely (§4.5 step 1).
    await seedMember({
      eventId: "f_cap_old",
      windowKey: "f_chi_cap",
      scope: "child",
      childId: "f_chi_cap",
      parentId: "f_par_cap",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(35),
    });
    await seedMember({
      eventId: "f_cap_new",
      windowKey: "f_chi_cap",
      scope: "child",
      childId: "f_chi_cap",
      parentId: "f_par_cap",
      kind: "learning.star.awarded",
      arrivedAt: minutesAgo(2),
    });
    await flushDueWindows(env.NOTI_D1, NOW);
    const db = getDb(env.NOTI_D1);
    expect(await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_cap").execute()).toHaveLength(
      1,
    );
  });

  it("uses the shorter parent-scope window for weekly digests", async () => {
    // 5 min newest / 15 min oldest, vs the child scope's 10 / 30.
    await seedMember({
      eventId: "f_weekly",
      windowKey: "f_par_weekly",
      scope: "parent",
      childId: "f_chi_weekly",
      parentId: "f_par_weekly",
      kind: "reporting.week.closed",
      arrivedAt: minutesAgo(7),
    });
    await flushDueWindows(env.NOTI_D1, NOW);
    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_weekly").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("weekly");
  });
});

describe("flushDueWindows — concurrency (design.md §4.5 step 2)", () => {
  it("two overlapping ticks over the same due set produce exactly ONE notification", async () => {
    await seedMember({
      eventId: "f_race_1",
      windowKey: "f_chi_race",
      scope: "child",
      childId: "f_chi_race",
      parentId: "f_par_race",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(15),
    });
    await Promise.all([flushDueWindows(env.NOTI_D1, NOW), flushDueWindows(env.NOTI_D1, NOW)]);

    const db = getDb(env.NOTI_D1);
    // The loser's row hits the UNIQUE dedupe_key constraint and no-ops, so its
    // notification id never exists, so its half of the paired delete removes
    // nothing. No lease, no version column, no `flushing` state.
    const rows = await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_race").execute();
    expect(rows).toHaveLength(1);
  });

  it("stays at ONE notification when the last arrival carries the smallest ledger eventId", async () => {
    // The case a ledger-ordered dedupe_key gets wrong (§4.5 step 2, §7).
    await seedMember({
      eventId: "zzz_high_ledger",
      windowKey: "f_chi_ooo",
      scope: "child",
      childId: "f_chi_ooo",
      parentId: "f_par_ooo",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(20),
    });
    await seedMember({
      eventId: "aaa_low_ledger",
      windowKey: "f_chi_ooo",
      scope: "child",
      childId: "f_chi_ooo",
      parentId: "f_par_ooo",
      kind: "learning.star.awarded",
      arrivedAt: minutesAgo(12),
    });
    await Promise.all([flushDueWindows(env.NOTI_D1, NOW), flushDueWindows(env.NOTI_D1, NOW)]);

    const db = getDb(env.NOTI_D1);
    expect(await db.selectFrom("notifications").selectAll().where("parent_id", "=", "f_par_ooo").execute()).toHaveLength(
      1,
    );
  });

  it("an event arriving mid-flush survives into the next window", async () => {
    await seedMember({
      eventId: "f_mid_1",
      windowKey: "f_chi_mid",
      scope: "child",
      childId: "f_chi_mid",
      parentId: "f_par_mid",
      kind: "learning.lesson.completed",
      arrivedAt: minutesAgo(15),
    });
    await flushDueWindows(env.NOTI_D1, NOW);

    // Arrives after the page was read — a new row not in the page, so the
    // guarded delete never touched it.
    await seedMember({
      eventId: "f_mid_2",
      windowKey: "f_chi_mid",
      scope: "child",
      childId: "f_chi_mid",
      parentId: "f_par_mid",
      kind: "learning.star.awarded",
      arrivedAt: minutesAgo(1),
    });

    const db = getDb(env.NOTI_D1);
    const left = await db.selectFrom("coalesce_events").selectAll().where("window_key", "=", "f_chi_mid").execute();
    expect(left).toHaveLength(1);
    expect(left[0].event_id).toBe("f_mid_2");
  });
});

describe("flushDueWindows — query budget (design.md §5.1, §7 step 1b)", () => {
  it("issues a constant number of D1 queries regardless of how many windows are due", async () => {
    let count = 0;
    const counting = new Proxy(env.NOTI_D1, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            count++;
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;

    for (let i = 0; i < 40; i++) {
      await seedMember({
        eventId: `f_budget_${i}`,
        windowKey: `f_chi_budget_${i}`,
        scope: "child",
        childId: `f_chi_budget_${i}`,
        parentId: `f_par_budget_${i}`,
        kind: "learning.lesson.completed",
        arrivedAt: minutesAgo(15),
      });
    }
    await flushDueWindows(counting, NOW);

    const db = getDb(env.NOTI_D1);
    expect(await db.selectFrom("notifications").selectAll().execute()).toHaveLength(40);
    // A per-window loop would be 4-6 queries EACH — ~200 here, and dead at
    // ~200 due children against D1's 1,000-query invocation budget (§5.1).
    // The set-based form is: due+membership, render context, and one batch of
    // two statements.
    expect(count).toBeLessThanOrEqual(6);
  });

  it("drains coalesce_events rather than growing tick over tick", async () => {
    for (let i = 0; i < 10; i++) {
      await seedMember({
        eventId: `f_drain_${i}`,
        windowKey: `f_chi_drain_${i}`,
        scope: "child",
        childId: `f_chi_drain_${i}`,
        parentId: `f_par_drain_${i}`,
        kind: "learning.lesson.completed",
        arrivedAt: minutesAgo(15),
      });
    }
    await flushDueWindows(env.NOTI_D1, NOW);
    const db = getDb(env.NOTI_D1);
    expect(await db.selectFrom("coalesce_events").selectAll().execute()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/flush.test.ts
```

Expected: FAIL — `../src/flush/flush` does not exist.

- [ ] **Step 3: Write `src/flush/flush.ts`**

```ts
// src/flush/flush.ts
//
// The `* * * * *` flush (design.md §4.5 step 2). SET-BASED, never per window.
//
// A cron trigger is ONE invocation, so it inherits ONE 1,000-query D1 budget
// and 30 s of CPU. A per-window loop costs 4-6 queries each and therefore
// dies at ~200 due children per tick — and because the 30-minute hard cap
// keeps unserved windows permanently due, the backlog then grows
// monotonically instead of draining, with no error anywhere (§5.1). So the
// query count per tick is a small CONSTANT: one for due windows + their
// membership, one for render context, one batch of two statements.

import { getDb } from "../datastore/d1/schema";
import { renderWindow, type RenderContext, type RenderedNotification, type WindowMember } from "./render";

// §4.5 step 1. Child scope is the learning session; parent scope is the
// weekly digest, whose short window exists for exactly one reason — to let a
// multi-child parent's sibling events land before the digest renders.
const CHILD_QUIET_MS = 10 * 60_000;
const CHILD_HARD_CAP_MS = 30 * 60_000;
const PARENT_QUIET_MS = 5 * 60_000;
const PARENT_HARD_CAP_MS = 15 * 60_000;

/**
 * Page size. `json_each(?)` binds ONE parameter regardless of page size,
 * which is why the set-based form is mandatory rather than merely neater: D1
 * caps bound parameters per query well below a page's worth of event ids, so
 * an `IN (?,?,?…)` list cannot be chunked without reintroducing a per-window
 * statement count (§4.5, §5).
 *
 * design.md says "start at 500 and record the measured number here" — 500 it
 * is, unmeasured under production load. Revisit with the §7 step 1b budget
 * test against a realistic population before trusting it.
 */
const PAGE_SIZE = 500;

const DUE_WINDOWS_SQL = `
SELECT ce.event_id, ce.window_key, ce.scope, ce.child_id, ce.parent_id,
       ce.kind, ce.payload_json, ce.arrived_at
  FROM coalesce_events ce
  JOIN (SELECT window_key
          FROM coalesce_events
         GROUP BY window_key, scope
        HAVING (scope = 'child'  AND (MAX(arrived_at) <= ?1 OR MIN(arrived_at) <= ?2))
            OR (scope = 'parent' AND (MAX(arrived_at) <= ?3 OR MIN(arrived_at) <= ?4))
         ORDER BY MIN(arrived_at)
         LIMIT ?5) d
    ON d.window_key = ce.window_key
 ORDER BY ce.window_key, ce.arrived_at`;

// One query for the whole page's render context. children LEFT JOIN because
// the mirror may have no row yet (§4.8 rule 1 — the envelope name is the
// fallback, and an event is never unrenderable).
const RENDER_CONTEXT_SQL = `
SELECT c.child_id, c.name AS child_name, c.deleted_at,
       p.parent_id, p.timezone, p.locale
  FROM parents p
  LEFT JOIN children c ON c.parent_id = p.parent_id
 WHERE p.parent_id IN (SELECT value FROM json_each(?1))`;

// Multi-row insert; robo-worker's own idiom. OR IGNORE is what makes two
// overlapping ticks safe: the loser hits the UNIQUE dedupe_key and no-ops.
const INSERT_NOTIFICATIONS_SQL = `
INSERT OR IGNORE INTO notifications
  (id, parent_id, child_id, kind, title, body, data_json, scheduled_for, state, dedupe_key)
SELECT json_extract(value, '$.id'),
       json_extract(value, '$.parent_id'),
       json_extract(value, '$.child_id'),
       json_extract(value, '$.kind'),
       json_extract(value, '$.title'),
       json_extract(value, '$.body'),
       json_extract(value, '$.data_json'),
       json_extract(value, '$.scheduled_for'),
       'scheduled',
       json_extract(value, '$.dedupe_key')
  FROM json_each(?1)`;

// Guarded delete. Each pair carries its OWN notification id, so the guard
// stays PER WINDOW rather than becoming all-or-nothing across the page: a
// window whose insert lost the dedupe race deletes nothing and its
// membership stays put for the next tick.
//
// Only event_id and notification_id ride in this document — never payloads —
// to keep it clear of D1's string ceiling (§4.5).
const DELETE_MEMBERSHIP_SQL = `
DELETE FROM coalesce_events
 WHERE event_id IN (
   SELECT json_extract(j.value, '$.event_id')
     FROM json_each(?1) j
    WHERE EXISTS (SELECT 1 FROM notifications n
                   WHERE n.id = json_extract(j.value, '$.notification_id')))`;

type MembershipRow = {
  event_id: string;
  window_key: string;
  scope: "child" | "parent";
  child_id: string;
  parent_id: string;
  kind: string;
  payload_json: string;
  arrived_at: string;
};

type ContextRow = {
  child_id: string | null;
  child_name: string | null;
  deleted_at: string | null;
  parent_id: string;
  timezone: string;
  locale: string;
};

function toMember(row: MembershipRow): WindowMember {
  return {
    eventId: row.event_id,
    windowKey: row.window_key,
    scope: row.scope,
    childId: row.child_id,
    parentId: row.parent_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    arrivedAt: row.arrived_at,
  };
}

export async function flushDueWindows(d1: D1Database, now: Date = new Date()): Promise<number> {
  const at = now.getTime();
  const iso = (ms: number) => new Date(at - ms).toISOString();

  // (1) Due windows AND their full membership — one pass, one query.
  const { results: membership } = await d1
    .prepare(DUE_WINDOWS_SQL)
    .bind(iso(CHILD_QUIET_MS), iso(CHILD_HARD_CAP_MS), iso(PARENT_QUIET_MS), iso(PARENT_HARD_CAP_MS), PAGE_SIZE)
    .all<MembershipRow>();

  if (membership.length === 0) return 0;

  const windows = new Map<string, WindowMember[]>();
  for (const row of membership) {
    const member = toMember(row);
    const existing = windows.get(member.windowKey);
    if (existing) existing.push(member);
    else windows.set(member.windowKey, [member]);
  }

  // (2) Render context for the whole page — one query.
  const parentIds = [...new Set(membership.map((r) => r.parent_id))];
  const { results: contextRows } = await d1
    .prepare(RENDER_CONTEXT_SQL)
    .bind(JSON.stringify(parentIds))
    .all<ContextRow>();

  const contextByChild = new Map<string, ContextRow>();
  const contextByParent = new Map<string, ContextRow>();
  for (const row of contextRows) {
    if (row.child_id) contextByChild.set(row.child_id, row);
    if (!contextByParent.has(row.parent_id)) contextByParent.set(row.parent_id, row);
  }

  // (3) Render every notification in memory.
  const rendered: RenderedNotification[] = [];
  const deletePairs: Array<{ event_id: string; notification_id: string }> = [];
  const scheduledFor = new Date(at).toISOString();

  for (const members of windows.values()) {
    const first = members[0];
    const childRow = contextByChild.get(first.childId);
    const parentRow = contextByParent.get(first.parentId);

    // A child tombstoned between staging and flush: drop the window's
    // membership without rendering. Deletion already cancels pending rows in
    // its own batch (§4.8 rule 4), but a window staged microseconds earlier
    // can still be sitting here.
    if (childRow?.deleted_at) {
      for (const m of members) deletePairs.push({ event_id: m.event_id, notification_id: "" });
      continue;
    }

    const context: RenderContext = {
      childName: childRow?.child_name ?? null,
      timezone: parentRow?.timezone ?? "Asia/Ho_Chi_Minh",
      locale: parentRow?.locale ?? "vi-VN",
    };
    const notification = renderWindow(members, context);
    rendered.push(notification);
    for (const m of members) {
      deletePairs.push({ event_id: m.event_id, notification_id: notification.id });
    }
  }

  // (4) One batch for the whole page — two statements, not two per window.
  const notificationDocs = rendered.map((n) => ({
    id: n.id,
    parent_id: n.parentId,
    child_id: n.childId,
    kind: n.kind,
    title: n.title,
    body: n.body,
    data_json: n.dataJson,
    scheduled_for: scheduledFor,
    dedupe_key: n.dedupeKey,
  }));

  await d1.batch([
    d1.prepare(INSERT_NOTIFICATIONS_SQL).bind(JSON.stringify(notificationDocs)),
    d1.prepare(DELETE_MEMBERSHIP_SQL).bind(JSON.stringify(deletePairs)),
  ]);

  return rendered.length;
}
```

> **Note on the tombstoned-window branch:** those pairs carry `notification_id: ""`, which no
> `notifications.id` ever equals, so the guarded `DELETE`'s `EXISTS` check fails and the rows are **not**
> removed. That is a real gap — the membership stays and is re-scanned every tick. Fix it in Step 4 below
> rather than shipping it; it's called out here because the shape of the guard makes it non-obvious.

- [ ] **Step 4: Fix the tombstoned-window leak**

Give tombstoned windows their own unguarded delete rather than smuggling them through the guarded one. Replace
the tombstone branch and the batch with:

```ts
  const rendered: RenderedNotification[] = [];
  const deletePairs: Array<{ event_id: string; notification_id: string }> = [];
  const tombstonedEventIds: string[] = [];
  const scheduledFor = new Date(at).toISOString();

  for (const members of windows.values()) {
    const first = members[0];
    const childRow = contextByChild.get(first.childId);
    const parentRow = contextByParent.get(first.parentId);

    // A child tombstoned between staging and flush. Its membership is dropped
    // unconditionally — there is no notification to guard against, and
    // leaving it would keep the window permanently due (§4.5 step 1's hard
    // cap guarantees it) and re-scanned every tick forever.
    if (childRow?.deleted_at) {
      for (const m of members) tombstonedEventIds.push(m.event_id);
      continue;
    }
    // ...unchanged...
  }
```

and add a third statement to the batch, conditionally:

```ts
  const statements = [
    d1.prepare(INSERT_NOTIFICATIONS_SQL).bind(JSON.stringify(notificationDocs)),
    d1.prepare(DELETE_MEMBERSHIP_SQL).bind(JSON.stringify(deletePairs)),
  ];
  if (tombstonedEventIds.length > 0) {
    statements.push(
      d1
        .prepare(`DELETE FROM coalesce_events WHERE event_id IN (SELECT value FROM json_each(?1))`)
        .bind(JSON.stringify(tombstonedEventIds)),
    );
  }
  await d1.batch(statements);
```

Still a constant statement count per tick (three, not two) — the budget invariant holds.

- [ ] **Step 5: Export `scheduled` from `src/index.ts`**

```ts
import { flushDueWindows } from "./flush/flush";
```

```ts
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // The 1-minute flush. Part 3 adds the hourly sweeper and retention
    // sweeps on their own cron expressions, routed by controller.cron.
    const count = await flushDueWindows(env.NOTI_D1);
    if (count > 0) console.log(`[flush] rendered ${count} notification(s)`);
  },
```

- [ ] **Step 6: Add the cron trigger to `wrangler.jsonc`**

Top level, next to `queues`:

```jsonc
"triggers": {
  // The 1-minute flush (design.md §4.5 step 2). A <1h interval gets 30s CPU,
  // which is why the flush must stay set-based (§5).
  "crons": ["* * * * *"]
},
```

**Do not add it to `env.test`** — `vitest-pool-workers` invokes `scheduled()` directly in tests; a cron
entry there would just make local runs noisier.

- [ ] **Step 7: Run the tests — expect pass**

```sh
pnpm test tests/flush.test.ts
```

Expected: PASS, all 9 tests. Pay particular attention to the two concurrency tests and the budget test — if
the budget test reports more than 6 `prepare` calls, something reintroduced a per-window query and the whole
point of this task is lost.

- [ ] **Step 8: Run the full suite, type-check, lint**

```sh
pnpm types
pnpm type-check
pnpm test
pnpm lint
```

Expected: all green — 95 existing + 8 coalesce + 9 render + 9 flush = 121. Recount against actual output
rather than trusting this arithmetic.

- [ ] **Step 9: Commit**

```sh
git add src/flush/flush.ts src/index.ts wrangler.jsonc worker-configuration.d.ts tests/flush.test.ts
git commit -m "feat(flush): set-based flush cron rendering coalesced notifications (design.md §4.5, §5.1)"
```

---

## Final check for this plan

```sh
cd /home/ducmai/work/tuni-noti
pnpm type-check
pnpm test
pnpm lint
git log --oneline -4
```

Expected: clean type-check, all tests green, no lint errors, 3 new commits.

**What this unblocks:** Part 3 (preference gates + `SEND_QUEUE` enqueue + sweeper) slots between rendering and
the batch commit — caps reserve for the whole page in one statement, quiet hours change `state` and
`scheduled_for`, and due rows go onto the queue instead of just sitting as `scheduled`.

**What this does NOT do yet:**
- **Every notification is `scheduled` and nothing is sent.** No quiet hours, no daily cap, no `PUSH_ENABLED`
  gate, no `SEND_QUEUE` — all Part 3.
- **`PAGE_SIZE` is 500, unmeasured.** design.md §4.5 says to record the measured number; that needs a
  realistic population and a real CPU measurement, which is a load-test task, not this one.
- No `NOTI_METRICS`, no retention sweeps (both still open from Part 1).
