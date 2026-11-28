import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { formatBudget } from "../../src/format.js";
import { isChartTime, type SpendPoint, spendTimeLabel, timeTicks, timeX } from "./spend-axis.js";

export interface CumulativeSpendChartProps {
  /** Ordered cumulative USD points; repeat a timestamp to draw a step. */
  points: readonly SpendPoint[];
  from: number;
  to: number;
  estimated: boolean;
  ariaLabel: string;
  budgetUsd?: number;
  turnMarkers?: readonly number[];
  /** IANA zone for the time labels; omitted means the viewer's local zone. */
  timeZone?: string;
  showOpening?: boolean;
}

const HEIGHT = 116;
const TOP = 15;
const BASELINE = HEIGHT - 6;

function axisTop(peak: number): number {
  const target = Math.max(0.02, peak * 1.05);
  if (!Number.isFinite(target)) return peak;
  const unit = 10 ** Math.floor(Math.log10(target));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => n * unit >= target) ?? 10;
  return Number.isFinite(step * unit) ? step * unit : target;
}

export function CumulativeSpendChart({
  points, from, to, estimated, ariaLabel, budgetUsd, turnMarkers = [], timeZone, showOpening = false,
}: CumulativeSpendChartProps): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const [measuredWidth, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = () => setWidth(el.clientWidth || null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!isChartTime(from) || !isChartTime(to) || from > to) return null;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.some((p, i) =>
    !isChartTime(p.at) || p.at < from || p.at > to || !Number.isFinite(p.total) || p.total < 0 ||
    (i > 0 && (p.at < points[i - 1]!.at || p.total < points[i - 1]!.total))
  )) return null;
  const width = measuredWidth ?? 320;
  const budget = budgetUsd !== undefined && Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : null;
  const top = axisTop(Math.max(last.total, budget ?? 0));
  const x = (at: number) => timeX(at, from, to, width);
  const y = (usd: number) => BASELINE - (usd / top) * (BASELINE - TOP);
  const coords = points.map((p) => `${x(p.at).toFixed(2)},${y(p.total).toFixed(2)}`);
  const ticks = timeTicks(from, to, width, timeZone);
  const line = coords.join(" ");
  const area = `M${x(first.at)},${BASELINE} L${coords.join(" L")} L${x(last.at)},${BASELINE} Z`;
  return (
    <div ref={box} className="min-w-0">
      <svg width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" className="block" role="img" aria-label={ariaLabel}>
        {[0, top / 2, top].map((v) => (
          <g key={v}>
            <line x1={0} x2={width} y1={y(v)} y2={y(v)} className="stroke-border" />
            {v > 0 ? <text x={2} y={y(v) - 3} fontSize={10.5} className="fill-muted-foreground tabular-nums">{formatBudget(v)}</text> : null}
          </g>
        ))}
        {ticks.map((tick) => (
          <line key={tick.at} x1={x(tick.at)} x2={x(tick.at)} y1={TOP} y2={BASELINE} className="stroke-border" strokeDasharray={tick.day ? undefined : "2 3"} />
        ))}
        <path d={area} style={{ fill: "color-mix(in oklab, var(--pr-merged) 13%, transparent)" }} />
        {budget !== null ? (
          <g>
            <line x1={0} x2={width} y1={y(budget)} y2={y(budget)} className="stroke-warning" strokeDasharray="5 4" strokeWidth={1.25} />
            <text x={width - 2} y={y(budget) - 3} textAnchor="end" fontSize={10.5} className="fill-warning-text tabular-nums">Budget {formatBudget(budget)}</text>
          </g>
        ) : null}
        <polyline points={line} fill="none" className="stroke-pr-merged" strokeWidth={1.75} strokeLinejoin="round" strokeDasharray={estimated ? "4 3" : undefined} />
        {showOpening ? <circle cx={x(first.at)} cy={y(first.total)} r={2.5} className="fill-background stroke-pr-merged" strokeWidth={1.5} /> : null}
        {[...new Set(turnMarkers)].filter((at) => at >= from && at <= to).map((at) => (
          <line key={at} x1={x(at)} x2={x(at)} y1={BASELINE - 4} y2={BASELINE} className="stroke-muted-foreground" strokeWidth={1.25} />
        ))}
        <circle cx={x(last.at)} cy={y(last.total)} r={3.5} className="fill-pr-merged stroke-background" strokeWidth={2} />
      </svg>
      <div aria-hidden="true" className="relative mt-0.5 h-4 overflow-hidden text-[10.5px] whitespace-nowrap text-muted-foreground tabular-nums">
        <span className="absolute left-0">{spendTimeLabel(from, timeZone)}</span>
        {ticks.map((tick) => (
          <span key={tick.at} className={tick.day ? "absolute font-semibold text-foreground" : "absolute"} style={{ left: `${(x(tick.at) / width) * 100}%`, transform: "translateX(-50%)" }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}
