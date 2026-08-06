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
// membership, one for render context, one batch of two or three statements.

import { uuidV7 } from "../utils/uuid";
import { applyCapOutcome, decideGates, type ParentPrefs } from "./gates";
import { localDate } from "./localtime";
import { type RenderContext, type RenderedNotification, renderWindow, type WindowMember } from "./render";

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
 * is, UNMEASURED under production load. Revisit with a realistic population
 * and a real CPU measurement before trusting it.
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

// One query for the whole page's render context. LEFT JOIN because the mirror
// may have no row yet (§4.8 rule 1 — the envelope name is the fallback, and
// an event is never unrenderable).
// preferences is LEFT JOINed too — a parent who has never opened the app has
// no row, and gates.ts falls back to permissive schema defaults.
const RENDER_CONTEXT_SQL = `
SELECT c.child_id, c.name AS child_name, c.deleted_at,
       p.parent_id, p.timezone, p.locale,
       pr.quiet_start, pr.quiet_end, pr.daily_cap,
       pr.progress_enabled, pr.weekly_enabled
  FROM parents p
  LEFT JOIN children c ON c.parent_id = p.parent_id
  LEFT JOIN preferences pr ON pr.parent_id = p.parent_id
 WHERE p.parent_id IN (SELECT value FROM json_each(?1))`;

/**
 * The whole page's cap reservation in ONE statement (design.md §4.5 step 3).
 *
 * `RETURNING parent_id` names exactly the parents that won their slots; every
 * other parent in the page is refused WHOLE — `want` is that parent's entire
 * notification count for the page, so a partial fill would make *which child
 * gets through* depend on scan order.
 *
 * The comparison is against `caps.daily_cap`, SNAPSHOTTED on the day's first
 * write, not the live preferences row: one bound parameter cannot express a
 * page's worth of different limits, and snapshotting also gives the right
 * behaviour when a parent edits their cap mid-day (the new limit applies from
 * tomorrow rather than retroactively re-judging what was already sent).
 */
const RESERVE_CAPS_SQL = `
INSERT INTO caps (parent_id, local_date, daily_cap, sent_count)
SELECT json_extract(value,'$.parent_id'), json_extract(value,'$.local_date'),
       json_extract(value,'$.cap'),       json_extract(value,'$.want')
  FROM json_each(?1)
 -- the first write of the day still has to respect the cap
 WHERE json_extract(value,'$.want') <= json_extract(value,'$.cap')
ON CONFLICT (parent_id, local_date) DO UPDATE
   SET sent_count = caps.sent_count + excluded.sent_count
 WHERE caps.sent_count + excluded.sent_count <= caps.daily_cap
RETURNING parent_id`;

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
       json_extract(value, '$.state'),
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

// Tombstoned windows get their OWN unguarded delete. Routing them through the
// guarded one above would never match (there is no notification to guard
// against), so the membership would stay and be re-scanned every tick
// forever — §4.5 step 1's hard cap guarantees it stays permanently due.
const DELETE_TOMBSTONED_SQL = `
DELETE FROM coalesce_events WHERE event_id IN (SELECT value FROM json_each(?1))`;

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
  quiet_start: string | null;
  quiet_end: string | null;
  daily_cap: number | null;
  progress_enabled: number | null;
  weekly_enabled: number | null;
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
  const tombstonedEventIds: string[] = [];

  for (const members of windows.values()) {
    const first = members[0];
    const childRow = contextByChild.get(first.childId);
    const parentRow = contextByParent.get(first.parentId);

    // A child tombstoned between staging and flush. Deletion already cancels
    // pending rows in its own batch (§4.8 rule 4), but a window staged
    // microseconds earlier can still be sitting here.
    if (childRow?.deleted_at) {
      for (const m of members) tombstonedEventIds.push(m.eventId);
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
      deletePairs.push({ event_id: m.eventId, notification_id: notification.id });
    }
  }

  // (4) Preference gates (§4.5 step 3), then the whole page's cap reservation
  // in ONE statement. The cap runs BEFORE the notification insert so the
  // outcome is known when the rows are written — that is what lets the INSERT
  // share a batch with the DELETE instead of needing a read-decide-write
  // round trip per window.
  const prefsByParent = new Map<string, ParentPrefs>();
  for (const [parentId, row] of contextByParent) {
    prefsByParent.set(parentId, {
      timezone: row.timezone,
      quietStart: row.quiet_start,
      quietEnd: row.quiet_end,
      dailyCap: row.daily_cap ?? 10,
      progressEnabled: row.progress_enabled !== 0,
      weeklyEnabled: row.weekly_enabled !== 0,
    });
  }

  const { decisions, capRequests } = decideGates(rendered, prefsByParent, now);

  let winners: Set<string> = new Set();
  if (capRequests.length > 0) {
    const { results } = await d1
      .prepare(RESERVE_CAPS_SQL)
      .bind(JSON.stringify(capRequests))
      .all<{ parent_id: string }>();
    winners = new Set(results.map((r) => r.parent_id));
  }
  const finalDecisions = applyCapOutcome(decisions, winners);

  // (5) One batch for the whole page — a constant number of statements, not
  // two per window.
  const notificationDocs = finalDecisions.map(({ notification: n, state, scheduledFor }) => ({
    id: n.id,
    parent_id: n.parentId,
    child_id: n.childId,
    kind: n.kind,
    title: n.title,
    body: n.body,
    data_json: n.dataJson,
    scheduled_for: scheduledFor,
    state,
    dedupe_key: n.dedupeKey,
  }));

  const statements = [
    d1.prepare(INSERT_NOTIFICATIONS_SQL).bind(JSON.stringify(notificationDocs)),
    d1.prepare(DELETE_MEMBERSHIP_SQL).bind(JSON.stringify(deletePairs)),
  ];
  if (tombstonedEventIds.length > 0) {
    statements.push(d1.prepare(DELETE_TOMBSTONED_SQL).bind(JSON.stringify(tombstonedEventIds)));
  }
  await d1.batch(statements);

  return rendered.length;
}

// --- quiet-end catch-up (design.md §4.5 step 3) -------------------------

const DUE_DEFERRED_SQL = `
SELECT n.id, n.parent_id, n.child_id, n.title, n.body, n.scheduled_for, p.timezone
  FROM notifications n
  LEFT JOIN parents p ON p.parent_id = n.parent_id
 WHERE n.state = 'deferred_quiet' AND n.scheduled_for <= ?1
 ORDER BY n.parent_id, n.scheduled_for
 LIMIT ?2`;

const INSERT_CATCHUP_SQL = INSERT_NOTIFICATIONS_SQL;

// The folded rows flip to `canceled` in the SAME batch as the catch-up
// insert, so they cannot also send individually (design.md §4.5 step 3).
const CANCEL_FOLDED_SQL = `
UPDATE notifications SET state = 'canceled'
 WHERE id IN (SELECT value FROM json_each(?1))
   AND state = 'deferred_quiet'`;

type DeferredRow = {
  id: string;
  parent_id: string;
  child_id: string | null;
  title: string;
  body: string;
  scheduled_for: string;
  timezone: string | null;
};

/**
 * Folds each parent's due `deferred_quiet` rows into ONE catch-up push
 * (design.md §4.5 step 3). Without this, a parent whose quiet hours held back
 * six notifications gets six pushes the moment the window ends — precisely
 * the fatigue quiet hours exist to prevent.
 *
 * `dedupe_key = '{parentId}:catchup:{local_date}'` makes overlapping ticks
 * safe the same way the main flush's key does: the loser's INSERT no-ops, and
 * because the cancel is keyed on the folded ids rather than on the catch-up
 * row existing, the fold is idempotent either way.
 */
export async function flushQuietEndCatchup(d1: D1Database, now: Date = new Date()): Promise<number> {
  const { results: due } = await d1.prepare(DUE_DEFERRED_SQL).bind(now.toISOString(), PAGE_SIZE).all<DeferredRow>();

  if (due.length === 0) return 0;

  const byParent = new Map<string, DeferredRow[]>();
  for (const row of due) {
    const existing = byParent.get(row.parent_id);
    if (existing) existing.push(row);
    else byParent.set(row.parent_id, [row]);
  }

  const catchupDocs: Array<Record<string, unknown>> = [];
  const foldedIds: string[] = [];

  for (const [parentId, rows] of byParent) {
    const timezone = rows[0].timezone ?? "Asia/Ho_Chi_Minh";
    const local_date = localDate(now, timezone);
    const count = rows.length;

    catchupDocs.push({
      id: uuidV7(),
      parent_id: parentId,
      // A catch-up spans whatever children were deferred, so it belongs to
      // the parent, not to one child.
      child_id: null,
      kind: "catchup",
      title: "Cập nhật từ Tuni",
      body: count === 1 ? rows[0].body : `Bé có ${count} cập nhật mới trong lúc bạn đang bật giờ yên tĩnh.`,
      data_json: JSON.stringify({ foldedCount: count, foldedIds: rows.map((r) => r.id) }),
      scheduled_for: now.toISOString(),
      state: "scheduled",
      dedupe_key: `${parentId}:catchup:${local_date}`,
    });
    for (const row of rows) foldedIds.push(row.id);
  }

  await d1.batch([
    d1.prepare(INSERT_CATCHUP_SQL).bind(JSON.stringify(catchupDocs)),
    d1.prepare(CANCEL_FOLDED_SQL).bind(JSON.stringify(foldedIds)),
  ]);

  return catchupDocs.length;
}
