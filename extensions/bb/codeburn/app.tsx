import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, StatsReply, StatsRow, TableName } from "./contract.js";
import { ParityDashboard } from "./parity-app.js";

const TABLE_LABELS: Record<TableName, string> = {
  daily: "Daily spend",
  activity: "Activity",
  models: "Models",
  projects: "Projects",
  sessions: "Sessions",
  tools: "Tools",
  mcp: "MCP",
  shellCommands: "Shell commands",
  records: "Records",
};
const TABLE_NAMES = Object.keys(TABLE_LABELS) as TableName[];
const PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const;
type Period = (typeof PERIODS)[number]["value"];
type Machine = { id: string; name: string; connected: boolean };
type RequestState = { key: string; phase: "loading" | "ready" | "error"; error?: string };
const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const cents = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(value: number, currency: StatsReply["currency"]): string {
  return `${currency.symbol || currency.code}${cents.format(value)}`;
}

function timestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function day(value: string): string {
  // Noon avoids crossing the day boundary in local time for date-only strings.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function cell(value: StatsRow[string], column: string, currency: StatsReply["currency"], table: TableName) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "object") {
    return <pre className="max-w-96 whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
  }
  if (typeof value === "number") {
    if (table === "records" && ["cost", "savings", "listCost"].includes(column)) return `${currency.symbol || currency.code}${value}`;
    if (column === "cost" || column === "saved" || column === "costPerEdit") return money(value, currency);
    return decimal.format(value);
  }
  if (typeof value === "string" && /^(date|day)$/i.test(column)) return day(value);
  return String(value);
}

function DailyChart({ rows, currency }: { rows: StatsRow[]; currency: StatsReply["currency"] }) {
  const points = rows.flatMap((row) =>
    typeof row.date === "string" && typeof row.cost === "number"
      ? [{ date: row.date, cost: row.cost }]
      : [],
  );
  if (points.length === 0) return <p className="text-sm text-muted-foreground">No daily spend rows on this page.</p>;
  const maximum = Math.max(...points.map((point) => point.cost), 0);
  const width = 640;
  const height = 136;
  const gap = 3;
  const step = width / points.length;
  return (
    <figure className="mb-6">
      <figcaption className="mb-2 text-sm font-medium">Daily estimated spend · visible rows</figcaption>
      <svg
        role="img"
        aria-label={`Daily estimated spend: ${points.map((point) => `${day(point.date)} ${money(point.cost, currency)}`).join("; ")}`}
        viewBox={`0 0 ${width} ${height}`}
        className="h-36 w-full text-primary"
        preserveAspectRatio="none"
      >
        {points.map((point, index) => {
          const barHeight = maximum > 0 ? (point.cost / maximum) * (height - 8) : 0;
          return (
            <rect
              key={`${point.date}-${index}`}
              x={index * step + gap / 2}
              y={height - barHeight}
              width={Math.max(step - gap, 1)}
              height={barHeight}
              rx="1"
              fill="currentColor"
            >
              <title>{`${day(point.date)}: ${money(point.cost, currency)}`}</title>
            </rect>
          );
        })}
      </svg>
      <p className="mt-1 text-xs text-muted-foreground">Only recorded days on the current page are shown; gaps are not zero-spend days.</p>
    </figure>
  );
}

function CodeBurnPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [machinesError, setMachinesError] = useState<string | null>(null);
  const [machineAttempt, setMachineAttempt] = useState(0);
  const [hostId, setHostId] = useState("");
  const [period, setPeriod] = useState<Period>("30d");
  const [table, setTable] = useState<TableName>("daily");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [refreshId, setRefreshId] = useState(0);
  const lastRefreshId = useRef(0);
  const [requestState, setRequestState] = useState<RequestState | null>(null);
  const [result, setResult] = useState<{ key: string; value: StatsReply } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMachines(null);
    setMachinesError(null);
    rpc.call("codeburnMachines", null).then(
      ({ machines: next }) => {
        if (cancelled) return;
        setMachines(next);
        const connected = next.filter((machine) => machine.connected);
        setHostId((current) =>
          connected.some((machine) => machine.id === current)
            ? current
            : connected.length === 1 ? connected[0].id : "",
        );
      },
      (cause: unknown) => {
        if (cancelled) return;
        setHostId("");
        setMachinesError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => { cancelled = true; };
  }, [rpc, machineAttempt]);

  const selectedMachine = machines?.find((machine) => machine.id === hostId && machine.connected);
  const key = JSON.stringify([selectedMachine?.id, period, table, page, search, refreshId]);
  useEffect(() => {
    if (!selectedMachine) return;
    let cancelled = false;
    const refresh = refreshId !== lastRefreshId.current;
    lastRefreshId.current = refreshId;
    setResult(null);
    setRequestState({ key, phase: "loading" });
    rpc.call("codeburnStatistics", { hostId: selectedMachine.id, period, table, page, search, refresh }).then(
      (value) => {
        if (cancelled) return;
        setResult({ key, value });
        setRequestState({ key, phase: "ready" });
      },
      (cause: unknown) => {
        if (cancelled) return;
        setRequestState({ key, phase: "error", error: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => { cancelled = true; };
  }, [rpc, selectedMachine?.id, period, table, page, search, refreshId, key]);

  const stats = requestState?.key === key && requestState.phase === "ready" && result?.key === key
    ? result.value : null;
  const statsError = requestState?.key === key && requestState.phase === "error" ? requestState.error : null;
  const loading = Boolean(selectedMachine && (requestState?.key !== key || requestState.phase === "loading"));
  const connected = machines?.filter((machine) => machine.connected) ?? [];
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = searchDraft.trim();
    if (next !== search) {
      setSearch(next);
      setPage(0);
    }
  };
  const totalPages = stats ? Math.ceil(stats.totalRows / stats.pageSize) : 0;

  return (
    <main data-burn-source="codeburn" data-burn-view="machine-raw" className="h-full min-h-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto box-border w-full max-w-6xl px-4 pb-10 pt-5 sm:px-6 lg:px-8">
        <header className="mb-6 border-b border-border pb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">CodeBurn</h1>
              <p className="mt-1 text-sm text-muted-foreground">Machine-local CLI usage estimates · on-demand export</p>
            </div>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              onClick={() => setRefreshId((id) => id + 1)}
              disabled={!selectedMachine || loading}
              aria-label="Refresh CodeBurn data from CLI"
            >
              Refresh scan
            </button>
          </div>
          {stats ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Source: {selectedMachine?.name} · exported {timestamp(stats.generated)} · {day(stats.from)} – {day(stats.to)} · {stats.currency.code}
            </p>
          ) : null}
        </header>

        <section aria-label="Usage controls" className="mb-6 flex flex-wrap items-end gap-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground sm:max-w-64">
            Machine
            <select
              value={selectedMachine?.id ?? ""}
              onChange={(event) => { setHostId(event.target.value); setPage(0); }}
              disabled={machines === null || connected.length === 0}
              className="min-h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              <option value="">{connected.length > 1 ? "Select a machine" : "No connected machine"}</option>
              {machines?.map((machine) => <option key={machine.id} value={machine.id} disabled={!machine.connected}>{machine.name}{machine.connected ? "" : " (offline)"}</option>)}
            </select>
          </label>
          <label className="flex min-w-36 flex-col gap-1 text-xs font-medium text-muted-foreground">
            Period
            <select
              value={period}
              onChange={(event) => { setPeriod(event.target.value as Period); setPage(0); }}
              className="min-h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <p className="basis-full text-xs text-muted-foreground" aria-live="polite">
            {selectedMachine ? `Selected machine: ${selectedMachine.name}` : machines === null ? "Looking for connected machines…" : "Select one connected machine to view its usage. Offline machines cannot be queried."}
          </p>
        </section>

        {machinesError ? (
          <div role="alert" className="mb-6 rounded-md border border-destructive px-4 py-3 text-sm text-destructive">
            Could not list machines: {machinesError}. Check Burn settings and BB machine connectivity.{" "}
            <button type="button" className="underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setMachineAttempt((id) => id + 1)}>Retry machine list</button>
          </div>
        ) : null}
        {machines && connected.length === 0 && !machinesError ? (
          <p role="status" className="mb-6 rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
            No connected machines are available. Connect a machine in BB, then{" "}
            <button type="button" className="underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setMachineAttempt((id) => id + 1)}>retry machine list</button>.
          </p>
        ) : null}
        {statsError ? (
          <div role="alert" className="mb-6 rounded-md border border-destructive px-4 py-3 text-sm text-destructive">
            Could not load CodeBurn usage for {selectedMachine?.name}: {statsError}. Check the CodeBurn CLI path in Burn settings and that CodeBurn can export on this machine.{" "}
            <button type="button" className="underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setRefreshId((id) => id + 1)}>Retry query</button>
          </div>
        ) : null}
        {loading ? <p role="status" aria-live="polite" className="py-8 text-sm text-muted-foreground">Loading CodeBurn usage from {selectedMachine?.name}…</p> : null}

        {stats ? (
          <>
            <section aria-label="Period totals" className="mb-6">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-4">
                {([
                  ["Estimated cost", money(stats.summary.cost, stats.currency)],
                  ["API calls", integer.format(stats.summary.apiCalls)],
                  ["Sessions", integer.format(stats.summary.sessions)],
                  ["Projects", integer.format(stats.summary.projects)],
                ] as const).map(([label, value]) => (
                  <div key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p></div>
                ))}
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Tokens · input {integer.format(stats.tokens.input)} · output {integer.format(stats.tokens.output)} · cache read {integer.format(stats.tokens.cacheRead)} · cache write {integer.format(stats.tokens.cacheWrite)}
                {stats.summary.saved > 0 ? ` · estimated savings ${money(stats.summary.saved, stats.currency)}` : ""}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">Costs are CodeBurn CLI-accounted estimates, not an invoice. Machine-wide usage may overlap with Burn; do not add the two totals together.</p>
            </section>
            {table === "daily" ? <DailyChart rows={stats.rows} currency={stats.currency} /> : null}
          </>
        ) : null}

        {selectedMachine ? (
          <section aria-label="Usage details">
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <label className="flex min-w-40 flex-col gap-1 text-xs font-medium text-muted-foreground">
                View
                <select
                  value={table}
                  onChange={(event) => { setTable(event.target.value as TableName); setPage(0); }}
                  className="min-h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {TABLE_NAMES.map((name) => <option key={name} value={name}>{TABLE_LABELS[name]}</option>)}
                </select>
              </label>
              <form onSubmit={submitSearch} role="search" className="flex min-w-0 flex-1 flex-wrap items-end gap-2 sm:justify-end">
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground sm:max-w-64">
                  Search {TABLE_LABELS[table].toLowerCase()}
                  <input
                    type="search"
                    maxLength={200}
                    value={searchDraft}
                    onChange={(event) => setSearchDraft(event.target.value)}
                    className="min-h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  />
                </label>
                <button type="submit" className="min-h-9 rounded-md border border-border px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">Search</button>
              </form>
            </div>
            {stats ? (
              <>
                <h2 className="mb-2 text-base font-semibold">{TABLE_LABELS[table]} <span className="text-sm font-normal text-muted-foreground">({integer.format(stats.totalRows)} matching rows)</span></h2>
                {stats.rows.length === 0 ? (
                  <p role="status" className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">No {TABLE_LABELS[table].toLowerCase()} rows{search ? ` match “${search}”` : " for this period"}. No rows were added to fill missing data.</p>
                ) : (
                  <div role="region" aria-label={`${TABLE_LABELS[table]} table (scroll horizontally for more columns)`} tabIndex={0} className="max-w-full overflow-x-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring">
                    <table className="w-full min-w-max border-collapse text-left text-sm">
                      <thead className="bg-muted text-xs text-muted-foreground"><tr>{stats.columns.map((column) => <th key={column} scope="col" className="whitespace-nowrap border-b border-border px-3 py-2 font-medium">{column}</th>)}</tr></thead>
                      <tbody>{stats.rows.map((row, index) => (
                        <tr key={index} className="border-b border-border last:border-b-0 hover:bg-muted/50">
                          {stats.columns.map((column) => <td key={column} className="max-w-96 px-3 py-2 align-top tabular-nums break-words">{cell(row[column], column, stats.currency, table)}</td>)}
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
                <nav aria-label="Results pages" className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <p className="text-muted-foreground">{stats.totalRows === 0 ? "0 results" : `Rows ${stats.page * stats.pageSize + 1}–${Math.min((stats.page + 1) * stats.pageSize, stats.totalRows)} of ${integer.format(stats.totalRows)}`}</p>
                  <div className="flex items-center gap-3">
                    <button type="button" disabled={stats.page === 0} onClick={() => setPage(stats.page - 1)} className="rounded-md border border-border px-3 py-1.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Previous</button>
                    <span aria-live="polite">Page {stats.page + 1} of {Math.max(totalPages, 1)}</span>
                    <button type="button" disabled={stats.page + 1 >= totalPages} onClick={() => setPage(stats.page + 1)} className="rounded-md border border-border px-3 py-1.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Next</button>
                  </div>
                </nav>
              </>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}

export function CodeBurnWorkspace() {
  const [view, setView] = useState<"dashboard" | "raw">("dashboard");
  return (
    <div data-burn-source="codeburn" className="flex h-full min-h-0 flex-1 flex-col bg-background text-foreground">
      <nav aria-label="CodeBurn interface" className="flex shrink-0 gap-1 border-b border-border px-4 py-2">
        {([
          ["dashboard", "Reports & settings"],
          ["raw", "Raw export tables"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            onClick={() => setView(id)}
            className={`rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-ring ${view === id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent"}`}
          >{label}</button>
        ))}
      </nav>
      {view === "dashboard" ? <ParityDashboard /> : <CodeBurnPage />}
    </div>
  );
}

