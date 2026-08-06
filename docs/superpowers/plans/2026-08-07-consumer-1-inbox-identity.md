# Consumer Part 1: Inbox + Identity Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build tuni-noti's queue consumer entry point — the idempotent inbox (`docs/design.md` §4.4) and the
identity mirror with LWW renames and terminal tombstones (§4.8) — so inbound domain events from robo-worker
are recorded exactly once and children's names/deletions are tracked correctly.

**Architecture:** One exported `queue()` handler in `src/index.ts` routes by queue name. The whole effect for a
delivery batch is a **single `d1.batch()`** — D1 batches run as an implicit transaction, every statement is
`INSERT OR IGNORE` or a conditional `UPDATE`, so replays and concurrent duplicate deliveries no-op instead of
racing. No claim protocol, no leases, no `received` state (design review killed that — see §4.4). Statement
*building* is pure and unit-testable (`src/consumer/plan.ts`); statement *execution* is a thin wrapper.

**Tech Stack:** Cloudflare Queues consumer, D1 `batch()` (raw `D1PreparedStatement`, not Kysely — the vendored
dialect throws on transactions, and `batch()` is the only atomic primitive available), arktype `eventV1`
contract from `src/events/v1.ts`, `@cloudflare/vitest-pool-workers`.

**This plan is Part 1 of 3.** Part 2 is coalescing + the flush cron (§4.5); Part 3 is the FCM send consumer
(§4.6). They're split because each is independently testable and shippable, and because §4.5's set-based flush
is large enough to warrant its own review checkpoint. Part 1 deliberately writes **no** `coalesce_events` rows
for learning events yet — it records them in the inbox and stops. Part 2 adds the coalescing membership write
into the same batch. That's a real, working increment: after Part 1, `inbox` and the identity mirror are
correct and observable, they just don't drive pushes yet.

---

## Before you start

```sh
cd /home/ducmai/work/tuni-noti
pnpm test        # 71 passed
pnpm type-check  # clean
git log --oneline -1   # 7aed6c4 (or later) — Parent API merged
```

Read `docs/design.md` §4.4 and §4.8 in full before starting. The idempotency argument in §4.4 and the
out-of-order rules in §4.8 are the whole point of this plan; a change that violates either is wrong even if
its tests pass.

---

## Task 1: Envelope parsing + version gate

**Files:**
- Create: `src/consumer/parse.ts`
- Test: `tests/consumer-parse.test.ts`

The consumer must distinguish four cases *before* deciding any effect, and three of them must never reach the
DLQ (design.md §4.4):

| Case | Outcome |
|---|---|
| Valid `1.x` envelope, known type | process normally |
| Unknown major `specVersion` (e.g. `2.0`) | `ignored` + distinct metric — **never** retry |
| Known version, unrecognized `type` | `ignored` + metric — **never** retry |
| Structurally unparseable (not even an envelope) | `ignored` + metric — retrying malformed bytes never helps |

- [ ] **Step 1: Write the failing tests**

```ts
// tests/consumer-parse.test.ts
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/consumer/parse";

const valid = {
  specVersion: "1.0",
  eventId: "chi_1:upserted:2026-08-04T10:00:00Z",
  type: "identity.child.upserted",
  occurredAt: "2026-08-04T10:00:00Z",
  producer: "robo-worker",
  subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
  data: { name: "An", age: 6, stage: "A1" },
};

describe("parseEnvelope", () => {
  it("accepts a valid 1.0 envelope", () => {
    const out = parseEnvelope(valid);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.event.type).toBe("identity.child.upserted");
      expect(out.event.eventId).toBe("chi_1:upserted:2026-08-04T10:00:00Z");
    }
  });

  it("classifies a 2.0 envelope as version_unsupported, not a parse failure", () => {
    const out = parseEnvelope({ ...valid, specVersion: "2.0" });
    expect(out.kind).toBe("version_unsupported");
    // Must still surface the id so the inbox can record an `ignored` row against it.
    if (out.kind === "version_unsupported") expect(out.eventId).toBe(valid.eventId);
  });

  it("classifies an unknown type as type_unsupported", () => {
    const out = parseEnvelope({ ...valid, type: "learning.something.new" });
    expect(out.kind).toBe("type_unsupported");
    if (out.kind === "type_unsupported") expect(out.eventId).toBe(valid.eventId);
  });

  it("classifies a structurally broken payload as malformed", () => {
    expect(parseEnvelope({ nope: 1 }).kind).toBe("malformed");
    expect(parseEnvelope(null).kind).toBe("malformed");
    expect(parseEnvelope("a string").kind).toBe("malformed");
  });

  it("treats a 1.x minor bump as processable — additive-only within a major", () => {
    // A 1.1 producer adding fields must NOT be ignored; §2's additive rule is
    // exactly what makes this safe.
    const out = parseEnvelope({ ...valid, specVersion: "1.1" });
    expect(out.kind).toBe("ok");
  });

  it("recovers the eventId from a malformed-but-identifiable payload", () => {
    // Enough envelope to know WHICH event this was, but the data shape is
    // wrong. Recording an `ignored` row still beats an untraceable DLQ entry.
    const out = parseEnvelope({ ...valid, data: { age: "not a number" } });
    expect(out.kind).toBe("malformed");
    if (out.kind === "malformed") expect(out.eventId).toBe(valid.eventId);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/consumer-parse.test.ts
```

Expected: FAIL — `../src/consumer/parse` does not exist.

- [ ] **Step 3: Write `src/consumer/parse.ts`**

Note the ordering: the version gate runs **before** the arktype contract check, because `eventV1` pins
`specVersion: "1.0"` exactly. A `1.1` envelope must be accepted (additive-only within a major, §2) and a `2.0`
one must be `version_unsupported` rather than a generic parse failure — neither is distinguishable if you let
the contract schema decide first.

```ts
// src/consumer/parse.ts
//
// Classifies an inbound queue message before any effect is chosen
// (design.md §4.4). Three of the four outcomes are terminal-but-recorded:
// an unsupported version, an unrecognized type, and a malformed payload all
// become an `ignored` inbox row plus a metric — never a retry, never a DLQ
// entry. Retrying any of them is guaranteed to fail identically.

import { type } from "arktype";
import { type EventV1, eventV1 } from "../events/v1";

export type ParseResult =
  | { kind: "ok"; event: EventV1 }
  | { kind: "version_unsupported"; eventId: string | null; specVersion: string }
  | { kind: "type_unsupported"; eventId: string | null; type: string }
  | { kind: "malformed"; eventId: string | null; reason: string };

// Just enough to identify an event for the inbox even when the rest is wrong.
// Deliberately looser than the real contract: this is a forensics shape, not
// a validation gate.
const identifiable = type({
  "eventId?": "string",
  "specVersion?": "string",
  "type?": "string",
});

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "identity.child.upserted",
  "identity.child.deleted",
  "identity.parent.deleted",
  "learning.lesson.completed",
  "learning.challenge.achieved",
  "learning.star.awarded",
  "reporting.week.closed",
]);

function idOf(value: unknown): string | null {
  const out = identifiable(value);
  if (out instanceof type.errors) return null;
  return out.eventId ?? null;
}

export function parseEnvelope(value: unknown): ParseResult {
  const shallow = identifiable(value);
  if (shallow instanceof type.errors) {
    return { kind: "malformed", eventId: null, reason: "not an object envelope" };
  }

  // Version gate FIRST — see the note above about why this cannot come after
  // the contract check.
  const specVersion = shallow.specVersion;
  if (typeof specVersion !== "string") {
    return { kind: "malformed", eventId: shallow.eventId ?? null, reason: "missing specVersion" };
  }
  const major = specVersion.split(".")[0];
  if (major !== "1") {
    return { kind: "version_unsupported", eventId: shallow.eventId ?? null, specVersion };
  }

  const eventType = shallow.type;
  if (typeof eventType !== "string") {
    return { kind: "malformed", eventId: shallow.eventId ?? null, reason: "missing type" };
  }
  if (!KNOWN_TYPES.has(eventType)) {
    return { kind: "type_unsupported", eventId: shallow.eventId ?? null, type: eventType };
  }

  // A 1.x minor bump must pass the contract, which pins "1.0" exactly — so
  // normalize the version for the contract check only. The original string is
  // never persisted from here; the inbox stores the raw payload.
  const forContract = { ...(value as Record<string, unknown>), specVersion: "1.0" };
  const parsed = eventV1(forContract);
  if (parsed instanceof type.errors) {
    return {
      kind: "malformed",
      eventId: shallow.eventId ?? null,
      reason: parsed.map((e) => e.toString()).join("; ").slice(0, 300),
    };
  }

  return { kind: "ok", event: parsed };
}

export function isKnownType(value: string): boolean {
  return KNOWN_TYPES.has(value);
}
```

- [ ] **Step 4: Run the tests — expect pass**

```sh
pnpm test tests/consumer-parse.test.ts
```

Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```sh
git add src/consumer/parse.ts tests/consumer-parse.test.ts
git commit -m "feat(consumer): envelope parsing with version and type gates (design.md §4.4)"
```

---

## Task 2: Batch statement planning (pure)

**Files:**
- Create: `src/consumer/plan.ts`
- Test: `tests/consumer-plan.test.ts`

This is the seam that makes §4.4's idempotency argument testable without a database. `planBatch()` takes a
list of parse results and returns a list of `{sql, params}` descriptors; Task 3 binds and executes them in one
`d1.batch()`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/consumer-plan.test.ts
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/consumer/parse";
import { planBatch } from "../src/consumer/plan";

const RECEIVED_AT = "2026-08-07T10:00:00.000Z";

function upserted(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: "1.0",
    eventId: "chi_1:upserted:2026-08-04T10:00:00Z",
    type: "identity.child.upserted",
    occurredAt: "2026-08-04T10:00:00Z",
    producer: "robo-worker",
    subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
    data: { name: "An", age: 6, stage: "A1" },
    ...overrides,
  };
}

function deleted(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: "1.0",
    eventId: "chi_1:deleted",
    type: "identity.child.deleted",
    occurredAt: "2026-08-05T10:00:00Z",
    producer: "robo-worker",
    subject: { parentId: "par_1", childId: "chi_1", childName: "An" },
    data: {},
    ...overrides,
  };
}

describe("planBatch", () => {
  it("writes exactly one inbox row per event, marked processed", () => {
    const stmts = planBatch([parseEnvelope(upserted())], RECEIVED_AT);
    const inboxStmts = stmts.filter((s) => s.sql.includes("INTO inbox"));
    expect(inboxStmts).toHaveLength(1);
    expect(inboxStmts[0].sql).toMatch(/INSERT OR IGNORE/);
    expect(inboxStmts[0].params).toContain("processed");
  });

  it("marks an unsupported version as ignored, with no other effect", () => {
    const stmts = planBatch([parseEnvelope(upserted({ specVersion: "2.0" }))], RECEIVED_AT);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toMatch(/INTO inbox/);
    expect(stmts[0].params).toContain("ignored");
  });

  it("marks an unknown type as ignored, with no other effect", () => {
    const stmts = planBatch([parseEnvelope(upserted({ type: "learning.nope" }))], RECEIVED_AT);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].params).toContain("ignored");
  });

  it("drops a malformed event with no recoverable id entirely — nothing to key an inbox row on", () => {
    const stmts = planBatch([parseEnvelope({ nope: 1 })], RECEIVED_AT);
    expect(stmts).toHaveLength(0);
  });

  it("still records a malformed-but-identifiable event as ignored", () => {
    const stmts = planBatch([parseEnvelope(upserted({ data: { age: "nope" } }))], RECEIVED_AT);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].params).toContain("ignored");
  });

  it("plans a parent row, a child upsert, and an inbox row for identity.child.upserted", () => {
    const stmts = planBatch([parseEnvelope(upserted())], RECEIVED_AT);
    expect(stmts.some((s) => s.sql.includes("INTO parents"))).toBe(true);
    expect(stmts.some((s) => s.sql.includes("INTO children"))).toBe(true);
    expect(stmts.some((s) => s.sql.includes("INTO inbox"))).toBe(true);
  });

  it("guards the child upsert on identity_updated_at so an older rename cannot regress a newer name", () => {
    const stmts = planBatch([parseEnvelope(upserted())], RECEIVED_AT);
    const childStmt = stmts.find((s) => s.sql.includes("INTO children"));
    expect(childStmt).toBeDefined();
    // The LWW guard (design.md §4.8 rule 2) — without this a delayed older
    // rename overwrites a newer one, and queues ARE unordered.
    expect(childStmt?.sql).toMatch(/identity_updated_at\s*<=/);
  });

  it("never clears deleted_at on upsert — the tombstone is terminal", () => {
    const stmts = planBatch([parseEnvelope(upserted())], RECEIVED_AT);
    const childStmt = stmts.find((s) => s.sql.includes("INTO children"));
    // design.md §4.8 rule 3: a late upsert must not resurrect a deleted child.
    expect(childStmt?.sql).not.toMatch(/deleted_at\s*=\s*NULL/i);
  });

  it("plans a tombstone write plus cancellations for identity.child.deleted", () => {
    const stmts = planBatch([parseEnvelope(deleted())], RECEIVED_AT);
    const sqls = stmts.map((s) => s.sql).join("\n");
    expect(sqls).toMatch(/deleted_at/);
    // §4.8 rule 4: deletion cancels in-flight work in the SAME batch.
    expect(sqls).toMatch(/coalesce_events/);
    expect(sqls).toMatch(/notifications/);
    expect(sqls).toMatch(/deliveries/);
    // ...but never touches the parent's tokens — they serve other children.
    expect(sqls).not.toMatch(/push_tokens/);
  });

  it("plans one batch for many events without per-event duplication of unrelated work", () => {
    const stmts = planBatch(
      [
        parseEnvelope(upserted()),
        parseEnvelope(upserted({ eventId: "chi_2:upserted", subject: { parentId: "par_1", childId: "chi_2", childName: "Bình" } })),
      ],
      RECEIVED_AT,
    );
    // Two events → two inbox rows. The count is what proves we're not
    // silently collapsing distinct events.
    expect(stmts.filter((s) => s.sql.includes("INTO inbox"))).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/consumer-plan.test.ts
```

Expected: FAIL — `../src/consumer/plan` does not exist.

- [ ] **Step 3: Write `src/consumer/plan.ts`**

```ts
// src/consumer/plan.ts
//
// Turns parse results into the exact statement list for ONE d1.batch()
// (design.md §4.4). Pure: no bindings, no I/O, no Date.now() — the caller
// passes `receivedAt`. That is what makes the idempotency argument testable.
//
// Every statement is INSERT OR IGNORE or a conditional UPDATE, so:
//   crash before commit → nothing happened → redelivery re-runs identically
//   crash after commit  → redelivery no-ops row by row
// There is no claim protocol and no `received` state. An earlier draft had
// one; review killed it because `received` cannot distinguish "crashed" from
// "still working", so two deliveries could both process one event.

import type { EventV1 } from "../events/v1";
import type { ParseResult } from "./parse";

export type PlannedStatement = { sql: string; params: unknown[] };

const INSERT_INBOX = `
INSERT OR IGNORE INTO inbox (event_id, type, state, payload_json, received_at)
VALUES (?, ?, ?, ?, ?)`;

const INSERT_PARENT = `
INSERT OR IGNORE INTO parents (parent_id, timezone, locale)
VALUES (?, 'Asia/Ho_Chi_Minh', 'vi-VN')`;

// Last-write-wins guarded by identity_updated_at (design.md §4.8 rule 2), and
// deliberately NOT clearing deleted_at (rule 3 — the tombstone is terminal,
// child ids are UUIDs and never reused).
const UPSERT_CHILD = `
INSERT INTO children (child_id, parent_id, name, identity_updated_at, deleted_at)
VALUES (?, ?, ?, ?, NULL)
ON CONFLICT (child_id) DO UPDATE SET
  parent_id = excluded.parent_id,
  name = excluded.name,
  identity_updated_at = excluded.identity_updated_at
WHERE children.identity_updated_at <= excluded.identity_updated_at`;

const TOMBSTONE_CHILD = `
INSERT INTO children (child_id, parent_id, name, identity_updated_at, deleted_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (child_id) DO UPDATE SET
  deleted_at = COALESCE(children.deleted_at, excluded.deleted_at)`;

// §4.8 rule 4: cancel in-flight work in the same batch as the tombstone.
const CANCEL_COALESCE = `DELETE FROM coalesce_events WHERE child_id = ?`;

const CANCEL_NOTIFICATIONS = `
UPDATE notifications SET state = 'canceled'
 WHERE child_id = ? AND state IN ('scheduled', 'deferred_quiet')`;

const CANCEL_DELIVERIES = `
UPDATE deliveries SET state = 'canceled'
 WHERE state = 'pending'
   AND notification_id IN (SELECT id FROM notifications WHERE child_id = ?)`;

function inboxRow(
  eventId: string,
  type: string,
  state: "processed" | "ignored",
  payload: unknown,
  receivedAt: string,
): PlannedStatement {
  return {
    sql: INSERT_INBOX,
    params: [eventId, type, state, JSON.stringify(payload), receivedAt],
  };
}

function planIdentityUpserted(event: EventV1, receivedAt: string): PlannedStatement[] {
  const { parentId, childId, childName } = event.subject;
  // The mirror stores the identity event's own occurredAt as the LWW clock —
  // NOT receivedAt, which is arrival order and would make a delayed older
  // rename win (queues are unordered, §4.8).
  const identityUpdatedAt = event.occurredAt;
  const name = "name" in event.data && typeof event.data.name === "string" ? event.data.name : childName;
  return [
    { sql: INSERT_PARENT, params: [parentId] },
    { sql: UPSERT_CHILD, params: [childId, parentId, name, identityUpdatedAt] },
    inboxRow(event.eventId, event.type, "processed", event, receivedAt),
  ];
}

function planIdentityDeleted(event: EventV1, receivedAt: string): PlannedStatement[] {
  const { parentId, childId, childName } = event.subject;
  return [
    { sql: INSERT_PARENT, params: [parentId] },
    { sql: TOMBSTONE_CHILD, params: [childId, parentId, childName, event.occurredAt, event.occurredAt] },
    { sql: CANCEL_COALESCE, params: [childId] },
    { sql: CANCEL_NOTIFICATIONS, params: [childId] },
    { sql: CANCEL_DELIVERIES, params: [childId] },
    inboxRow(event.eventId, event.type, "processed", event, receivedAt),
  ];
}

/**
 * Learning and reporting events are recorded in the inbox here and otherwise
 * inert — coalescing membership arrives in Part 2 of this plan series
 * (design.md §4.5). Recording them now is not a placeholder: the inbox row IS
 * the dedupe record, and it must exist from the first version of the consumer
 * or replays would double-process once Part 2 lands.
 */
function planRecordOnly(event: EventV1, receivedAt: string): PlannedStatement[] {
  return [inboxRow(event.eventId, event.type, "processed", event, receivedAt)];
}

export function planBatch(results: ParseResult[], receivedAt: string): PlannedStatement[] {
  const stmts: PlannedStatement[] = [];

  for (const result of results) {
    if (result.kind === "ok") {
      const event = result.event;
      switch (event.type) {
        case "identity.child.upserted":
          stmts.push(...planIdentityUpserted(event, receivedAt));
          break;
        case "identity.child.deleted":
          stmts.push(...planIdentityDeleted(event, receivedAt));
          break;
        // Defined in the contract, no producer yet (design.md §1.5). Recorded
        // as ignored so the switch is exhaustive and the day a producer
        // appears it fails loudly here rather than silently in a fallback.
        case "identity.parent.deleted":
          stmts.push(inboxRow(event.eventId, event.type, "ignored", event, receivedAt));
          break;
        default:
          stmts.push(...planRecordOnly(event, receivedAt));
          break;
      }
      continue;
    }

    // Every non-ok case is terminal-but-recorded — EXCEPT one with no id at
    // all, which has nothing to key an inbox row on. Dropping it is the only
    // option; the metric (Task 3) is what makes it visible.
    if (result.eventId === null) continue;

    const type =
      result.kind === "type_unsupported"
        ? result.type
        : result.kind === "version_unsupported"
          ? `unsupported:${result.specVersion}`
          : "malformed";
    stmts.push(inboxRow(result.eventId, type, "ignored", { reason: result.kind }, receivedAt));
  }

  return stmts;
}
```

- [ ] **Step 4: Run the tests — expect pass**

```sh
pnpm test tests/consumer-plan.test.ts
```

Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```sh
git add src/consumer/plan.ts tests/consumer-plan.test.ts
git commit -m "feat(consumer): pure batch statement planning for inbox + identity mirror (design.md §4.4, §4.8)"
```

---

## Task 3: The `queue()` handler + real-D1 idempotency tests

**Files:**
- Create: `src/consumer/handler.ts`
- Modify: `src/index.ts` (export `queue`)
- Test: `tests/consumer-handler.test.ts`

- [ ] **Step 1: Write the failing tests** — these are the ones that actually prove §4.4's claims against real D1

```ts
// tests/consumer-handler.test.ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { consumeBatch } from "../src/consumer/handler";
import { getDb } from "../src/datastore/d1/schema";

function upserted(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: "1.0",
    eventId: "h_chi_1:upserted:2026-08-04T10:00:00Z",
    type: "identity.child.upserted",
    occurredAt: "2026-08-04T10:00:00Z",
    producer: "robo-worker",
    subject: { parentId: "h_par_1", childId: "h_chi_1", childName: "An" },
    data: { name: "An", age: 6, stage: "A1" },
    ...overrides,
  };
}

describe("consumeBatch — idempotency (design.md §4.4)", () => {
  it("records one inbox row and mirrors the child", async () => {
    await consumeBatch(env.NOTI_D1, [upserted()]);
    const db = getDb(env.NOTI_D1);
    const inbox = await db
      .selectFrom("inbox")
      .selectAll()
      .where("event_id", "=", "h_chi_1:upserted:2026-08-04T10:00:00Z")
      .executeTakeFirstOrThrow();
    expect(inbox.state).toBe("processed");
    const child = await db
      .selectFrom("children")
      .selectAll()
      .where("child_id", "=", "h_chi_1")
      .executeTakeFirstOrThrow();
    expect(child.name).toBe("An");
    expect(child.deleted_at).toBeNull();
  });

  it("re-running the same batch is a row-by-row no-op (crash replay)", async () => {
    const event = upserted({ eventId: "h_replay:1", subject: { parentId: "h_par_2", childId: "h_chi_2", childName: "Bình" } });
    await consumeBatch(env.NOTI_D1, [event]);
    await consumeBatch(env.NOTI_D1, [event]);
    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("inbox").selectAll().where("event_id", "=", "h_replay:1").execute();
    expect(rows).toHaveLength(1);
  });

  it("concurrent duplicate delivery of one event yields one inbox row", async () => {
    const event = upserted({ eventId: "h_concurrent:1", subject: { parentId: "h_par_3", childId: "h_chi_3", childName: "Cường" } });
    await Promise.all([consumeBatch(env.NOTI_D1, [event]), consumeBatch(env.NOTI_D1, [event])]);
    const db = getDb(env.NOTI_D1);
    const rows = await db.selectFrom("inbox").selectAll().where("event_id", "=", "h_concurrent:1").execute();
    expect(rows).toHaveLength(1);
  });

  it("an unknown type is recorded as ignored, never thrown", async () => {
    await expect(
      consumeBatch(env.NOTI_D1, [upserted({ eventId: "h_unknown:1", type: "learning.brand.new" })]),
    ).resolves.not.toThrow();
    const db = getDb(env.NOTI_D1);
    const row = await db.selectFrom("inbox").selectAll().where("event_id", "=", "h_unknown:1").executeTakeFirstOrThrow();
    expect(row.state).toBe("ignored");
  });

  it("an unknown major specVersion is recorded as ignored, never thrown", async () => {
    await expect(
      consumeBatch(env.NOTI_D1, [upserted({ eventId: "h_v2:1", specVersion: "2.0" })]),
    ).resolves.not.toThrow();
    const db = getDb(env.NOTI_D1);
    const row = await db.selectFrom("inbox").selectAll().where("event_id", "=", "h_v2:1").executeTakeFirstOrThrow();
    expect(row.state).toBe("ignored");
  });
});

describe("consumeBatch — identity mirror (design.md §4.8)", () => {
  it("a delayed OLDER rename cannot regress a newer name (LWW)", async () => {
    const subject = { parentId: "h_par_lww", childId: "h_chi_lww", childName: "Old" };
    // Newer event arrives first — queues are unordered, this is the normal case.
    await consumeBatch(env.NOTI_D1, [
      upserted({
        eventId: "h_lww:new",
        occurredAt: "2026-08-06T10:00:00Z",
        subject,
        data: { name: "NewName", age: 7, stage: "A2" },
      }),
    ]);
    await consumeBatch(env.NOTI_D1, [
      upserted({
        eventId: "h_lww:old",
        occurredAt: "2026-08-01T10:00:00Z",
        subject,
        data: { name: "OldName", age: 6, stage: "A1" },
      }),
    ]);
    const db = getDb(env.NOTI_D1);
    const child = await db
      .selectFrom("children")
      .selectAll()
      .where("child_id", "=", "h_chi_lww")
      .executeTakeFirstOrThrow();
    expect(child.name).toBe("NewName");
  });

  it("a late upsert does not resurrect a tombstoned child", async () => {
    const subject = { parentId: "h_par_tomb", childId: "h_chi_tomb", childName: "An" };
    await consumeBatch(env.NOTI_D1, [
      {
        specVersion: "1.0",
        eventId: "h_tomb:deleted",
        type: "identity.child.deleted",
        occurredAt: "2026-08-05T10:00:00Z",
        producer: "robo-worker",
        subject,
        data: {},
      },
    ]);
    await consumeBatch(env.NOTI_D1, [
      upserted({ eventId: "h_tomb:late-upsert", occurredAt: "2026-08-06T10:00:00Z", subject }),
    ]);
    const db = getDb(env.NOTI_D1);
    const child = await db
      .selectFrom("children")
      .selectAll()
      .where("child_id", "=", "h_chi_tomb")
      .executeTakeFirstOrThrow();
    expect(child.deleted_at).not.toBeNull();
  });

  it("deletion cancels pending notifications but leaves the parent's tokens intact", async () => {
    const db = getDb(env.NOTI_D1);
    const subject = { parentId: "h_par_cancel", childId: "h_chi_cancel", childName: "An" };
    await consumeBatch(env.NOTI_D1, [upserted({ eventId: "h_cancel:setup", subject })]);

    // Seed a token for the parent and a scheduled notification for the child.
    await db
      .insertInto("push_tokens")
      .values({
        token: "h_cancel_token",
        device_id: "h_cancel_device",
        parent_id: "h_par_cancel",
        platform: "android",
        last_seen_at: "2026-08-06T10:00:00Z",
        disabled_at: null,
      })
      .execute();
    await db
      .insertInto("notifications")
      .values({
        id: "h_cancel_noti",
        parent_id: "h_par_cancel",
        child_id: "h_chi_cancel",
        kind: "progress",
        title: "t",
        body: "b",
        data_json: "{}",
        scheduled_for: "2026-08-06T10:00:00Z",
        enqueued_at: null,
        state: "scheduled",
        dedupe_key: "h_cancel_dedupe",
      })
      .execute();

    await consumeBatch(env.NOTI_D1, [
      {
        specVersion: "1.0",
        eventId: "h_cancel:deleted",
        type: "identity.child.deleted",
        occurredAt: "2026-08-07T10:00:00Z",
        producer: "robo-worker",
        subject,
        data: {},
      },
    ]);

    const noti = await db
      .selectFrom("notifications")
      .selectAll()
      .where("id", "=", "h_cancel_noti")
      .executeTakeFirstOrThrow();
    expect(noti.state).toBe("canceled");

    // Tokens are parent-scoped and serve the parent's OTHER children
    // (design.md §4.8 rule 4) — deletion must not touch them.
    const token = await db
      .selectFrom("push_tokens")
      .selectAll()
      .where("token", "=", "h_cancel_token")
      .executeTakeFirstOrThrow();
    expect(token.disabled_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```sh
pnpm test tests/consumer-handler.test.ts
```

Expected: FAIL — `../src/consumer/handler` does not exist.

- [ ] **Step 3: Write `src/consumer/handler.ts`**

```ts
// src/consumer/handler.ts
//
// The queue consumer's entire effect for a delivery batch is ONE d1.batch()
// (design.md §4.4). Raw prepared statements, not Kysely: the vendored dialect
// throws on transactions (src/datastore/d1/kysely-d1.ts) and batch() is the
// only atomic primitive D1 offers. One batch per delivery batch, never one
// per message — D1 executes sequentially and up to 250 consumer invocations
// share one database, so per-message round trips are the exact contention
// pattern it handles worst.

import { parseEnvelope } from "./parse";
import { planBatch } from "./plan";

export async function consumeBatch(d1: D1Database, payloads: unknown[]): Promise<void> {
  const results = payloads.map(parseEnvelope);
  const planned = planBatch(results, new Date().toISOString());

  for (const result of results) {
    if (result.kind === "ok") continue;
    // Logs are the fallback until NOTI_METRICS lands (design.md §4.1). Each
    // non-ok kind gets its OWN line prefix: a premature 2.0 producer rollout
    // announcing itself must be distinguishable from a genuinely broken
    // payload, which is exactly what §4.4 asks these counters to separate.
    console.log(`[consumer] ${result.kind} eventId=${result.eventId ?? "<unidentifiable>"}`);
  }

  if (planned.length === 0) return;

  const statements = planned.map((s) => d1.prepare(s.sql).bind(...s.params));
  await d1.batch(statements);
}

export async function handleQueueBatch(d1: D1Database, batch: MessageBatch<unknown>): Promise<void> {
  await consumeBatch(
    d1,
    batch.messages.map((m) => m.body),
  );
  // Explicit ack of the whole batch: every effect above is idempotent, so a
  // redelivery is harmless — but acking means we don't pay for one.
  batch.ackAll();
}
```

- [ ] **Step 4: Export `queue` from `src/index.ts`**

Replace the export block in `src/index.ts` with:

```ts
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Route by queue name. NOTI_QUEUE and NOTI_WEEKLY_QUEUE take the same
    // path here — the weekly queue exists for retry/DLQ isolation
    // (design.md §5.3), not because its events need different handling at
    // the inbox stage. The send queue is Part 3 of this plan series.
    await handleQueueBatch(env.NOTI_D1, batch);
  },
} satisfies ExportedHandler<Env>;
```

Add the import at the top, after the existing `import { app } from "./fetch";`:

```ts
import { handleQueueBatch } from "./consumer/handler";
```

- [ ] **Step 5: Run the tests — expect pass**

```sh
pnpm test tests/consumer-handler.test.ts
```

Expected: PASS, all 8 tests.

- [ ] **Step 6: Run the full suite and type-check**

```sh
pnpm test
pnpm type-check
pnpm lint
```

Expected: all green — 71 existing + 24 new (6 parse + 10 plan + 8 handler) = 95. Recount against actual output
rather than trusting this arithmetic; a mismatch is something to investigate, not to paper over.

- [ ] **Step 7: Commit**

```sh
git add src/consumer/handler.ts src/index.ts tests/consumer-handler.test.ts
git commit -m "feat(consumer): queue() handler with single-batch idempotent effects (design.md §4.4, §4.8)"
```

---

## Final check for this plan

```sh
cd /home/ducmai/work/tuni-noti
pnpm type-check
pnpm test
pnpm lint
git log --oneline -3
```

Expected: clean type-check, all tests green, no lint errors, 3 new commits.

**What this unblocks:** Part 2 (coalescing + flush cron, §4.5) plugs its `coalesce_events` INSERT into
`planBatch`'s learning-event branch — one function, one new statement, with the inbox dedupe already proven
correct underneath it.

**What this does NOT do yet:**
- No `coalesce_events` rows, no `notifications` rows, no pushes. Learning events are recorded and inert.
- No `NOTI_METRICS` binding — the ignored/malformed counters are `console.log` for now (design.md §4.1 wants
  Analytics Engine; that binding doesn't exist yet and adding it is its own small task).
- No `inbox` retention sweep (§5.2 wants 30-day pruning on the hourly cron). The cron doesn't exist until
  Part 2; the sweep rides it.
