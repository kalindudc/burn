import { HOUR_MS, HOURS_MAX, type UsageReport } from "../../src/report.js";
import { isChartTime, type SpendPoint } from "./spend-axis.js";

interface SpendHistory {
  points: SpendPoint[];
  from: number;
  to: number;
  plotted: number;
  carried: number;
  unplotted: number;
  hasHourly: boolean;
}

interface Hour {
  cost?: number;
  calls: UsageReport["series"];
}

const validCost = (cost: number): boolean => Number.isFinite(cost) && cost >= 0;
const roundoff = (cost: number, rows: number): number => (8 * Number.EPSILON * rows) * cost;

export function buildSpendHistory(report: UsageReport): SpendHistory | null {
  const total = report.cost.total;
  if (!validCost(total) || total === 0) return null;

  const hours = new Map<number, Hour>();
  let unknownTiming = false;
  for (const row of report.hours) {
    const start = row.hour * HOUR_MS;
    if (!validCost(row.cost)) return null;
    if (!Number.isInteger(row.hour) || !isChartTime(start) || !isChartTime(start + HOUR_MS)) {
      unknownTiming = true;
      continue;
    }
    if (hours.has(row.hour)) return null;
    hours.set(row.hour, { cost: row.cost, calls: [] });
  }
  const retainedHours = hours.size;
  const oldestHour = Math.min(...hours.keys()) * HOUR_MS;
  for (const call of report.series) {
    if (!validCost(call.cost)) return null;
    if (!isChartTime(call.at)) {
      unknownTiming = true;
      continue;
    }
    if (call.cost === 0) continue;
    const key = Math.floor(call.at / HOUR_MS);
    const hour = hours.get(key) ?? { calls: [] };
    hour.calls.push(call);
    hours.set(key, hour);
  }

  const started = isChartTime(report.startedAt) ? report.startedAt : null;
  const updated = isChartTime(report.updatedAt) ? report.updatedAt : null;
  const consistentBounds = started !== null && updated !== null && updated >= started;
  const hoursInOrder = [...hours.entries()].sort(([a], [b]) => a - b);
  const events: { at: number; delta: number }[] = [];
  let accounted = 0;
  let hasHourly = false;
  for (const [hour, row] of hoursInOrder) {
    const calls = row.calls.sort((a, b) => a.at - b.at);
    const exact = calls.reduce((sum, call) => sum + call.cost, 0);
    const cost = row.cost ?? exact;
    const difference = cost - exact;
    const noise = roundoff(Math.max(cost, exact), calls.length + 1);
    if (!Number.isFinite(exact) || difference < -noise) return null;
    accounted += Math.max(cost, exact);
    const start = hour * HOUR_MS;
    const end = start + HOUR_MS;
    let residual = difference > noise ? difference : 0;
    const left = consistentBounds && started > start && started < end ? Math.min(started, calls[0]?.at ?? started) : start;
    const right = consistentBounds && updated >= left && updated < end ? Math.max(updated, calls.at(-1)?.at ?? updated) : end;
    hasHourly ||= residual > 0;
    if (residual > 0) events.push({ at: left, delta: 0 });
    let last = left;
    for (const call of calls) {
      if (residual > 0 && call.at > last) {
        const part = residual * ((call.at - last) / (right - last));
        events.push({ at: call.at, delta: part });
        residual -= part;
      } else {
        events.push({ at: call.at, delta: 0 });
      }
      events.push({ at: call.at, delta: call.cost });
      last = call.at;
    }
    if (residual > 0) events.push({ at: right, delta: residual });
  }
  if (events.length === 0 || !Number.isFinite(accounted)) return null;
  const noise = roundoff(Math.max(total, accounted), hours.size + report.series.length + 1);
  if (accounted - total > noise) return null;
  const missing = total - accounted > noise ? total - accounted : 0;

  // Only full hourly retention proves a gap is older than the chart, and not if an exact call predates the first retained hour.
  const truncated = !unknownTiming && retainedHours === HOURS_MAX && started !== null && started < oldestHour;
  const first = events[0]!.at;
  const carried = truncated && first >= oldestHour ? missing : 0;
  const unplotted = missing - carried;
  const plotted = total - unplotted;
  const from = carried > 0 ? oldestHour : Math.min(first, started ?? first);
  const to = Math.max(events.at(-1)!.at, updated ?? 0);

  let running = carried;
  const points: SpendPoint[] = [{ at: from, total: running }];
  for (const { at, delta } of events) {
    running = Math.min(plotted, running + delta);
    const previous = points.at(-1)!;
    if (previous.at !== at || previous.total !== running) points.push({ at, total: running });
  }
  // Correct the accumulation's roundoff at the last charged point, not across the trailing idle time.
  points.at(-1)!.total = plotted;
  if (points.at(-1)!.at < to) points.push({ at: to, total: plotted });

  return { points, from, to, plotted, carried, unplotted, hasHourly };
}
