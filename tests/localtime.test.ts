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
