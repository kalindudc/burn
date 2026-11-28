import { CALL_TIME_EDGES_MS, dayKey, HOUR_MS, type HourRow } from "../../../src/report.js";
import type { SpendMetric, SpendOutput, SpendZone } from "./contract.js";

export interface Usage {
  cost: number;
  tokens: number;
  calls: number;
}

export const emptyUsage = (): Usage => ({ cost: 0, tokens: 0, calls: 0 });

export function addUsage(into: Usage, more: Usage): void {
  into.cost += more.cost;
  into.tokens += more.tokens;
  into.calls += more.calls;
}

// An assumption for an estimate: the open last bucket is read as if no call ran past twice its lower edge.
const LOWER = [0, ...CALL_TIME_EDGES_MS];
const UPPER = [...CALL_TIME_EDGES_MS, 2 * (CALL_TIME_EDGES_MS.at(-1) as number)];

/**
 * The q-th quantile of the call times in `buckets`, in ms, or null with no timed
 * calls. Inside its bucket it interpolates linearly below one second and
 * geometrically above, as the buckets double.
 */
export function callTimeQuantile(buckets: readonly number[], q: number): number | null {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const target = q * total;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    const n = buckets[i] ?? 0;
    if (n > 0 && seen + n >= target) {
      const f = (target - seen) / n;
      const lo = LOWER[i] as number;
      const hi = UPPER[i] as number;
      return i === 0 ? hi * f : lo * (hi / lo) ** f;
    }
    seen += n;
  }
  return UPPER.at(-1) as number;
}

/**
 * One row of 24 hourly values for each of `days`, in `metric`. Each UTC hour
 * lands on its day and hour in `zone`; hours that share a cell are summed, as on
 * the night the clocks go back, and hours outside `days` are left out.
 */
export function activityGrid(
  hours: readonly HourRow[],
  days: readonly string[],
  zone: SpendZone,
  metric: SpendMetric,
): { day: string; hours: number[] }[] {
  const rows = new Map(days.map((day) => [day, new Array<number>(24).fill(0)]));
  for (const h of hours) {
    const ms = h.hour * HOUR_MS;
    const at = new Date(ms);
    const row = rows.get(zone === "utc" ? dayKey(ms, "UTC") : dayKey(ms));
    if (!row) continue;
    const col = zone === "utc" ? at.getUTCHours() : at.getHours();
    row[col] = (row[col] ?? 0) + h[metric];
  }
  return days.map((day) => ({ day, hours: rows.get(day) ?? new Array<number>(24).fill(0) }));
}

export function hourlyCosts(
  hours: readonly HourRow[],
  start: number,
  midnight: number,
  now: number,
): Pick<NonNullable<SpendOutput["hourlyCost"]>, "hours" | "omittedBoundaryCost"> {
  const cutoff = Math.min(midnight, now);
  const sums = new Map<number, number>();
  let omittedBoundaryCost = false;
  for (const { hour, cost } of hours) {
    const at = hour * HOUR_MS;
    if (cost === 0 || at >= cutoff || at + HOUR_MS <= start) continue;
    if (at < start || at + HOUR_MS > midnight) {
      omittedBoundaryCost = true;
      continue;
    }
    sums.set(at, (sums.get(at) ?? 0) + cost);
  }
  return { hours: [...sums].sort(([a], [b]) => a - b).map(([at, cost]) => ({ at, cost })), omittedBoundaryCost };
}
