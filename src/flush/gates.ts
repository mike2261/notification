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
