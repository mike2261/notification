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

/**
 * How many lesson ids the body names before it stops listing them.
 *
 * A window is capped at 30 minutes (§4.5 step 1), so three completed lessons
 * is already an unusual sitting — but the cap is not about likelihood. An FCM
 * body is truncated by the platform, and a body that spends its length on a
 * list has none left for the part a parent actually reads.
 */
const MAX_LESSON_IDS = 3;

/**
 * Lesson IDS, not titles: the title lives in the course manifest, which this
 * service does not read and the event does not carry (§2 — the envelope is
 * denormalized on purpose, and adding a title means a contract change plus a
 * manifest read per fold on the producer). `greet-1` is not friendly copy; it
 * is, however, honest about which lesson closed, which is what the parent
 * asked for. Swap it for a title the day the contract carries one.
 */
function lessonIdsFrom(members: WindowMember[]): string[] {
  const ids: string[] = [];
  for (const m of members) {
    if (m.kind !== "learning.lesson.completed") continue;
    const id = m.payload.data.lessonId;
    // Defensive despite the contract: a renderer that throws takes the whole
    // flush page down, and this one runs on every window (§5.1).
    if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function lessonPhrase(count: number, ids: string[]): string {
  const head = `hoàn thành ${count} bài học`;
  if (ids.length === 0) return head;
  const shown = ids.slice(0, MAX_LESSON_IDS).join(", ");
  return ids.length > MAX_LESSON_IDS ? `${head} (${shown}…)` : `${head} (${shown})`;
}

function renderProgress(members: WindowMember[], context: RenderContext): RenderedNotification {
  const name = nameFor(members, context);
  const lessons = members.filter((m) => m.kind === "learning.lesson.completed").length;
  const challenges = members.filter((m) => m.kind === "learning.challenge.achieved").length;
  const stars = members
    .filter((m) => m.kind === "learning.star.awarded")
    .reduce((sum, m) => sum + num(m.payload.data.totalStars), 0);

  const lessonIds = lessonIdsFrom(members);

  const parts: string[] = [];
  if (lessons > 0) parts.push(lessonPhrase(lessons, lessonIds));
  if (challenges > 0) parts.push(`chinh phục ${challenges} thử thách`);
  if (stars > 0) parts.push(`nhận ${stars} sao`);

  return {
    id: uuidV7(),
    parentId: members[0].parentId,
    childId: members[0].childId,
    kind: "progress",
    title: `${name} vừa học xong!`,
    body: parts.length > 0 ? `${name} ${parts.join(", ")}.` : `${name} vừa có một buổi học mới.`,
    dataJson: JSON.stringify({ lessons, challenges, stars, lessonIds, eventIds: members.map((m) => m.eventId) }),
    dedupeKey: dedupeKeyFor(members),
  };
}

function renderWeekly(members: WindowMember[], _context: RenderContext): RenderedNotification {
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
