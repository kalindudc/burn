import { formatClock } from "../../src/format.js";
import { HOUR_MS } from "../../src/report.js";

export interface SpendPoint {
  at: number;
  total: number;
}

const DAY = 24 * HOUR_MS;
const STEPS = [1 / 60, 5 / 60, 0.25, 0.5, 1, 2, 3, 6, 12, 24, 48, 168, 336, 672].map((h) => h * HOUR_MS);
const INSET = 5;

export const isChartTime = (at: number): boolean => at > 0 && at <= 8.64e15;

export const timeFraction = (at: number, from: number, to: number): number =>
  from === to ? 0.5 : Math.max(0, Math.min(1, (at - from) / (to - from)));

export function timeX(at: number, from: number, to: number, width: number): number {
  const inset = Math.min(INSET, width / 2);
  return inset + timeFraction(at, from, to) * (width - 2 * inset);
}

const dayFormat = (timeZone?: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });
const clockFormat = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });

export function spendTimeLabel(at: number, timeZone?: string): string {
  return `${dayFormat(timeZone).format(at)} ${timeZone === undefined ? formatClock(at) : clockFormat(timeZone).format(at)}`;
}

function offsetAt(timeZone?: string): (at: number) => number {
  if (timeZone === undefined) return (at) => -new Date(at).getTimezoneOffset() * 60_000;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" });
  return (at) => {
    const value = formatter.formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
    const match = value?.match(/^GMT([+-])(\d\d):(\d\d)(?::(\d\d))?$/);
    return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * HOUR_MS + Number(match[3]) * 60_000 + Number(match[4] ?? 0) * 1_000) : 0;
  };
}

interface TimeTick { at: number; label: string; day: boolean }

export function timeTicks(from: number, to: number, width: number, timeZone?: string): TimeTick[] {
  if (from >= to) return [];
  const max = Math.min(10, Math.max(2, Math.floor(width / 84)));
  const ideal = (to - from) / max;
  const step = STEPS.find((step) => step >= ideal) ?? Math.ceil(ideal / DAY) * DAY;
  const offset = offsetAt(timeZone);
  const date = dayFormat(timeZone);
  const clock = timeZone === undefined ? formatClock : clockFormat(timeZone).format;
  const startOffset = offset(from);
  const first = Math.floor((from + startOffset) / step) * step;
  const candidates: TimeTick[] = [];
  for (let i = 0; i < max + 2; i++) {
    const wall = first + i * step;
    // Use local wall-time steps for labels, but position them on the real elapsed-time axis.
    const probe = wall - startOffset;
    if (Math.abs(probe) > 8.64e15) continue;
    const at = wall - offset(probe);
    if (at <= from || at >= to || at + offset(at) !== wall) continue;
    const day = wall % DAY === 0;
    candidates.push({ at, label: day ? date.format(at) : clock(at), day });
  }

  const edge = spendTimeLabel(from, timeZone).length * 7 + 10;
  const kept: { tick: TimeTick; left: number; right: number }[] = [];
  for (const tick of [...candidates.filter((t) => t.day), ...candidates.filter((t) => !t.day)]) {
    const center = timeX(tick.at, from, to, width);
    const half = (tick.label.length * 7) / 2;
    const left = center - half;
    const right = center + half;
    if (left >= edge && right <= width && kept.every((k) => right + 10 <= k.left || left >= k.right + 10)) {
      kept.push({ tick, left, right });
    }
  }
  return kept.map((k) => k.tick).sort((a, b) => a.at - b.at);
}
