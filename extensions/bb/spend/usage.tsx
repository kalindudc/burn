import type { ReactNode } from "react";
import { formatAmount, formatCallTime, formatTokenCount, formatUsd, modelName, providerName } from "../../../src/format.js";
import { CALL_TIME_BUCKETS, CALL_TIME_EDGES_MS, callTimeBucket } from "../../../src/report.js";
import { KIND_COLOURS } from "../card.js";
import { StackedBar } from "../charts.js";
import { cn } from "../lib/utils.js";
import type { SpendMetric, SpendOutput, SpendRange } from "./contract.js";
import { dayDate } from "./days.js";
import { PanelLabel } from "./panels.js";
import { isLatest } from "./period.js";

export const RANGES: { range: SpendRange; label: string; column: string; previous: string }[] = [
  { range: "today", label: "Day", column: "Today", previous: "yesterday" },
  { range: "7d", label: "7 days", column: "Last 7 days", previous: "previous 7 days" },
  { range: "30d", label: "30 days", column: "Last 30 days", previous: "previous 30 days" },
];
export const rangeInfo = (range: SpendRange) => RANGES.find((r) => r.range === range) ?? (RANGES[1] as (typeof RANGES)[number]);

type Covered = Pick<SpendOutput, "range" | "days" | "today">;

/** What an answer's figures compare with: "yesterday", "the day before" a past day, or "previous 7 days". */
export const previousOf = (data: Covered): string =>
  data.range === "today" && !isLatest(data) ? "the day before" : rangeInfo(data.range).previous;

/** "no spend in the previous 7 days", or "no use yesterday". */
export const noneText = (what: string, data: Covered): string => {
  const previous = previousOf(data);
  return `${what} ${data.range === "today" ? previous : `in the ${previous}`}`;
};

export const METRIC_WORDS: Record<SpendMetric, string> = { cost: "cost", tokens: "tokens", calls: "calls" };

const count = (n: number): string => Math.round(n).toLocaleString("en-US");

/** A share of a whole: "97%", "3.4%", "<0.1%", or "—" when there is no whole. */
function share(part: number, whole: number): string {
  if (!(whole > 0)) return "—";
  const pct = (part / whole) * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${pct.toFixed(1)}%`;
  return pct > 0 ? "<0.1%" : "0%";
}

export function formatMetric(n: number, metric: SpendMetric, estimated: boolean): string {
  if (metric === "cost") return formatAmount(n, estimated);
  if (metric === "tokens") return formatTokenCount(n);
  return count(n);
}

export function Kpi({ label, value, sub, hint }: { label: string; value: string; sub: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-raised p-3" title={hint}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

/** "▲ 18% vs previous 7 days"; `none` when there was nothing before. */
export function Change({ now, before, than, none }: { now: number; before: number; than: string; none: string }) {
  if (before === 0) return <>{none}</>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <>same as {than}</>;
  return (
    <>
      <span className={pct > 0 ? "text-warning-text" : undefined}>
        {pct > 0 ? "▲" : "▼"} {Math.abs(pct)}%
      </span>{" "}
      vs {than}
    </>
  );
}

const TIMING_HINT = "Only pi, OMP and OpenCode record how long a call took and how it ended.";

export function UsageCards({ data }: { data: SpendOutput }) {
  const { p50, p90, timed, failed } = data.callTime;
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      <Kpi
        label="Tokens"
        value={formatTokenCount(data.tokens)}
        sub={<Change now={data.tokens} before={data.previousTokens} than={previousOf(data)} none={noneText("no use", data)} />}
      />
      <Kpi label="Calls" value={count(data.calls)} sub={`${count(data.prompts)} ${data.prompts === 1 ? "prompt" : "prompts"}`} hint="Model requests, not tool executions. Tool counts appear in each prompt's details." />
      <Kpi
        label="Median call"
        value={p50 === null ? "—" : formatCallTime(p50)}
        sub={p90 === null ? "no timed calls" : `p90 ${formatCallTime(p90)}`}
        hint={TIMING_HINT}
      />
      <Kpi
        label="Failed calls"
        value={timed === 0 ? "—" : count(failed)}
        sub={timed === 0 ? "no timed calls" : `${share(failed, timed)} of timed calls`}
        hint={TIMING_HINT}
      />
    </div>
  );
}

const MIX_KINDS = [
  ["input", "Input"],
  ["cacheWrite", "Cache write"],
  ["cacheRead", "Cache read"],
  ["output", "Output"],
] as const;

export function TokenMix({ data, hide }: { data: SpendOutput; hide?: ReactNode }) {
  const { tokens, costs } = data.mix;
  const allTokens = MIX_KINDS.reduce((sum, [k]) => sum + tokens[k], 0);
  const allCost = MIX_KINDS.reduce((sum, [k]) => sum + costs[k], 0);
  const bar = (values: Record<(typeof MIX_KINDS)[number][0], number>) =>
    MIX_KINDS.map(([k]) => ({ key: k, value: values[k], className: KIND_COLOURS[k] }));
  return (
    <section aria-label="Token mix">
      <PanelLabel aside={<span className="text-xs text-muted-foreground normal-case">tokens against cost</span>} hide={hide}>
        Token mix
      </PanelLabel>
      <div className="grid grid-cols-[3.5rem_1fr] items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
        <span>Tokens</span>
        <StackedBar parts={bar(tokens)} className="h-2.5" />
        <span>Cost</span>
        <StackedBar parts={bar(costs)} className="h-2.5" />
      </div>
      <table className="mt-2 w-full text-xs tabular-nums">
        <thead>
          <tr className="text-[10.5px] text-muted-foreground">
            <th scope="col" className="text-left font-medium">
              <span className="sr-only">Kind</span>
            </th>
            <th scope="col" className="text-right font-medium">
              Tokens
            </th>
            <th scope="col" className="w-10 text-right font-medium">
              <span className="sr-only">Share of tokens</span>
            </th>
            <th scope="col" className="text-right font-medium">
              Cost
            </th>
            <th scope="col" className="w-10 text-right font-medium">
              <span className="sr-only">Share of cost</span>
            </th>
            <th scope="col" className="text-right font-medium">
              per 1M
            </th>
          </tr>
        </thead>
        <tbody>
          {MIX_KINDS.map(([k, label]) => (
            <tr key={k}>
              <td className="py-0.5">
                <span className="flex items-center gap-1.5">
                  <i aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", KIND_COLOURS[k])} />
                  {label}
                </span>
              </td>
              <td className="py-0.5 pl-2 text-right">{formatTokenCount(tokens[k])}</td>
              <td className="py-0.5 text-right text-muted-foreground">{share(tokens[k], allTokens)}</td>
              <td className="py-0.5 pl-2 text-right">{formatAmount(costs[k], data.estimated)}</td>
              <td className="py-0.5 text-right text-muted-foreground">{share(costs[k], allCost)}</td>
              <td className="py-0.5 pl-2 text-right text-muted-foreground">{tokens[k] > 0 ? formatUsd(costs[k] / (tokens[k] / 1e6)) : "—"}</td>
            </tr>
          ))}
          <tr className="text-[11px] text-muted-foreground">
            <td className="py-0.5 pl-3.5">↳ reasoning</td>
            <td className="py-0.5 pl-2 text-right">{formatTokenCount(tokens.reasoning)}</td>
            <td className="py-0.5 text-right">{share(tokens.reasoning, tokens.output)}</td>
            <td colSpan={3} />
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/** "<1s", "1–2s" … "32–64s", "1–2m", ">2m". */
const BUCKET_LABELS = (() => {
  const edges = CALL_TIME_EDGES_MS;
  const short = (ms: number): string => (ms < 60_000 ? `${ms / 1000}s` : `${Math.round(ms / 60_000)}m`);
  const between = edges.slice(1).map((hi, i) => {
    const lo = edges[i] as number;
    return lo < 60_000 ? `${lo / 1000}–${hi / 1000}s` : `${Math.round(lo / 60_000)}–${Math.round(hi / 60_000)}m`;
  });
  return [`<${short(edges[0])}`, ...between, `>${short(edges.at(-1) as number)}`];
})();

/** Where `ms` sits along the bars, in percent: its bucket, then how far through it, as callTimeQuantile reads it. */
function markerAt(ms: number): number {
  const i = callTimeBucket(ms);
  const lo = i === 0 ? 0 : (CALL_TIME_EDGES_MS[i - 1] as number);
  const hi = (CALL_TIME_EDGES_MS[i] as number | undefined) ?? 2 * lo;
  const through = i === 0 ? ms / hi : Math.log(ms / lo) / Math.log(hi / lo);
  return ((i + Math.min(1, Math.max(0, through))) / CALL_TIME_BUCKETS) * 100;
}

export function CallTime({ data, hide }: { data: SpendOutput; hide?: ReactNode }) {
  const { buckets, timed, failed, aborted, p50, p90 } = data.callTime;
  const peak = Math.max(0, ...buckets) || 1;
  return (
    <section aria-label="Call time">
      <PanelLabel aside={<span className="text-xs text-muted-foreground normal-case">{count(timed)} timed calls</span>} hide={hide}>
        Call time
      </PanelLabel>
      {timed === 0 ? (
        <div className="text-xs text-muted-foreground">No timed calls in this period.</div>
      ) : (
        <>
          <div className="relative mt-1 flex h-[92px] items-end gap-[3px]" role="list" aria-label="Calls by how long they took">
            {buckets.map((n, i) => (
              <div
                key={BUCKET_LABELS[i]}
                role="listitem"
                aria-label={`${BUCKET_LABELS[i]}: ${count(n)} calls`}
                title={`${BUCKET_LABELS[i]}: ${count(n)} calls`}
                className="min-h-px flex-1 rounded-t-[2px] bg-timeline-accent"
                style={{ height: `${(n / peak) * 100}%` }}
              />
            ))}
            {(
              [
                ["p50", p50],
                ["p90", p90],
              ] as const
            ).map(([name, ms]) =>
              ms === null ? null : (
                <div
                  key={name}
                  aria-hidden
                  className="pointer-events-none absolute -top-0.5 bottom-0 border-l-[1.5px] border-dashed border-foreground opacity-60"
                  style={{ left: `${markerAt(ms)}%` }}
                >
                  <span className="absolute -top-0.5 left-[3px] text-[10px] whitespace-nowrap text-foreground">{name}</span>
                </div>
              ),
            )}
          </div>
          <div aria-hidden className="mt-[3px] flex gap-[3px] text-[9.5px] text-muted-foreground">
            {BUCKET_LABELS.map((label) => (
              <span key={label} className="flex-1 text-center whitespace-nowrap">
                {label}
              </span>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span>
              p50 <b className="font-semibold text-foreground">{p50 === null ? "—" : formatCallTime(p50)}</b>
            </span>
            <span>
              p90 <b className="font-semibold text-foreground">{p90 === null ? "—" : formatCallTime(p90)}</b>
            </span>
            <span>
              failed <b className="font-semibold text-destructive-text">{count(failed)}</b>
            </span>
            <span>
              stopped <b className="font-semibold text-foreground">{count(aborted)}</b>
            </span>
          </div>
        </>
      )}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        pi, OMP and OpenCode threads only: Codex and Claude Code record no call time. Failed means the provider returned an error; stopped means someone or the budget stop
        aborted the call.
      </p>
    </section>
  );
}

const weekday = (day: string): string => dayDate(day).toLocaleDateString("en-US", { weekday: "short" });
const shortDate = (day: string): string => dayDate(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const longDay = (day: string): string => dayDate(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const clock = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

export function Activity({ data, hide }: { data: SpendOutput; hide?: ReactNode }) {
  const { activity, metric } = data;
  const value = (n: number): string => formatMetric(n, metric, data.estimated);
  let top: { day: string; hour: number; v: number } | null = null;
  for (const row of activity) {
    for (let hour = 0; hour < row.hours.length; hour++) {
      const v = row.hours[hour] ?? 0;
      if (v > (top?.v ?? 0)) top = { day: row.day, hour, v };
    }
  }
  const peakText = top === null ? null : `${weekday(top.day)} ${clock(top.hour)}, ${value(top.v)}`;
  const few = activity.length <= 7;
  const rowHeight = activity.length > 10 ? "h-[7px]" : "h-4";
  return (
    <section aria-label="Activity by hour">
      <PanelLabel aside={peakText === null ? undefined : <span className="text-xs text-muted-foreground normal-case">busiest: {peakText}</span>} hide={hide}>
        Activity by hour · {METRIC_WORDS[metric]}
      </PanelLabel>
      <div
        role="img"
        aria-label={peakText === null ? "Activity by hour: none in this period" : `Activity by hour, busiest ${peakText}`}
        className="grid grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-0.5 text-[10px] text-muted-foreground"
      >
        {activity.map((row, i) => (
          <div key={row.day} className="contents">
            <div className={cn("self-center pr-1 text-right leading-none whitespace-nowrap", rowHeight)}>
              {few ? weekday(row.day) : (activity.length - 1 - i) % 5 === 0 ? shortDate(row.day) : ""}
            </div>
            {row.hours.map((v, hour) => (
              <div key={clock(hour)} title={`${longDay(row.day)}, ${clock(hour)} · ${value(v)}`} className={cn("relative rounded-[2px] bg-muted", rowHeight)}>
                {v > 0 && top !== null ? (
                  <i className="absolute inset-0 rounded-[2px] bg-timeline-accent" style={{ opacity: (0.12 + 0.88 * (v / top.v)).toFixed(2) }} />
                ) : null}
              </div>
            ))}
          </div>
        ))}
        <div />
        {Array.from({ length: 24 }, (_, hour) => (
          <div key={clock(hour)} className="text-center">
            {hour % 6 === 0 ? String(hour).padStart(2, "0") : ""}
          </div>
        ))}
      </div>
    </section>
  );
}

const dash = <span className="text-muted-foreground">—</span>;

export function ModelTable({ data, hide }: { data: SpendOutput; hide?: ReactNode }) {
  // pi can reach one model through several providers, such as anthropic and anthropic-1m.
  const names = data.modelStats.map((m) => modelName(m.key));
  const shared = new Set(names.filter((name, i) => names.indexOf(name) !== i));
  return (
    <section aria-label="Models">
      <PanelLabel hide={hide}>Models</PanelLabel>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              {["Model", "Harness", "Calls", "Tokens", "Cost", "Cache hit", "Avg call", "Output/s", "Failed"].map((name, i) => (
                <th key={name} scope="col" className={cn("py-2 font-medium whitespace-nowrap", i === 0 ? "px-3 text-left" : i === 1 ? "px-2 text-left" : "px-2 text-right")}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.modelStats.length === 0 ? (
              <tr className="border-t border-border">
                <td colSpan={9} className="px-3 py-3 text-muted-foreground">
                  No model was used in this period.
                </td>
              </tr>
            ) : null}
            {data.modelStats.map((m) => (
              <tr key={`${m.harness ?? ""}\n${m.key}`} data-testid="spend-model" className="border-t border-border">
                <td className="w-full max-w-0 truncate px-3 py-1.5" title={m.key}>
                  {modelName(m.key)}
                  {shared.has(modelName(m.key)) && providerName(m.key) !== "" ? (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">{providerName(m.key)}</span>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{m.harness ?? dash}</td>
                <td className="px-2 py-1.5 text-right">{count(m.calls)}</td>
                <td className="px-2 py-1.5 text-right">{formatTokenCount(m.tokens)}</td>
                <td className="px-2 py-1.5 text-right">{formatAmount(m.cost, m.estimated)}</td>
                <td className="px-2 py-1.5 text-right">{m.cacheHitPct === null ? dash : share(m.cacheHitPct, 100)}</td>
                <td className="px-2 py-1.5 text-right">{m.avgCallMs === null ? dash : formatCallTime(m.avgCallMs)}</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">{m.outputPerSec === null ? dash : `${Math.round(m.outputPerSec)} tok`}</td>
                <td className="px-2 py-1.5 text-right">{m.failedPct === null ? dash : share(m.failedPct, 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">Cache hit, Avg call, Output/s and Failed cover the whole life of the threads in range.</p>
    </section>
  );
}
