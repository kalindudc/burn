import {
  type PluginNavPanelProps,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { budgetState } from "../../../src/budget.js";
import { formatAmount, formatBudget, formatTokenCount, formatUsd, modelName } from "../../../src/format.js";
import { HOUR_MS } from "../../../src/report.js";
import { CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "../icon.js";
import { cn } from "../lib/utils.js";
import { readPrefs } from "../prefs.js";
import { spendTimeLabel } from "../spend-axis.js";
import { CumulativeSpendChart } from "../spend-chart.js";
import type { SpendMetric, SpendOutput, SpendPanel, SpendRange, SpendZone, spendMethods } from "./contract.js";
import { dayDate, RANGE_DAYS } from "./days.js";
import { FIRST_DAY, isDay, isLatest, type Period, parsePeriod, periodEnding, periodLabel, periodPath, stepPeriod } from "./period.js";
import { HideButton, PANELS, PanelLabel, type Panels, usePanels, ViewMenu } from "./panels.js";
import { Activity, CallTime, Change, formatMetric, Kpi, METRIC_WORDS, ModelTable, noneText, previousOf, RANGES, rangeInfo, TokenMix, UsageCards } from "./usage.js";
import { loadView, type Prices, type SavedView, saveView } from "./view.js";

/** A usage signal arrives per report from every running thread, so refetches wait for a quiet moment. */
export const REFETCH_DEBOUNCE_MS = 1000;
/** How long a refresh runs before the page says it is reading, so the warm answer a signal earns never flashes. */
export const READING_DELAY_MS = 600;
/** How long the line stays once it is up, so a refresh landing just after the delay does not blink. */
export const READING_HOLD_MS = 500;

const METRICS: { metric: SpendMetric; label: string }[] = [
  { metric: "cost", label: "Cost" },
  { metric: "tokens", label: "Tokens" },
  { metric: "calls", label: "Calls" },
];

const ZONES: { zone: SpendZone; label: string }[] = [
  { zone: "local", label: "Local" },
  { zone: "utc", label: "UTC" },
];
const zoneSuffix = (zone: SpendZone): string => (zone === "utc" ? " (UTC)" : "");

/** bb's categorical chart series, each falling back to a host token where a theme does not define it. */
const CHART = [
  "var(--chart-1, var(--timeline-accent))",
  "var(--chart-2, var(--success))",
  "var(--chart-3, var(--warning))",
  "var(--chart-4, var(--ansi-5))",
  "var(--chart-5, var(--ansi-6))",
  "var(--chart-6, var(--destructive))",
];
const chartColor = (i: number): CSSProperties => ({ color: CHART[i % CHART.length] });
const PROJECT_COLOR = chartColor(4);
const HARNESS_COLOR = chartColor(3);
const RUNNING_COLOR: CSSProperties = { color: "var(--chart-1, var(--timeline-accent))" };

const EMPTY_TEXT = "No thread has spent anything yet. Burn counts a thread from its first model call.";

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface SpendState {
  data: SpendOutput | null;
  error: string | null;
  loading: boolean;
}

/** Spend for the range, project and days, refetched (debounced) on every usage signal and after a reconnect. */
function useSpend(
  range: SpendRange,
  end: string | null,
  projectId: string | null,
  tz: SpendZone,
  metric: SpendMetric,
  listPrice: boolean,
): SpendState & { retry: () => void } {
  const rpc = useRpc<typeof spendMethods>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<SpendState>({ data: null, error: null, loading: true });
  const latest = useRef(0);
  const lastConnection = useRef(connection);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(() => {
    const asked = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    rpc.call("spend", { range, projectId, tz, metric, ...(listPrice ? { listPrice: true } : {}), ...(end !== null ? { end } : {}) }).then(
      (data) => {
        if (asked === latest.current) setState({ data, error: null, loading: false });
      },
      (cause: unknown) => {
        if (asked === latest.current) setState((s) => ({ ...s, error: errorText(cause), loading: false }));
      },
    );
  }, [rpc, range, end, projectId, tz, metric, listPrice]);
  // A debounced refetch fires after the choice it was scheduled under may have changed, so it reads the current one.
  const current = useRef(refetch);
  useLayoutEffect(() => {
    current.current = refetch;
  }, [refetch]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useRealtime(
    "usage",
    useCallback(() => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        current.current();
      }, REFETCH_DEBOUNCE_MS);
    }, []),
  );
  useEffect(() => {
    if (connection === "connected" && lastConnection.current !== "connected") refetch();
    lastConnection.current = connection;
  }, [connection, refetch]);

  return { ...state, retry: refetch };
}

function Segments<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md bg-surface-recessed p-0.5 text-xs">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => onChange(item.value)}
          className={cn(
            "rounded-[5px] px-2.5 py-1 text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            item.value === value ? "bg-accent text-accent-foreground" : "hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const PRICES: { value: Prices; label: string }[] = [
  { value: "discounted", label: "With discounts" },
  { value: "list", label: "List price" },
];

const TOOL_BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50";

/**
 * Today, a step back and forward by one range, and the days shown. `today`
 * is the server's, in the chosen zone; until the first answer brings it, the
 * buttons are disabled and the days are not named.
 */
function PeriodNav({ period, today, onGo }: { period: Period; today: string | null; onGo: (next: Period) => void }) {
  const latest = period.end === null;
  const unit = period.range === "today" ? "day" : `${RANGE_DAYS[period.range]} days`;
  const step = (by: -1 | 1) => () => {
    if (today !== null) onGo(stepPeriod(period, by, today));
  };
  return (
    <>
      <button type="button" title={`Back to the newest ${unit}`} disabled={today === null || latest} onClick={() => onGo({ range: period.range, end: null })} className={TOOL_BUTTON}>
        Today
      </button>
      <button type="button" aria-label="Earlier" title={`The ${unit} before`} disabled={today === null} onClick={step(-1)} className={cn(TOOL_BUTTON, "w-7 justify-center px-0")}>
        <ChevronLeftIcon className="size-3.5" />
      </button>
      <button type="button" aria-label="Later" title={`The ${unit} after`} disabled={today === null || latest} onClick={step(1)} className={cn(TOOL_BUTTON, "w-7 justify-center px-0")}>
        <ChevronRightIcon className="size-3.5" />
      </button>
      {today !== null ? <DatePicker period={period} today={today} onGo={onGo} /> : null}
    </>
  );
}

/** The days shown, over the browser's own date picker, which opens from a click anywhere on them. */
function DatePicker({ period, today, onGo }: { period: Period; today: string; onGo: (next: Period) => void }) {
  return (
    <span className="relative inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 hover:bg-state-hover focus-within:ring-1 focus-within:ring-ring">
      <CalendarIcon className="size-3.5 text-muted-foreground" />
      <span data-testid="period" className="text-base font-semibold whitespace-nowrap">
        {periodLabel(period.range, period.end ?? today, today)}
      </span>
      <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      <input
        type="date"
        data-burn-date=""
        aria-label="Pick a date"
        title="Pick a date"
        value={period.end ?? today}
        min={FIRST_DAY}
        max={today}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker();
          } catch {
            // Without showPicker, or where it is refused, the click still reaches the browser's own picker.
          }
        }}
        // Typing a year digit by digit passes through years such as 0002, which open nothing.
        onChange={(e) => {
          const day = e.target.value;
          if (isDay(day) && day <= today) onGo(periodEnding(period.range, day, today));
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </span>
  );
}

/** Two rows: which days the page shows, then what it measures and for which project. */
function Toolbar({
  nav,
  metric,
  onMetric,
  range,
  onRange,
  zone,
  onZone,
  projectId,
  onProject,
  options,
  panels,
}: {
  /** The controls that move through the days, before the range. */
  nav: ReactNode;
  metric: SpendMetric;
  onMetric: (metric: SpendMetric) => void;
  range: SpendRange;
  onRange: (range: SpendRange) => void;
  zone: SpendZone;
  onZone: (zone: SpendZone) => void;
  projectId: string | null;
  onProject: (projectId: string | null) => void;
  options: SpendOutput["projectOptions"];
  panels: Panels;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {nav}
        <span className="flex-1" />
        <Segments label="Range" items={RANGES.map((r) => ({ value: r.range, label: r.label }))} value={range} onChange={onRange} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Show</span>
        <Segments label="Show" items={METRICS.map((m) => ({ value: m.metric, label: m.label }))} value={metric} onChange={onMetric} />
        <span className="flex-1" />
        {/* Together, so a narrow page wraps them as a pair rather than leaving View alone on a line. */}
        <div className="flex min-w-0 items-center gap-2">
          <select
            aria-label="Project"
            value={projectId ?? ""}
            onChange={(e) => onProject(e.target.value === "" ? null : e.target.value)}
            className="h-7 max-w-[14rem] min-w-0 truncate rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">All projects</option>
            {options.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
              </option>
            ))}
          </select>
          <ViewMenu panels={panels} days={<Segments label="Days" items={ZONES.map((z) => ({ value: z.zone, label: z.label }))} value={zone} onChange={onZone} />} />
        </div>
      </div>
    </div>
  );
}

function Kpis({ data }: { data: SpendOutput }) {
  const threads = [
    // Running is about now, so a past period leaves it out.
    data.runningCount > 0 && isLatest(data) ? `${data.runningCount} running` : null,
    data.listPrice ? "at list price" : data.overBudgetCount > 0 ? `${data.overBudgetCount} over budget` : "none over budget",
  ].filter((s): s is string => s !== null);
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      <Kpi
        label={`Spent${zoneSuffix(data.tz)}`}
        value={formatAmount(data.total, data.estimated)}
        sub={<Change now={data.total} before={data.previousTotal} than={previousOf(data)} none={noneText("no spend", data)} />}
      />
      <Kpi label="Threads" value={String(data.threadCount)} sub={threads.join(" · ")} />
      <Kpi
        label="Median thread"
        value={data.medianThreadCost === null ? "—" : formatUsd(data.medianThreadCost)}
        sub={data.perCall === null ? "no calls" : `${formatUsd(data.perCall)} per call`}
      />
      <Kpi
        label="Cache hit rate"
        value={data.cacheHitPct === null ? "—" : `${Math.round(data.cacheHitPct)}%`}
        sub="of prompt tokens"
        hint="Cache reads as a share of prompt tokens, from the chosen days"
      />
    </div>
  );
}

function Legend({ models }: { models: SpendOutput["models"] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Models">
      {models.map((m, i) => (
        <li key={m.key} className="flex items-center gap-1.5" title={m.key}>
          <span aria-hidden className="size-2 rounded-[2px] bg-current" style={chartColor(i)} />
          {modelName(m.key)}
        </li>
      ))}
    </ul>
  );
}

/** About three round gridlines that cover `peak`. */
function scale(peak: number): { max: number; ticks: number[] } {
  if (!(peak > 0)) return { max: 1, ticks: [0] };
  const raw = peak / 3;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude;
  const max = Math.ceil(peak / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}

function axisLabel(v: number, metric: SpendMetric): string {
  if (metric === "tokens") return formatTokenCount(v);
  if (metric === "calls") return v.toLocaleString("en-US");
  return v >= 1 || v === 0 ? formatBudget(Math.round(v * 100) / 100) : `$${v.toFixed(2)}`;
}
const shortDay = (day: string, range: SpendRange): string =>
  range === "7d"
    ? dayDate(day).toLocaleDateString("en-US", { weekday: "short" })
    : dayDate(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const longDay = (day: string): string =>
  dayDate(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** The day's figure in the page's metric: "$23.60", "1.2M" or "312". */
const valueOf = (row: { cost: number; tokens: number; calls: number }, data: SpendOutput): string => formatMetric(row[data.metric], data.metric, data.estimated);

/** Beside the hovered day, on the side with more room, so it never covers that day's bar. */
function DayTip({ day, data, index, count }: { day: SpendOutput["days"][number]; data: SpendOutput; index: number; count: number }) {
  const right = index < count / 2;
  const edge = ((right ? index + 1 : index) / count) * 100;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-lg border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
      style={{ left: `${edge}%`, transform: right ? "translateX(6px)" : "translateX(calc(-100% - 6px))" }}
    >
      <div className="mb-1 font-semibold whitespace-nowrap">
        {longDay(day.day)} · {valueOf(day, data)}
      </div>
      {day.models.length === 0 ? <div className="text-muted-foreground">{data.metric === "cost" ? "No spend" : "No use"}</div> : null}
      {day.models.map((m) => {
        const i = data.models.findIndex((x) => x.key === m.key);
        return (
          <div key={m.key} className="flex items-center justify-between gap-3 tabular-nums">
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-2 shrink-0 rounded-[2px] bg-current" style={chartColor(i)} />
              <span className="truncate">{modelName(m.key)}</span>
            </span>
            <span>{valueOf(m, data)}</span>
          </div>
        );
      })}
      {data.metric !== "calls" ? (
        <div className="mt-1 flex justify-between gap-3 text-muted-foreground tabular-nums">
          <span>Calls</span>
          <span>{day.calls.toLocaleString("en-US")}</span>
        </div>
      ) : null}
      <div className="mt-1 text-[11px] text-muted-foreground">Click to open this day</div>
    </div>
  );
}

const LIST_LABELS: Record<SpendMetric, string> = { cost: "Spend per day", tokens: "Tokens per day", calls: "Calls per day" };

function DayChart({ data, onOpenDay }: { data: SpendOutput; onOpenDay: (day: string) => void }) {
  const { days, models, range, metric } = data;
  const dailyBudget = metric === "cost" ? data.dailyBudget : null;
  const [hover, setHover] = useState<number | null>(null);
  const { max, ticks } = scale(Math.max(dailyBudget ?? 0, ...days.map((d) => d[metric])));
  const pct = (v: number): number => Math.min(100, (v / max) * 100);
  const hovered = hover === null ? undefined : days[hover];
  const labelled = (i: number): boolean => range === "7d" || (days.length - 1 - i) % 5 === 0;
  return (
    <div className="pl-10" onMouseLeave={() => setHover(null)}>
      <div className="relative h-36">
        {ticks.map((t) => (
          <div key={t} aria-hidden className="absolute inset-x-0" style={{ bottom: `${pct(t)}%` }}>
            <div className={cn("border-t border-border", t > 0 && "border-dashed")} />
            <span className="absolute right-full mr-2 translate-y-[-50%] text-[10px] text-muted-foreground tabular-nums">{axisLabel(t, metric)}</span>
          </div>
        ))}
        {dailyBudget !== null ? (
          <div className="pointer-events-none absolute inset-x-0 z-[1]" style={{ bottom: `${pct(dailyBudget)}%` }}>
            <div className="border-t border-dashed border-warning" />
            <span className="absolute right-0 bottom-0.5 rounded-sm bg-background px-1 text-[10px] text-warning-text">Daily budget {formatBudget(dailyBudget)}</span>
          </div>
        ) : null}
        <div className="absolute inset-0 flex" role="list" aria-label={LIST_LABELS[metric]}>
          {days.map((d, i) => (
            <div
              key={d.day}
              role="listitem"
              aria-label={`${longDay(d.day)}: ${valueOf(d, data)}`}
              onMouseEnter={() => setHover(i)}
              className={cn("flex h-full min-w-0 flex-1 transition-opacity", hover !== null && hover !== i && "opacity-45")}
            >
              <button
                type="button"
                aria-label={`Open ${longDay(d.day)}`}
                onClick={() => onOpenDay(d.day)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="flex h-full w-full cursor-pointer justify-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <div className="flex h-full w-[56%] max-w-10 flex-col-reverse gap-px">
                  {d.models.map((m) => (
                    <div
                      key={m.key}
                      className="w-full shrink-0 rounded-[2px] bg-current"
                      style={{ ...chartColor(models.findIndex((x) => x.key === m.key)), height: `${pct(m[metric])}%` }}
                    />
                  ))}
                </div>
              </button>
            </div>
          ))}
        </div>
        {hovered !== undefined && hover !== null ? <DayTip day={hovered} data={data} index={hover} count={days.length} /> : null}
      </div>
      <div aria-hidden className="mt-1 flex text-[10.5px] text-muted-foreground">
        {days.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
            {labelled(i) ? shortDay(d.day, range) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The Day's split by model, with the existing Daily budget comparison. */
function TodayBar({ data }: { data: SpendOutput }) {
  const { models, metric } = data;
  const dailyBudget = metric === "cost" ? data.dailyBudget : null;
  const total = metric === "cost" ? data.total : data[metric];
  const label = formatMetric(total, metric, data.estimated);
  const day = data.days[0]?.day ?? data.today;
  const latest = isLatest(data);
  // Headroom past the larger of the two, so the budget mark never sits on the bar's rounded end.
  const span = Math.max(total, dailyBudget ?? 0) * 1.08 || 1;
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground tabular-nums">
        <span className="text-sm font-semibold text-foreground">{label}</span> {latest ? "today" : `on ${longDay(day)}`}
        {dailyBudget !== null ? ` of the ${formatBudget(dailyBudget)} daily budget` : ""}
      </div>
      <div className="relative">
        <div className="flex h-3 gap-px overflow-hidden rounded-full bg-muted" role="img" aria-label={`${latest ? "Today" : longDay(day)} by model: ${label}`}>
          {models.map((m, i) => (
            <div key={m.key} className="h-full bg-current" style={{ ...chartColor(i), width: `${(m[metric] / span) * 100}%` }} />
          ))}
        </div>
        {dailyBudget !== null ? (
          <div
            aria-hidden
            className="absolute -top-1 -bottom-1 border-l-2 border-dashed border-warning"
            style={{ left: `${Math.min(100, (dailyBudget / span) * 100)}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

function DaySpend({ data }: { data: SpendOutput }) {
  const { hourlyCost, estimated } = data;
  const hasHours = hourlyCost !== undefined && hourlyCost.hours.length > 0;
  const timeZone = hourlyCost?.timeZone ?? "UTC";
  const notes: string[] = [];
  let chart = <p className="text-xs text-muted-foreground">No hourly dollar data for this day.</p>;
  if (hasHours) {
    const { start, end, budget, hours, omittedBoundaryCost } = hourlyCost;
    const points = [{ at: start, total: 0 }];
    let through = start;
    let total = 0;
    for (const { at, cost } of hours) {
      if (at > through) points.push({ at, total });
      total += cost;
      through = Math.min(at + HOUR_MS, end);
      points.push({ at: through, total });
    }
    const shown = formatAmount(total, estimated);
    const dayTotal = formatAmount(data.total, estimated);
    if (shown !== dayTotal) notes.push(`Hours shown add up to ${shown}; the day total is ${dayTotal}.`);
    if (hourlyCost.timeZone === null) notes.push("Times are in UTC because the server's local time zone is not named.");
    // Independently summed totals can differ in floating-point precision, but must agree on reaching the cap.
    const reconciled = Math.abs(total - data.total) <= Math.max(total, data.total) * 1e-9;
    const budgetUsd = budget !== null && budget > 0 && budget / 2 <= total && reconciled &&
      (total >= budget) === (data.total >= budget) && !omittedBoundaryCost && data.reading === 0 ? budget : undefined;
    const span = `From ${spendTimeLabel(start, timeZone)} to ${spendTimeLabel(end, timeZone)} in ${timeZone}.`;
    chart = (
      <CumulativeSpendChart
        points={points}
        from={start}
        to={end}
        estimated={estimated}
        ariaLabel={`Cumulative spend from hourly data: ${shown}. ${span}${budgetUsd === undefined ? "" : ` Daily budget ${formatBudget(budgetUsd)}.`}`}
        timeZone={timeZone}
        {...(budgetUsd === undefined ? {} : { budgetUsd })}
      />
    );
  }
  if (hourlyCost?.omittedBoundaryCost) notes.push("Hours that cross midnight are omitted.");
  if (data.reading > 0) notes.push("Some reports are still loading.");
  return (
    <section aria-label="Spend over time" className="mt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Spend over time</h3>
        {hasHours ? <span className="text-xs text-muted-foreground">Hourly totals · {timeZone}</span> : null}
      </div>
      {chart}
      {notes.length > 0 ? <p className="mt-1 text-xs text-muted-foreground">{notes.join(" ")}</p> : null}
    </section>
  );
}

const THREAD_TITLES: Record<SpendMetric, string> = { cost: "Costliest threads", tokens: "Most tokens", calls: "Most calls" };

function ThreadTable({ data, hide }: { data: SpendOutput; hide: ReactNode }) {
  const navigate = useBbNavigate();
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {THREAD_TITLES[data.metric]}
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Calls
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Tokens
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium whitespace-nowrap">
              {isLatest(data) ? rangeInfo(data.range).column : periodLabel(data.range, data.days.at(-1)?.day ?? data.today, data.today)}
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Total
            </th>
            <th scope="col" className="w-0 px-3 py-2 text-right">
              <span className="sr-only">Status</span>
              {hide}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.threads.length === 0 ? (
            <tr className="border-t border-border">
              <td colSpan={6} className="px-3 py-3 text-muted-foreground">
                {data.metric === "cost" ? "No thread spent anything in this period." : "No thread used anything in this period."}
              </td>
            </tr>
          ) : null}
          {data.threads.map((t) => {
            const over = budgetState(t.budgetCost ?? t.total, t.budget) === "over";
            const detail = [
              t.projectName,
              t.model,
              t.harness === "pi" ? null : t.harness,
              t.childCount > 0 ? `${t.childCount} ${t.childCount === 1 ? "child thread" : "child threads"}` : null,
            ].filter((s): s is string => s !== null);
            return (
              <tr
                key={t.threadId}
                data-testid="spend-thread"
                onClick={() => navigate.toThread(t.threadId)}
                className="cursor-pointer border-t border-border hover:bg-state-hover"
              >
                <td className="w-full max-w-0 px-3 py-2">
                  <button
                    type="button"
                    className="block max-w-full truncate rounded-sm text-left text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {t.title}
                  </button>
                  {detail.length > 0 ? <div className="truncate text-[11px] text-muted-foreground">{detail.join(" · ")}</div> : null}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{t.calls.toLocaleString("en-US")}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatTokenCount(t.tokens)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatAmount(t.rangeCost, t.estimated)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatAmount(t.total, t.estimated)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <span className="inline-flex gap-1">
                    {over && t.budget !== null ? (
                      <span className="rounded-full bg-current/15 px-1.5 py-px text-[10.5px] font-semibold text-destructive-text">
                        over {formatBudget(t.budget)}
                      </span>
                    ) : null}
                    {t.running ? (
                      <span className="rounded-full bg-current/15 px-1.5 py-px text-[10.5px] font-semibold" style={RUNNING_COLOR}>
                        running
                      </span>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface BarRow {
  key: string;
  name: string;
  hint?: string;
  value: number;
  label: string;
  color: CSSProperties;
}

function Bars({ label, rows, metric, hide }: { label: string; rows: BarRow[]; metric: SpendMetric; hide: ReactNode }) {
  const peak = Math.max(0, ...rows.map((r) => r.value)) || 1;
  return (
    <section aria-label={label}>
      <PanelLabel hide={hide}>{label}</PanelLabel>
      {rows.length === 0 ? <div className="text-xs text-muted-foreground">{metric === "cost" ? "No spend in this period." : "No use in this period."}</div> : null}
      <div className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-x-2 gap-y-1.5 text-xs">
        {rows.map((r) => (
          <div key={r.key} className="contents">
            <span className="truncate" title={r.hint ?? r.name}>
              {r.name}
            </span>
            <span className="h-2 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-current" style={{ ...r.color, width: `${(r.value / peak) * 100}%` }} />
            </span>
            <span className="text-right tabular-nums">{r.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Two panels side by side on a wide page, or the one that is shown across it. */
function Pair({ left, right }: { left: ReactNode; right: ReactNode }) {
  if (left === null && right === null) return null;
  return (
    <div className={cn("grid gap-5", left !== null && right !== null && "md:grid-cols-2")}>
      {left}
      {right}
    </div>
  );
}

const CARD = "min-w-0 rounded-lg border border-border p-3";

function Dashboard({
  data,
  panels,
  prices,
  onPrices,
  onOpenDay,
}: {
  data: SpendOutput;
  panels: Panels;
  onOpenDay: (day: string) => void;
  /** null while no discount is set, so there is nothing to switch. */
  prices: Prices | null;
  onPrices: (prices: Prices) => void;
}) {
  const { metric } = data;
  const shown = (id: SpendPanel, panel: () => ReactNode, className?: string): ReactNode =>
    panels.shown(id) ? <div className={cn("group min-w-0", className)}>{panel()}</div> : null;
  const hide = (id: SpendPanel): ReactNode => <HideButton id={id} panels={panels} />;
  const title = data.range !== "today" ? "Per day" : isLatest(data) ? "Today" : longDay(data.days[0]?.day ?? data.today);
  const allHidden = PANELS.every((p) => !panels.shown(p.id));
  return (
    <>
      <div className="space-y-2.5">
        <Kpis data={data} />
        {shown("usage", () => <UsageCards data={data} />)}
        {data.estimated ? <p className="text-xs text-muted-foreground">~ includes estimates from list prices for harnesses that record no cost.</p> : null}
        {prices !== null ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Segments label="Prices" items={PRICES} value={prices} onChange={onPrices} />
            <p className="text-xs text-muted-foreground" data-testid="discounted">
              {data.listPrice ? "List price, without your discounts. Budgets use the discounted figures." : "Costs include the discounts in Burn's settings."}
            </p>
          </div>
        ) : null}
      </div>
      {shown("chart", () => (
        <section aria-label={title}>
          <PanelLabel aside={data.models.length > 0 ? <Legend models={data.models} /> : undefined} hide={hide("chart")}>
            {title}
            {metric === "cost" ? "" : ` · ${METRIC_WORDS[metric]}`}
            {zoneSuffix(data.tz)}
          </PanelLabel>
          {data.range === "today" ? <TodayBar data={data} /> : <DayChart data={data} onOpenDay={onOpenDay} />}
          {data.range === "today" && metric === "cost" ? <DaySpend data={data} /> : null}
        </section>
      ))}
      <Pair left={shown("mix", () => <TokenMix data={data} hide={hide("mix")} />, CARD)} right={shown("time", () => <CallTime data={data} hide={hide("time")} />, CARD)} />
      {shown("activity", () => <Activity data={data} hide={hide("activity")} />)}
      {shown("threads", () => <ThreadTable data={data} hide={hide("threads")} />)}
      {shown("models", () => <ModelTable data={data} hide={hide("models")} />)}
      <Pair
        left={shown("projects", () => (
          <Bars
            label="By project"
            metric={metric}
            hide={hide("projects")}
            rows={data.projects.map((p) => ({
              key: p.projectId ?? "",
              name: p.name,
              value: p[metric],
              label: formatMetric(p[metric], metric, data.estimated),
              color: PROJECT_COLOR,
            }))}
          />
        ))}
        right={shown("harnesses", () => (
          <Bars
            label="By harness"
            metric={metric}
            hide={hide("harnesses")}
            rows={data.harnesses.map((h) => ({
              key: h.providerId,
              name: h.name,
              hint: h.providerId,
              value: h[metric],
              label: formatMetric(h[metric], metric, h.estimated),
              color: HARNESS_COLOR,
            }))}
          />
        ))}
      />
      {allHidden ? (
        <Notice role="status">
          Every panel is hidden.{" "}
          <button type="button" onClick={panels.showAll} className="rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            Show all panels
          </button>
        </Notice>
      ) : null}
    </>
  );
}

function Notice({ role, children }: { role: "status" | "alert"; children: ReactNode }) {
  return (
    <div role={role} className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** A block where a figure will be, so the page keeps its shape while its answer is on the way. */
function Skeleton({ className, style }: { className?: string; style?: CSSProperties }): ReactNode {
  return (
    <span aria-hidden className={cn("relative block overflow-hidden rounded bg-state-hover", className)} style={style}>
      <span data-burn-shimmer="" className="pointer-events-none absolute inset-0" />
    </span>
  );
}

/** The Burn page's panels in outline: cost cards, a per-day chart and a threads table, all as placeholders. */
function SkeletonDashboard(): ReactNode {
  return (
    <div className="space-y-5" data-testid="spend-skeleton" aria-hidden>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="mt-2.5 h-5 w-24" />
            <Skeleton className="mt-2.5 h-2 w-20" />
          </div>
        ))}
      </div>
      <section>
        <Skeleton className="mb-2 h-2.5 w-20" />
        <div className="flex h-36 items-end gap-1.5 pl-10">
          {Array.from({ length: 18 }, (_, i) => (
            <Skeleton key={i} className="flex-1" style={{ height: `${30 + ((i * 37) % 55)}%` }} />
          ))}
        </div>
      </section>
      <section>
        <Skeleton className="mb-2 h-2.5 w-28" />
        <div className="overflow-hidden rounded-lg border border-border">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
              <Skeleton className="h-3 min-w-0 flex-1" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** True while `active`, shown once it has lasted `delay` and kept for at least `hold` afterwards. */
function useHeld(active: boolean, delay: number, hold: number): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (active) {
      if (shown) return;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delay);
      return () => clearTimeout(timer);
    }
    if (!shown) return;
    const left = hold - (Date.now() - shownAt.current);
    if (left <= 0) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(false), left);
    return () => clearTimeout(timer);
  }, [active, shown, delay, hold]);
  return shown;
}

/**
 * A line under the toolbar while an answer is on the way, naming how many threads are still being
 * read. A refresh keeps the figures below it on screen, so the page is usable before the new ones
 * land. Its row is always there, so the panels below it stay put whether or not it has anything to
 * say, and a refresh that answers as fast as the last one never shows it at all.
 */
function LoadProgress({ loading, first, reading }: { loading: boolean; first: boolean; reading: number }): ReactNode {
  // Nothing on screen yet, so the line needs no hold: it goes the moment the first answer lands.
  const busy = useHeld(loading && !first, READING_DELAY_MS, READING_HOLD_MS);
  return (
    <div data-testid="reading-slot" className="h-4">
      {first || reading > 0 || busy ? (
        <div role="status" aria-live="polite" data-testid="load-progress" className="flex h-4 items-center gap-2.5 text-xs text-muted-foreground">
          <span className="relative h-1 w-28 shrink-0 overflow-hidden rounded-full bg-state-hover">
            <span data-burn-shimmer="" className="pointer-events-none absolute inset-0" />
          </span>
          {reading > 0
            ? `Still reading ${reading.toLocaleString("en-US")} ${reading === 1 ? "thread" : "threads"}…`
            : "Loading spend…"}
        </div>
      ) : null}
    </div>
  );
}

/** The Burn page: what every thread has spent and used, by day, hour, thread, model, project and harness. */
export function SpendPage({ subPath }: PluginNavPanelProps): ReactNode {
  const [view, setView] = useState<SavedView>(loadView);
  const remember = (patch: Partial<SavedView>): void => {
    const next = { ...view, ...patch };
    setView(next);
    saveView(next);
  };
  const { metric, projectId, tz: zone, prices } = view;
  // bb re-renders the page with the new address on navigation, so the days shown are read from it, never copied into state.
  const asked = parsePeriod(subPath) ?? { range: view.range, end: null };
  const { range } = asked;
  const { discounted } = readPrefs(useSettings().values);
  const { data, error, loading, retry } = useSpend(range, asked.end, projectId, zone, metric, discounted && prices === "list");
  const panels = usePanels();
  const today = data?.today ?? null;
  // A last day of today or later, as an old link can hold, is the newest period.
  const period: Period = asked.end !== null && today !== null && asked.end >= today ? { range, end: null } : asked;
  const navigate = useBbNavigate();
  const go = (next: Period, replace = false): void =>
    navigate.toPluginPanel("spend", replace ? { subPath: periodPath(next), replace: true } : { subPath: periodPath(next) });
  const chooseRange = (next: SpendRange): void => {
    remember({ range: next });
    // The bare address shows the remembered range, so a pushed entry would leave a back step that shows the new range again.
    go({ range: next, end: period.end }, subPath === "");
  };

  // Once, against the first answer: checking every answer would drop a project on a range without its threads.
  const projectChecked = useRef(false);
  useEffect(() => {
    if (data === null || projectChecked.current) return;
    projectChecked.current = true;
    if (projectId !== null && !data.projectOptions.some((p) => p.projectId === projectId)) remember({ projectId: null });
  });

  let body: ReactNode;
  if (data === null && error !== null) {
    body = (
      <Notice role="alert">
        <div>Could not load spend: {error}</div>
        <button type="button" onClick={retry} className="mt-3 rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-state-hover">
          Try again
        </button>
      </Notice>
    );
  } else if (data === null || !panels.ready) {
    body = <SkeletonDashboard />;
  } else if (data.reportedThreads === 0) {
    body = <Notice role="status">{EMPTY_TEXT}</Notice>;
  } else {
    body = (
      <>
        {error !== null ? (
          <div role="alert" className="text-xs text-destructive-text">
            Could not refresh: {error}
          </div>
        ) : null}
        <Dashboard
          data={data}
          panels={panels}
          prices={discounted ? prices : null}
          onPrices={(next) => remember({ prices: next })}
          onOpenDay={(day) => go(periodEnding("today", day, data.today))}
        />
      </>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-4xl space-y-5 text-foreground" aria-busy={loading || (data?.reading ?? 0) > 0}>
        <div className="space-y-1.5">
          <Toolbar
            nav={<PeriodNav period={period} today={today} onGo={go} />}
            metric={metric}
            onMetric={(next) => remember({ metric: next })}
            range={range}
            onRange={chooseRange}
            zone={zone}
            onZone={(next) => remember({ tz: next })}
            projectId={projectId}
            onProject={(next) => remember({ projectId: next })}
            options={data?.projectOptions ?? []}
            panels={panels}
          />
          <LoadProgress loading={loading} first={data === null && loading} reading={data?.reading ?? 0} />
        </div>
        {body}
      </div>
    </div>
  );
}
