import { dayKey } from "../../../src/report.js";
import type { SpendRange, SpendZone } from "./contract.js";

export const RANGE_DAYS: Record<SpendRange, number> = { today: 1, "7d": 7, "30d": 30 };

/** `count` calendar days in `zone`, oldest first, the last one `offset` days before the day of `now`. */
export function localDays(now: number, count: number, offset = 0, zone: SpendZone = "local"): string[] {
  const d = new Date(now);
  // Noon, so a daylight-saving shift can never move the date.
  return Array.from({ length: count }, (_, i) => {
    const back = offset + (count - 1 - i);
    return zone === "utc"
      ? dayKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, 12), "UTC")
      : dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 12).getTime());
  });
}

/** Noon on a YYYY-MM-DD day in `zone`. */
export function dayDate(day: string, zone: SpendZone = "local"): Date {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return zone === "utc" ? new Date(Date.UTC(y, m - 1, d, 12)) : new Date(y, m - 1, d, 12);
}

export function dayBounds(day: string, zone: SpendZone): { start: number; end: number } {
  const start = dayDate(day, zone);
  const end = new Date(start);
  return zone === "utc"
    ? { start: start.setUTCHours(0, 0, 0, 0), end: end.setUTCHours(24, 0, 0, 0) }
    : { start: start.setHours(0, 0, 0, 0), end: end.setHours(24, 0, 0, 0) };
}
