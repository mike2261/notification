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
    // option; the metric (handler.ts) is what makes it visible.
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
