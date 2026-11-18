import { useState } from "react";
import type { FormEvent } from "react";
import type { ReportReply } from "./parity-contract.js";

const button = "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const number = new Intl.NumberFormat();

function label(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (first) => first.toUpperCase());
}
function scalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value || "(empty string)";
  return value === undefined ? "(missing)" : "";
}
function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function DailyChart({ rows }: { rows: ReportReply["rows"] }) {
  const observations = rows.flatMap((row) => {
    const date = row.date ?? row.day;
    const cost = row.cost ?? row.costUSD;
    return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? [{ date, cost }] : [];
  });
  if (observations.length < 2) return null;
  const max = Math.max(...observations.map((item) => item.cost));
  return <section aria-label="Daily cost chart" className="mb-5 border-y border-border py-3">
    <h3 className="text-sm font-medium">Daily cost · current page</h3>
    <div className="mt-3 flex h-32 items-end gap-1" role="img" aria-label={observations.map((item) => `${item.date}: ${scalar(item.cost)}`).join("; ")}>
      {observations.map((item, index) => <div key={`${item.date}-${index}`} title={`${item.date}: ${scalar(item.cost)}`} className="min-w-0 flex-1 rounded-t-sm bg-primary" style={{ height: `${max === 0 ? 2 : Math.max(2, item.cost / max * 100)}%` }} />)}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Dates and amounts returned by the CLI; this view adds no inferred days. Values are estimates.</p>
  </section>;
}

export function ParityData({ result, search, busy, onNavigate, onPage, onSearch, onSession, onPeriodSessions }: {
  result: ReportReply;
  search: string;
  busy: boolean;
  onNavigate: (path: string[]) => void;
  onPage: (page: number) => void;
  onSearch: (search: string) => void;
  onSession: (id: string) => void;
  onPeriodSessions: (dimension: "project" | "model", key: string) => void;
}) {
  const [draft, setDraft] = useState(search);
  const focus = result.focus;
  const pages = Math.ceil(result.totalRows / result.pageSize);
  function searchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(draft.trim());
  }
  return <section aria-label="Report results" aria-busy={busy} className="min-w-0">
    <p className="mb-3 text-xs text-muted-foreground">Source scan: {timestamp(result.generated)} · {result.scopeNote}</p>
    <nav aria-label="Report breadcrumb" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <button type="button" onClick={() => onNavigate([])} disabled={busy || focus.length === 0} className={button}>Report root</button>
      {focus.map((part, index) => <span key={`${index}-${part}`} className="inline-flex min-w-0 items-center gap-2"><span aria-hidden="true">/</span><button type="button" className={`${button} max-w-56 truncate`} disabled={busy || index === focus.length - 1} onClick={() => onNavigate(focus.slice(0, index + 1))}>{label(part)}</button></span>)}
    </nav>
    {result.fields.length > 0 && result.rows.length === 0 && <dl className="mb-5 grid grid-cols-1 gap-x-6 gap-y-3 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-3">
      {result.fields.map((field) => <div key={JSON.stringify(field.path)} className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label(field.name)}</dt>
        <dd className="mt-1 break-words text-sm tabular-nums">
          {field.kind === "value" ? scalar(field.value) : <button type="button" disabled={busy} onClick={() => onNavigate(field.path)} className="text-left underline underline-offset-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">Open {field.kind} {field.count === undefined ? "" : `(${number.format(field.count)})`}</button>}
        </dd>
      </div>)}
    </dl>}
    <DailyChart rows={result.rows} />
    {(result.columns.length > 0 || search.length > 0) && <form onSubmit={searchSubmit} role="search" className="mb-3 flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">Search rows on this snapshot
        <input type="search" maxLength={200} value={draft} onChange={(event) => setDraft(event.target.value)} className="min-h-10 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring" />
      </label>
      <button type="submit" className={button} disabled={busy}>Search</button>
      {search && <button type="button" className={button} disabled={busy} onClick={() => { setDraft(""); onSearch(""); }}>Clear</button>}
    </form>}
    {result.rows.length === 0 ? (result.fields.length === 0 ? <p role="status" className="rounded-md border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{result.totalRows === 0 ? "No rows at this path" : "No rows on this page"}{search ? ` matching “${search}”` : ""}. No missing observations were filled in.</p> : null) : <div role="region" tabIndex={0} aria-label="Report rows; scroll horizontally for additional columns" className="max-w-full overflow-x-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring">
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <thead className="bg-muted text-xs text-muted-foreground"><tr>{result.columns.map((column) => <th key={column} scope="col" className="border-b border-border px-3 py-2 font-medium">{label(column)}</th>)}<th scope="col" className="border-b border-border px-3 py-2 font-medium">Explore</th></tr></thead>
        <tbody>{result.rows.map((row, index) => {
          const path = result.rowPaths[index];
          const id = row.sessionId ?? row.id;
          const dimension = result.focus[0] === "projects" ? "project" : result.focus[0] === "models" ? "model" : null;
          const canonicalKey = row.key;
          const canCompare = result.report === "period-comparison" && dimension !== null && typeof canonicalKey === "string" && canonicalKey.length > 0;
          return <tr key={JSON.stringify(path ?? [result.page, index])} className="border-b border-border last:border-b-0 hover:bg-muted/50">
            {result.columns.map((column) => {
              const value = row[column];
              return <td key={column} className="max-w-96 break-words px-3 py-2 align-top tabular-nums">
                {value !== null && typeof value === "object" ? <span className="text-muted-foreground">Nested {Array.isArray(value) ? "array" : "object"} · use Details</span> : scalar(value)}
              </td>;
            })}
            <td className="whitespace-nowrap px-3 py-2 align-top"><div className="flex flex-col items-start gap-1">
              <button type="button" disabled={busy || !path} className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" onClick={() => path && onNavigate(path)}>Details</button>
              {result.report === "sessions" && typeof row.provider === "string" && row.provider.toLowerCase().startsWith("claude") && typeof id === "string" && id.length > 0 && <button type="button" disabled={busy} className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onSession(id)}>Diagnose Claude session</button>}
              {canCompare && dimension && typeof canonicalKey === "string" && <button type="button" disabled={busy} className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onPeriodSessions(dimension, canonicalKey)}>View compared sessions</button>}
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    {result.columns.length > 0 && <nav aria-label="Report pages" className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{result.totalRows === 0 ? "0 rows" : `Rows ${result.page * result.pageSize + 1}–${Math.min((result.page + 1) * result.pageSize, result.totalRows)} of ${number.format(result.totalRows)}`}</span>
      <div className="flex items-center gap-2"><button type="button" className={button} disabled={busy || result.page === 0} onClick={() => onPage(result.page - 1)}>Previous</button><span>Page {result.page + 1} of {Math.max(1, pages)}</span><button type="button" className={button} disabled={busy || result.page + 1 >= pages} onClick={() => onPage(result.page + 1)}>Next</button></div>
    </nav>}
  </section>;
}

