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
