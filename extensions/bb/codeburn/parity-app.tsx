import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract.js";
import { ACTIONS, REPORTS, actionQuerySchema, reportQuerySchema, scopeSchema } from "./parity-contract.js";
import type { ActionName, ActionPreview, FeatureDefinition, ReportName, ReportQuery, ReportReply, ReportScope } from "./parity-contract.js";
import { ParityData } from "./parity-data.js";
import { ParityExports } from "./parity-exports.js";

type Machine = { id: string; name: string; connected: boolean };
type PeriodSelection = ReportScope["period"] | "custom";
type Pane = "reports" | "configuration" | "exports";
const periods: { id: PeriodSelection; label: string }[] = [
  { id: "today", label: "Today" }, { id: "week", label: "Last 7 days" },
  { id: "30days", label: "Last 30 days" }, { id: "month", label: "This month" },
  { id: "all", label: "All (last 6 months)" }, { id: "lifetime", label: "Lifetime" },
  { id: "custom", label: "Custom dates" },
];
const control = "min-h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const button = "min-h-10 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
function FeatureInputs({ feature, values, onChange }: { feature: FeatureDefinition; values: Record<string, string>; onChange: (key: string, value: string) => void }) {
  return <div className="grid gap-3 sm:grid-cols-2">{feature.fields?.map((field) => <label key={field.key} className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted-foreground">
    {field.label}{field.type === "multiline" ? <textarea className={`${control} min-h-24 py-2`} value={values[field.key] ?? ""} onChange={(event) => onChange(field.key, event.target.value)} aria-required={field.required} /> : field.type === "select" ? <select className={control} value={values[field.key] ?? ""} required={field.required} onChange={(event) => onChange(field.key, event.target.value)}><option value="">Choose…</option>{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input className={control} type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"} step={field.type === "number" ? "any" : undefined} required={field.required} value={values[field.key] ?? ""} onChange={(event) => onChange(field.key, event.target.value)} />}
    {field.hint && <span className="font-normal">{field.hint}</span>}
  </label>)}</div>;
}

export function ParityDashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [machineError, setMachineError] = useState<string | null>(null);
  const [machineAttempt, setMachineAttempt] = useState(0);
  const [hostId, setHostId] = useState("");
  const [pane, setPane] = useState<Pane>("reports");
  const [period, setPeriod] = useState<PeriodSelection>("30days");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [provider, setProvider] = useState("all");
  const [projects, setProjects] = useState("");
  const [excludes, setExcludes] = useState("");
  const [report, setReport] = useState<ReportName>("overview");
  const [params, setParams] = useState<Record<string, string>>({});
  const [reportResult, setReportResult] = useState<ReportReply | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState<ActionName>("currency-set");
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOutput, setActionOutput] = useState<{ stdout: string; stderr: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [scopeEpoch, setScopeEpoch] = useState(0);
  const reportEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const initialHost = useRef("");
  useEffect(() => () => {
    reportEpoch.current++;
    actionEpoch.current++;
  }, []);
  const selectedMachine = machines?.find((machine) => machine.id === hostId && machine.connected);
  const connected = machines?.filter((machine) => machine.connected) ?? [];
  const currentReport: FeatureDefinition = REPORTS.find((entry) => entry.id === report) ?? REPORTS[0];
  const currentAction: FeatureDefinition = ACTIONS.find((entry) => entry.id === action) ?? ACTIONS[0];

  useEffect(() => {
    let cancelled = false;
    setMachineError(null);
    rpc.call("codeburnMachines", null).then(({ machines: next }) => {
      if (cancelled) return;
      resetSelection();
      setMachines(next);
      const available = next.filter((machine) => machine.connected);
      setHostId((current) => available.some((machine) => machine.id === current) ? current : (current || initialHost.current) ? "" : available.length === 1 ? available[0].id : "");
    }, (cause: unknown) => {
      if (cancelled) return;
      resetSelection();
      setMachines(null);
      setMachineError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [rpc, machineAttempt]);

  function clearAction() {
    actionEpoch.current++;
    setPreview(null);
    setActionError(null);
    setActionOutput(null);
    setActionBusy(false);
  }
  function resetSelection() {
    reportEpoch.current++;
    setReportResult(null);
    setReportError(null);
    setReportBusy(false);
    setSearch("");
    clearAction();
    setScopeEpoch((current) => current + 1);
  }
  function currentScope(scoped = true, dated = true): ReportScope {
    const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!scoped) return scopeSchema.parse({ period: period === "custom" ? "30days" : period });
    return scopeSchema.parse({ period: period === "custom" ? "30days" : period, ...(dated && period === "custom" ? { range: { from, to } } : {}), provider: provider.trim() || "all", project: lines(projects), exclude: lines(excludes) });
  }
  async function load(options: { report: ReportName; params: Record<string, string>; focus?: string[]; page?: number; search?: string; snapshot?: string; refresh: boolean }) {
    const machine = selectedMachine;
    if (!machine) { setReportError("Select a connected machine before running a report."); return; }
    const generation = ++reportEpoch.current;
    setReportBusy(true);
    setReportError(null);
    setReportResult(null);
    try {
      if (options.report === "devices" && period === "custom") {
        throw new Error("Paired devices supports preset periods only; select a preset instead of custom dates.");
      }
      const definition: FeatureDefinition = REPORTS.find((entry) => entry.id === options.report) ?? REPORTS[0];
      const dated = options.report !== "period-comparison" && options.report !== "period-sessions";
      const query: ReportQuery = reportQuerySchema.parse({
        ...currentScope(definition.scoped === true, dated), report: options.report, params: options.params,
        focus: options.focus ?? [], page: options.page ?? 0, search: options.search ?? "",
        ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }), refresh: options.refresh,
      });
      const next = await rpc.call("codeburnReport", { ...query, hostId: machine.id });
      if (reportEpoch.current !== generation) return;
      setReportResult(next);
      setSearch(query.search);
    } catch (cause: unknown) {
      if (reportEpoch.current !== generation) return;
      setReportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (reportEpoch.current === generation) setReportBusy(false);
    }
  }

  useEffect(() => {
    if (connected.length !== 1 || !selectedMachine || initialHost.current) return;
    initialHost.current = selectedMachine.id;
    if (report === "overview") void load({ report: "overview", params: {}, refresh: true });
    // Initial report is intentionally a one-shot after the unique machine connects.
  }, [selectedMachine?.id, connected.length, report]);

  function setScopePart(update: () => void) { resetSelection(); update(); }
  function changeReport(next: ReportName) { resetSelection(); setReport(next); setParams({}); }
  function navigate(path: string[]) {
    if (reportResult) void load({ report, params, focus: path, search: "", snapshot: reportResult.snapshot, refresh: false });
  }
  function sessionDiagnosis(id: string) {
    changeReport("session-why");
    const next = { sessionId: id };
    setParams(next);
    void load({ report: "session-why", params: next, refresh: true });
  }
  function comparedSessions(dimension: "project" | "model", key: string) {
    const dates = Object.fromEntries(["fromA", "toA", "fromB", "toB"].map((field) => [field, params[field] ?? ""]));
    const next = { ...dates, dimension, key };
    changeReport("period-sessions");
    setParams(next);
    void load({ report: "period-sessions", params: next, refresh: true });
  }
  async function previewChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMachine) return;
    const machine = selectedMachine.id;
    const generation = ++actionEpoch.current;
    setPreview(null);
    setActionOutput(null);
    setActionError(null);
    setActionBusy(true);
    try {
      const query = actionQuerySchema.parse({ action, values });
      const next = await rpc.call("codeburnPreviewAction", { ...query, hostId: machine });
      if (actionEpoch.current === generation) setPreview(next);
    } catch (cause: unknown) {
      if (actionEpoch.current === generation) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (actionEpoch.current === generation) setActionBusy(false);
    }
  }
  async function confirmChange() {
    if (!preview || !selectedMachine || actionBusy) return;
    const ticket = preview.ticket;
    const machine = selectedMachine.id;
    const generation = ++actionEpoch.current;
    setPreview(null);
    setActionError(null);
    setActionBusy(true);
    try {
      const output = await rpc.call("codeburnConfirmAction", { hostId: machine, ticket });
      if (actionEpoch.current !== generation) return;
      setActionOutput(output);
      reportEpoch.current++;
      setReportResult(null);
      setReportError(null);
      setSearch("");
      void load({ report, params, refresh: true });
    } catch (cause: unknown) {
      if (actionEpoch.current === generation) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (actionEpoch.current === generation) setActionBusy(false);
    }
  }
  let scope: ReportScope | null = null;
  let scopeError: string | null = null;
  try { scope = currentScope(); } catch (cause: unknown) { scopeError = cause instanceof Error ? cause.message : String(cause); }

  return <main data-burn-source="codeburn" data-burn-view="machine-reports" className="h-full min-h-0 flex-1 overflow-y-auto bg-background text-foreground">
    <div className="mx-auto box-border w-full max-w-6xl px-4 pb-10 pt-5 sm:px-6 lg:px-8">
      <header className="mb-5 border-b border-border pb-4"><h1 className="text-2xl font-semibold tracking-tight">CodeBurn</h1><p className="mt-1 text-sm text-muted-foreground">Native, on-demand CLI reporting · selected machine: {selectedMachine?.name ?? "none"}</p><p className="mt-2 text-xs text-muted-foreground">CLI-accounted estimates, not invoices. Machine-wide usage may overlap with Burn; do not add totals together.</p></header>
      <label className="mb-4 flex max-w-sm flex-col gap-1 text-xs font-medium text-muted-foreground">Connected machine
        <select className={control} value={selectedMachine?.id ?? ""} disabled={!machines || connected.length === 0 || actionBusy} onChange={(event) => { resetSelection(); initialHost.current = "selected"; setHostId(event.target.value); }}><option value="">{connected.length > 1 ? "Choose a machine" : "No connected machine"}</option>{machines?.map((machine) => <option key={machine.id} disabled={!machine.connected} value={machine.id}>{machine.name}{machine.connected ? "" : " (offline)"}</option>)}</select>
      </label>
      {machineError && <p role="alert" className="mb-4 text-sm text-destructive">Machine list failed: {machineError} <button type="button" className="underline" onClick={() => setMachineAttempt((value) => value + 1)}>Retry</button></p>}
      {machines && !connected.length && <p role="status" className="mb-4 text-sm text-muted-foreground">No connected machines. <button type="button" className="underline" onClick={() => setMachineAttempt((value) => value + 1)}>Retry machine list</button></p>}
      <nav aria-label="CodeBurn sections" className="mb-5 flex flex-wrap gap-2 border-b border-border pb-3">{([ ["reports", "Reports"], ["configuration", "Configuration"], ["exports", "Exports"] ] as const).map(([id, title]) => <button key={id} type="button" disabled={actionBusy} className={`${button} ${pane === id ? "border-primary font-semibold" : ""}`} aria-current={pane === id ? "page" : undefined} onClick={() => setPane(id)}>{title}</button>)}</nav>
      <section aria-label="Report and export scope" className="mb-6 space-y-3 border-b border-border pb-5">
        <h2 className="text-base font-semibold">Scope</h2>
        <fieldset disabled={actionBusy} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label className="flex flex-col gap-1 text-xs text-muted-foreground">Local-calendar period<select className={control} value={period} onChange={(event) => setScopePart(() => setPeriod(event.target.value as PeriodSelection))}>{periods.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label className="flex flex-col gap-1 text-xs text-muted-foreground">Provider (all by default)<input className={control} value={provider} onChange={(event) => setScopePart(() => setProvider(event.target.value))} /></label>
          {period === "custom" && <><label className="flex flex-col gap-1 text-xs text-muted-foreground">From<input type="date" className={control} value={from} onChange={(event) => setScopePart(() => setFrom(event.target.value))} /></label><label className="flex flex-col gap-1 text-xs text-muted-foreground">To<input type="date" className={control} value={to} onChange={(event) => setScopePart(() => setTo(event.target.value))} /></label></>}
          <details className="sm:col-span-2 lg:col-span-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">{projects || excludes ? "Project filters (temporary filters active)" : "Project filters (optional)"}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">Temporary included projects (one pattern per line)<textarea className={`${control} min-h-20 py-2`} value={projects} onChange={(event) => setScopePart(() => setProjects(event.target.value))} /></label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">Temporary excluded projects (one pattern per line)<textarea className={`${control} min-h-20 py-2`} value={excludes} onChange={(event) => setScopePart(() => setExcludes(event.target.value))} /></label>
            </div>
          </details>
        </fieldset>
        <p className="text-xs text-muted-foreground">Saved project visibility applies to scoped reports and exports. Account-wide reports ignore project/provider selections; their descriptions identify this. Preset periods ignore hidden custom dates.</p>
        {scopeError && (pane === "exports" || currentReport.scoped === true && report !== "period-comparison" && report !== "period-sessions") && <p role="alert" className="text-sm text-destructive">Invalid scope: {scopeError}</p>}
      </section>
      {!selectedMachine && !machineError && <p role="status" className="text-sm text-muted-foreground">Select a connected machine to run CLI commands. No other machine is queried automatically.</p>}
      {pane === "reports" && <section aria-label="CLI reports" className="space-y-4">
        <div><label className="flex max-w-lg flex-col gap-1 text-xs font-medium text-muted-foreground">Report<select className={control} value={report} onChange={(event) => changeReport(event.target.value as ReportName)}>{[...new Set(REPORTS.map((item) => item.group))].map((group) => <optgroup key={group} label={group}>{REPORTS.filter((item) => item.group === group).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}</select></label><p className="mt-2 text-sm text-muted-foreground">{currentReport.description}</p><p className="mt-1 text-xs text-muted-foreground">{currentReport.scoped ? report === "overview" || report === "timeline" ? "Selected period scopes current summaries. Native history spans available dates; provider/project filters still apply." : "Scoped by selected period, provider and project visibility." : "Account-wide or unscoped: selected project/provider filters do not narrow this report."}</p></div>
        <FeatureInputs feature={currentReport} values={params} onChange={(key, value) => { resetSelection(); setParams((existing) => ({ ...existing, [key]: value })); }} />
        <button type="button" className={button} disabled={!selectedMachine || !!scopeError && currentReport.scoped === true && report !== "period-comparison" && report !== "period-sessions" || reportBusy} onClick={() => void load({ report, params, refresh: true })}>{reportResult ? "Refresh report" : "Run report"}</button>
        {reportBusy && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Running {currentReport.label} on {selectedMachine?.name}…</p>}
        {reportError && <p role="alert" className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive">{reportError} {/expired|snapshot/i.test(reportError) && <button type="button" className="ml-2 underline" onClick={() => void load({ report, params, refresh: true })}>Refresh from CLI</button>}</p>}
        {reportResult && selectedMachine && <ParityData key={reportResult.snapshot + JSON.stringify(reportResult.focus)} result={reportResult} search={search} busy={reportBusy} onNavigate={navigate} onPage={(page) => void load({ report, params, focus: reportResult.focus, page, search, snapshot: reportResult.snapshot, refresh: false })} onSearch={(value) => void load({ report, params, focus: reportResult.focus, search: value, snapshot: reportResult.snapshot, refresh: false })} onSession={sessionDiagnosis} onPeriodSessions={comparedSessions} />}
      </section>}
      {pane === "configuration" && <section aria-label="Configuration changes" className="space-y-4"><div><h2 className="text-lg font-semibold">Configuration</h2><p className="text-sm text-muted-foreground">Preview before changing the selected machine. No change is made by choosing an option.</p></div>
        <form onSubmit={(event) => void previewChange(event)} className="space-y-4"><fieldset disabled={actionBusy} className="space-y-4"><label className="flex max-w-lg flex-col gap-1 text-xs font-medium text-muted-foreground">Change<select className={control} value={action} onChange={(event) => { clearAction(); setAction(event.target.value as ActionName); setValues({}); }}>{[...new Set(ACTIONS.map((item) => item.group))].map((group) => <optgroup key={group} label={group}>{ACTIONS.filter((item) => item.group === group).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}</select></label><p className="text-sm text-muted-foreground">{currentAction.description}</p><FeatureInputs feature={currentAction} values={values} onChange={(key, value) => { clearAction(); setValues((existing) => ({ ...existing, [key]: value })); }} /><button type="submit" className={button} disabled={!selectedMachine}>Preview change</button></fieldset></form>
        {actionBusy && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Waiting for CodeBurn on {selectedMachine?.name}…</p>}
        {preview && selectedMachine && <div className="space-y-3 rounded-md border border-border p-4 text-sm"><h3 className="font-semibold">Confirm on {selectedMachine.name}</h3><p>{preview.description}</p><p className="text-xs text-muted-foreground">Preview expires {new Date(preview.expiresAt).toLocaleString()}</p><div className="max-w-full overflow-x-auto rounded bg-muted p-3 font-mono text-xs" aria-label="Exact command arguments">{preview.command.map((arg, index) => <span key={index} className="mr-2 inline-block break-all">{JSON.stringify(arg)}</span>)}</div><div className="flex gap-2"><button type="button" className={button} disabled={actionBusy} onClick={() => void confirmChange()}>Confirm change</button><button type="button" className={button} disabled={actionBusy} onClick={clearAction}>Cancel</button></div></div>}
        {actionError && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">Change failed: {actionError}</p>}
        {actionOutput && <div role="status" className="rounded-md border border-border p-3 text-sm"><h3 className="font-semibold">CLI result from {selectedMachine?.name}</h3><pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{actionOutput.stdout || "No stdout returned."}</pre>{actionOutput.stderr && <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs text-destructive">stderr: {actionOutput.stderr}</pre>}</div>}
      </section>}
      {pane === "exports" && selectedMachine && scope && <ParityExports key={`${selectedMachine.id}-${scopeEpoch}`} hostId={selectedMachine.id} scope={scope} />}
      {pane === "exports" && (!selectedMachine || !scope) && <p role="status" className="text-sm text-muted-foreground">Choose a connected machine and valid scope to create an export.</p>}
    </div>
  </main>;
}
