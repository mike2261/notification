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
        parseEnvelope(
          upserted({
            eventId: "chi_2:upserted",
            subject: { parentId: "par_1", childId: "chi_2", childName: "Bình" },
          }),
        ),
      ],
      RECEIVED_AT,
    );
    // Two events → two inbox rows. The count is what proves we're not
    // silently collapsing distinct events.
    expect(stmts.filter((s) => s.sql.includes("INTO inbox"))).toHaveLength(2);
  });
});
