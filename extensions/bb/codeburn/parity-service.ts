import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { BigIntStats } from "node:fs";
import {
  ACTIONS, REPORTS, actionQuerySchema, dateRangeSchema, executableSchema, exportEndSchema,
  exportReadSchema, exportStartSchema, reportQuerySchema, type ActionQuery,
  type ActionPreview, type ExportLease, type ExportQuery, type ReportQuery,
  type ReportReply, type ReportScope,
} from "./parity-contract.js";
import {
  mergeProjectFilter, normalizePatterns, normalizeProjectFilter, projectFilterArgs, projectFilterPath,
  readProjectFilter, writeProjectFilter,
} from "./project-filter.js";

const execute = promisify(execFile);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK = 1024 * 1024;
const TIMEOUT = 90_000;
const SNAPSHOT_TTL = 5 * 60_000;
const TICKET_TTL = 60_000;
const PAGE_SIZE = 50;
const unsafeKeys: Record<string, boolean> = { ["__proto__"]: true, prototype: true, constructor: true };
const planProviders: Record<string, true> = { all: true, claude: true, codex: true, cursor: true, grok: true, copilot: true, antigravity: true };
const planIds: Record<string, true> = {
  "claude-pro": true, "claude-max": true, "claude-max-5x": true, "cursor-pro": true,
  supergrok: true, "supergrok-heavy": true, "copilot-pro": true, "copilot-pro-plus": true,
  "copilot-max": true, "google-ai-pro": true, "google-ai-ultra-5x": true,
  "google-ai-ultra-20x": true, custom: true, none: true,
};
const planProvider: Record<string, string> = {
  "claude-pro": "claude", "claude-max": "claude", "claude-max-5x": "claude",
  "cursor-pro": "cursor", supergrok: "grok", "supergrok-heavy": "grok",
  "copilot-pro": "copilot", "copilot-pro-plus": "copilot", "copilot-max": "copilot",
  "google-ai-pro": "antigravity", "google-ai-ultra-5x": "antigravity", "google-ai-ultra-20x": "antigravity",
};
const token = () => randomBytes(24).toString("base64url");
type Payload = null | boolean | number | string | Payload[] | { [key: string]: Payload };
type Snapshot = { id: string; key: string; data: Payload; generated: string; at: number; sequence: number };
type Ticket = { cliPath: string; args: readonly string[]; expires: number; filter?: { project: string[]; exclude: string[] } };
type LeasedFile = { path: string; size: number; mime: string; dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint };
type Lease = { cliPath: string; directory: string; files: Map<string, LeasedFile>; expires: number };
type ExportChunk = { base64: string; nextOffset: number; totalSize: number; eof: boolean };

function verifyExportFile(info: BigIntStats, file: LeasedFile): void {
  if (!info.isFile() || info.isSymbolicLink() || info.size !== BigInt(file.size) ||
      info.dev !== file.dev || info.ino !== file.ino || info.mtimeNs !== file.mtimeNs || info.ctimeNs !== file.ctimeNs) {
    throw new Error("CodeBurn export file changed or is not regular");
  }
}

async function requireSharingIdentity(home: string): Promise<void> {
  try {
    for (const name of ["device-key.pem", "device-cert.pem"]) {
      const info = await stat(join(home, ".config", "codeburn", "sharing", name));
      if (!info.isFile()) throw new Error("Sharing identity is not a regular file");
    }
  } catch (error) {
    throw new Error("CodeBurn sharing identity is not initialized. Use Configuration → Initialize sharing identity; a report will not create credentials.", { cause: error });
  }
}

function ensureActive(signal: AbortSignal, disposed: boolean): void {
  if (disposed) throw new Error("CodeBurn parity service has been disposed");
  if (signal.aborted) throw new Error("CodeBurn request was cancelled");
}
function localDate(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}
export function exportDateWindow(scope: ReportScope, now: number): { from: string; to: string } {
  if (scope.range) return scope.range;
  const day = new Date(now);
  if (!Number.isFinite(day.getTime())) throw new Error("Invalid clock for export date window");
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  switch (scope.period) {
    case "today": break;
    case "week": from.setDate(from.getDate() - 7); break;
    case "30days": from.setDate(from.getDate() - 30); break;
    case "month": from.setDate(1); break;
    case "all": from.setFullYear(day.getFullYear(), day.getMonth() - 6, 1); break;
    case "lifetime": return { from: "1970-01-01", to: localDate(day) };
  }
  return { from: localDate(from), to: localDate(day) };
}
function scopeArgs(scope: ReportScope, filter: { project: string[]; exclude: string[] }, allowRange = true): string[] {
  if (!allowRange && scope.range) throw new Error("Custom date ranges are not supported by this CodeBurn report");
  return ["--period", scope.period, ...(scope.range ? ["--from", scope.range.from, "--to", scope.range.to] : []),
    ...(scope.provider === "all" ? [] : ["--provider", scope.provider]), ...projectFilterArgs(filter)];
}
function accountScope(scope: ReportScope): void {
  if (scope.provider !== "all" || scope.project.length || scope.exclude.length || scope.range) {
    throw new Error("Account-wide report does not support provider, project, exclude or custom date filters");
  }
}
function parameters(input: ReportQuery, allowed: readonly string[]): Record<string, string> {
  for (const key of Object.keys(input.params)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported ${input.report} parameter: ${key}`);
  }
  return input.params;
}
function requireText(value: string | undefined, field: string): string {
  if (!value?.trim() || value.includes("\0") || value.trim().startsWith("-")) throw new Error(`Invalid ${field}`);
  return value.trim();
}
function exactIdentity(value: string | undefined, field: string): string {
  if (!value || value.includes("\0")) throw new Error(`Invalid ${field}`);
  return value;
}
function periodDates(params: Record<string, string>): string[] {
  const dates = dateRangeSchema.parse({ from: params.fromA, to: params.toA });
  const datesB = dateRangeSchema.parse({ from: params.fromB, to: params.toB });
  return ["--from-a", dates.from, "--to-a", dates.to, "--from-b", datesB.from, "--to-b", datesB.to];
}
function commandFor(input: ReportQuery, filter: { project: string[]; exclude: string[] }): { commands: string[][]; note: string } {
  const scoped = (...args: string[]) => [...args, ...scopeArgs(input, filter)];
  const fixed = (args: string[], note = "Native CodeBurn CLI result") => ({ commands: [args], note });
  switch (input.report) {
    case "overview": case "timeline":
      parameters(input, []);
      return fixed(scoped("status", "--format", "menubar-json", "--no-optimize", ...(input.report === "overview" ? ["--no-timeline"] : [])), "Native current summary uses the selected period; history spans available dates. Provider/project filters still apply");
    case "models": {
      const p = parameters(input, ["breakdown"]);
      if (p.breakdown && !["model", "task", "agent"].includes(p.breakdown)) throw new Error("Invalid models breakdown");
      return fixed(scoped("models", "--format", "json", "--min-cost", "0", ...(p.breakdown && p.breakdown !== "model" ? [`--by-${p.breakdown}`] : [])));
    }
    case "sessions": parameters(input, []); return fixed(scoped("sessions", "--format", "json", "--contributions"));
    case "session-why": {
      const p = parameters(input, ["sessionId"]);
      if (!["all", "claude"].includes(input.provider) || input.project.length || input.exclude.length || input.range) {
        throw new Error("Claude session diagnosis does not support this provider, project or date scope");
      }
      return fixed(["sessions", "--id", requireText(p.sessionId, "Claude session ID"), "--why", "--format", "json"], "Claude Code transcript diagnosis only");
    }
    case "pull-requests": parameters(input, []); return fixed(scoped("sessions", "--by-pr", "--format", "json"));
    case "flow": case "branches": parameters(input, []); return fixed(scoped("spend", "--format", input.report === "flow" ? "flow-json" : "branch-json"));
    case "yield": parameters(input, []); return fixed(["yield", "--format", "json", ...scopeArgs(input, filter, false)]);
    case "model-comparison": case "cohort-comparison": {
      const p = parameters(input, input.report === "cohort-comparison" ? ["modelA", "modelB", "projectId", "category"] : ["modelA", "modelB"]);
      if (Boolean(p.modelA) !== Boolean(p.modelB)) throw new Error("Both comparison models must be supplied together");
      const args = scoped("compare", "--format", input.report === "model-comparison" ? "json" : "cohort-json");
      if (p.modelA) args.push("--model-a", requireText(p.modelA, "model A"), "--model-b", requireText(p.modelB, "model B"));
      if (p.projectId) args.push(`--project-id=${exactIdentity(p.projectId, "project identity")}`);
      if (p.category) {
        const validCategories = ["coding", "debugging", "feature", "refactoring", "testing", "exploration",
          "planning", "delegation", "git", "build/deploy", "conversation", "brainstorming", "general"];
        if (!validCategories.includes(p.category)) throw new Error("Invalid cohort activity category");
        args.push("--category", p.category);
      }
      return fixed(args);
    }
    case "period-comparison": case "period-sessions": {
      const p = parameters(input, input.report === "period-sessions" ? ["fromA", "toA", "fromB", "toB", "dimension", "key"] : ["fromA", "toA", "fromB", "toB"]);
      if (input.range) throw new Error("Period comparison uses explicit A/B dates; remove global custom range");
      const args = ["compare-periods", "--format", input.report === "period-sessions" ? "sessions" : "json", ...periodDates(p),
        ...(input.provider === "all" ? [] : ["--provider", input.provider]), ...projectFilterArgs(filter)];
      if (input.report === "period-sessions") {
        if (p.dimension !== "project" && p.dimension !== "model") throw new Error("Invalid comparison dimension");
        args.push("--dimension", p.dimension, `--key=${exactIdentity(p.key, "comparison key")}`);
      }
      return fixed(args, "Explicit A/B local-calendar ranges; global period is not used");
    }
    case "plans": parameters(input, []); accountScope(input);
      return { commands: [["plan", "show", "--format", "json"], ["status", "--format", "json"]], note: "Account-wide configured plan and native subscription usage" };
    case "quota": parameters(input, []); accountScope(input); return fixed(["quota", "--format", "json"], "Account-wide live quota; explicit request may contact providers");
    case "optimize": parameters(input, []); return fixed(scoped("optimize", "--format", "json"));
    case "actions": parameters(input, []); accountScope(input); return fixed(["act", "report", "--json"], "Account-wide measured applied actions");
    case "audit": parameters(input, []); return fixed(scoped("audit", "--format", "json"));
    case "doctor": parameters(input, []); accountScope(input); return fixed(["doctor", "--json"]);
    case "aliases": case "prices": case "proxy-paths": {
      parameters(input, []); accountScope(input);
      const command = input.report === "aliases" ? "model-alias" : input.report === "prices" ? "price-override" : "proxy-path";
      return fixed([command, "--list", "--format", "json"]);
    }
    case "project-filter": parameters(input, []); accountScope(input);
      return { commands: [], note: "Saved CodeBurn desktop project visibility" };
    case "devices": parameters(input, []); accountScope(input);
      if (input.range) throw new Error("Custom device report date ranges are unsupported");
      return fixed(["devices", "--format", "json", "--period", input.period], "Account-wide device usage; project/provider filters do not apply");
    case "device-scan": parameters(input, []); accountScope(input); return fixed(["devices", "scan", "--format", "json"], "Explicit local network device discovery");
    case "identity": parameters(input, []); accountScope(input); return fixed(["identity", "--format", "json"]);
    case "share-status": parameters(input, []); accountScope(input); return fixed(["share", "status", "--format", "json"]);
  }
}
function limited(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max)}…`; }
function previewValue(value: Payload, depth = 0): Payload {
  if (typeof value === "string") return limited(value, 300);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 2) return Array.isArray(value) ? `[Array: ${value.length} items]` : `[Object: ${Object.keys(value).length} fields]`;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => previewValue(item, depth + 1));
  const object: Record<string, Payload> = {};
  for (const key of Object.keys(value).slice(0, 30)) {
    if (!Object.hasOwn(unsafeKeys, key)) object[key] = previewValue(value[key]!, depth + 1);
  }
  return object;
}
function navigate(data: Payload, focus: string[]): Payload {
  let current = data;
  for (const part of focus) {
    if (Object.hasOwn(unsafeKeys, part)) throw new Error("Invalid prototype path");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= current.length) throw new Error("Invalid array path");
      current = current[Number(part)]!;
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, part)) {
      current = current[part]!;
    } else throw new Error("Invalid report field path");
  }
  return current;
}
function explore(snapshot: Snapshot, input: ReportQuery, note: string): ReportReply {
  const focus = input.focus;
  const node = navigate(snapshot.data, focus);
  const entries = node !== null && typeof node === "object" && !Array.isArray(node)
    ? Object.entries(node).filter(([name]) => !Object.hasOwn(unsafeKeys, name)) : [];
  const term = input.search.trim().toLocaleLowerCase();
  const objectTable = entries.length > PAGE_SIZE;
  const matchingFields = objectTable && term ? entries.filter(([name]) => name.toLocaleLowerCase().includes(term)) : entries;
  const values = Array.isArray(node) ? node : [];
  const matching: number[] = [];
  for (let index = 0; index < values.length; index++) {
    if (!term || JSON.stringify(values[index]).toLocaleLowerCase().includes(term)) matching.push(index);
  }
  const totalRows = objectTable ? matchingFields.length : matching.length;
  const page = Math.min(input.page, Math.max(0, Math.ceil(totalRows / PAGE_SIZE) - 1));
  const visibleFields = objectTable ? matchingFields.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : entries;
  const fields: ReportReply["fields"] = visibleFields.map(([name, value]): ReportReply["fields"][number] => {
    if (name.length > 4096) throw new Error("CodeBurn report field name exceeds the navigation limit");
    const path = [...focus, name];
    if (Array.isArray(value)) return { name, path, kind: "array", count: value.length };
    if (value !== null && typeof value === "object") return { name, path, kind: "object", count: Object.keys(value).length };
    return { name, path, kind: "value", value: typeof value === "string" ? limited(value, 1024) : value };
  });
  if (node === null || typeof node !== "object") fields.push({
    name: "value", path: focus, kind: "value", value: typeof node === "string" ? limited(node, 1024) : node,
  });
  const indexes = matching.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = objectTable
    ? visibleFields.map(([name, value]) => ({ name, value: previewValue(value) }))
    : indexes.map((index) => {
      const value = values[index]!;
      const row = value !== null && typeof value === "object" && !Array.isArray(value)
        ? previewValue(value) as Record<string, Payload> : { value: previewValue(value) };
      if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.key === "string" && value.key.length <= 4096) {
        row.key = value.key;
      }
      if (Buffer.byteLength(JSON.stringify(row)) > 16 * 1024) return { value: "[Row too large to preview; open Details for original fields]" };
      return row;
    });
  const reply: ReportReply = {
    report: input.report, snapshot: snapshot.id, generated: snapshot.generated, focus, fields, rows,
    rowPaths: objectTable ? visibleFields.map(([name]) => [...focus, name]) : indexes.map((index) => [...focus, String(index)]),
    columns: [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 200),
    totalRows, page, pageSize: PAGE_SIZE, scopeNote: note,
  };
  if (Buffer.byteLength(JSON.stringify(reply)) > 1_900_000) throw new Error("CodeBurn report view exceeds the 2 MiB transport bound; select a narrower path or search");
  return reply;
}
function numberValue(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${field} rate`);
  return String(parsed);
}
function actionCommand(input: ActionQuery, home: string): { args: string[]; filter?: Ticket["filter"] } {
  const values = input.values;
  const definition = ACTIONS.find((item) => item.id === input.action)!;
  const accepted: readonly string[] = "fields" in definition ? definition.fields.map((field) => field.key) : [];
  for (const key of Object.keys(values)) if (!accepted.includes(key)) throw new Error(`Unsupported ${input.action} value: ${key}`);
  const field = (key: string) => requireText(values[key], key);
  switch (input.action) {
    case "currency-set": {
      const code = field("code");
      if (!/^[A-Z]{3}$/.test(code)) throw new Error("Invalid ISO currency code");
      return { args: ["currency", code] };
    }
    case "currency-reset": return { args: ["currency", "--reset"] };
    case "alias-set": return { args: ["model-alias", field("from"), field("to")] };
    case "alias-remove": return { args: ["model-alias", `--remove=${field("from")}`] };
    case "price-set": {
      const inputRate = numberValue(values.input, "input");
      const outputRate = numberValue(values.output, "output");
      const cacheRead = numberValue(values.cacheRead, "cacheRead");
      const cacheCreation = numberValue(values.cacheCreation, "cacheCreation");
      if (inputRate === undefined || outputRate === undefined) throw new Error("Both input and output price rates are required");
      return { args: ["price-override", field("model"), "--input", inputRate, "--output", outputRate,
        ...(cacheRead === undefined ? [] : ["--cache-read", cacheRead]), ...(cacheCreation === undefined ? [] : ["--cache-creation", cacheCreation])] };
    }
    case "price-remove": return { args: ["price-override", `--remove=${field("model")}`] };
    case "plan-set": {
      const id = field("id"); const provider = field("provider");
      if (!Object.hasOwn(planIds, id) || id === "none" || !Object.hasOwn(planProviders, provider)) throw new Error("Invalid plan id or provider");
      if (planProvider[id] && provider !== planProvider[id]) throw new Error("Plan preset does not match provider");
      const resetDay = values.resetDay === undefined || values.resetDay.trim() === "" ? undefined : Number(values.resetDay);
      if (resetDay !== undefined && (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28)) throw new Error("Invalid plan reset day (1–28)");
      const monthlyUsd = numberValue(values.monthlyUsd, "monthlyUsd");
      const credits = numberValue(values.credits, "credits");
      if (id !== "custom" && (monthlyUsd !== undefined || credits !== undefined)) throw new Error("Custom prices require the custom plan");
      if (id === "custom" && provider === "copilot" && (credits === undefined || Number(credits) <= 0 || monthlyUsd !== undefined)) throw new Error("Custom Copilot plan requires positive credits, not monthly USD");
      if (id === "custom" && provider !== "copilot" && (monthlyUsd === undefined || Number(monthlyUsd) <= 0 || credits !== undefined)) throw new Error("Custom plan requires positive monthly USD");
      return { args: ["plan", "set", id, "--provider", provider,
        ...(monthlyUsd === undefined ? [] : ["--monthly-usd", monthlyUsd]), ...(credits === undefined ? [] : ["--credits", credits]),
        ...(resetDay === undefined ? [] : ["--reset-day", String(resetDay)])] };
    }
    case "plan-reset": {
      const provider = field("provider");
      if (!Object.hasOwn(planProviders, provider)) throw new Error("Invalid plan provider");
      return { args: ["plan", "reset", "--provider", provider] };
    }
    case "project-filter-set": {
      const filter = normalizeProjectFilter({ project: values.project?.split(/\r?\n/) ?? [], exclude: values.exclude?.split(/\r?\n/) ?? [] }, home);
      if (filter.project.length > 100 || filter.exclude.length > 100) throw new Error("Too many project filter patterns");
      return { args: [], filter };
    }
    case "device-remove": return { args: ["devices", "rm", field("name")] };
    case "sharing-initialize": return { args: ["identity", "--format", "json"] };
  }
}

export function createParityService(options: {
  home?: string;
  now?: () => number;
  run?: (cliPath: string, args: string[], signal: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
} = {}) {
  const home = options.home ?? homedir();
  const cliEnv = {
    ...process.env,
    ...(options.home ? { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), CODEBURN_CACHE_DIR: join(home, ".cache", "codeburn") } : {}),
    CODEBURN_CURSOR_SYNC: "0",
  };
  const now = options.now ?? Date.now;
  const snapshots = new Map<string, Snapshot>();
  const tickets = new Map<string, Ticket>();
  const leases = new Map<string, Lease>();
  const active = new Set<AbortController>();
  const running = new Set<Promise<void>>();
  const pendingExports = new Set<Promise<void>>();
  let exportReservations = 0;
  let pendingMutations = 0;
  let configurationVersion = 0;
  let mutationTail: Promise<void> = Promise.resolve();
  let disposed = false;
  let sequence = 0;
  const checkConfiguration = (version: number) => {
    if (pendingMutations > 0 || version !== configurationVersion) {
      throw new Error("CodeBurn configuration changed or is being changed; refresh after the confirmed change settles");
    }
  };
  const expired = async () => {
    for (const [id, entry] of snapshots) if (entry.at > now() || now() - entry.at >= SNAPSHOT_TTL) snapshots.delete(id);
    for (const [id, entry] of tickets) if (entry.expires <= now()) tickets.delete(id);
    for (const [id, entry] of leases) if (entry.expires <= now()) { leases.delete(id); await rm(entry.directory, { recursive: true, force: true }); }
  };
  const run = async (cliPath: string, args: string[], signal: AbortSignal) => {
    ensureActive(signal, disposed);
    if (active.size >= 2) throw new Error("CodeBurn CLI is busy; wait for the current requests to finish");
    const completed = Promise.withResolvers<void>();
    running.add(completed.promise);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    active.add(controller);
    try {
      ensureActive(signal, disposed);
      const result = options.run
        ? await options.run(cliPath, args, controller.signal)
        : await execute(cliPath, args, { shell: false, encoding: "utf8", maxBuffer: MAX_BYTES, timeout: TIMEOUT, signal: controller.signal, env: cliEnv });
      ensureActive(signal, disposed);
      return result;
    } catch (error) {
      if (signal.aborted || disposed || controller.signal.aborted) throw new Error("CodeBurn request was cancelled", { cause: error });
      throw new Error(`CodeBurn command failed (${basename(cliPath)} ${args.join(" ")}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      signal.removeEventListener("abort", abort);
      active.delete(controller);
      running.delete(completed.promise);
      completed.resolve();
    }
  };
  const json = async (cliPath: string, args: string[], signal: AbortSignal): Promise<Payload> => {
    const { stdout } = await run(cliPath, args, signal);
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (parsed === undefined || typeof parsed === "number" && !Number.isFinite(parsed)) throw new Error("Invalid JSON value");
      return parsed as Payload;
    } catch (error) {
      throw new Error(`CodeBurn returned malformed JSON for ${args[0]}`, { cause: error });
    }
  };
  return {
    async report(raw: ReportQuery & { cliPath: string }, signal: AbortSignal): Promise<ReportReply> {
      ensureActive(signal, disposed); await expired();
      const version = configurationVersion;
      checkConfiguration(version);
      const { cliPath, ...rest } = raw;
      executableSchema.parse(cliPath);
      const input = reportQuerySchema.parse(rest);
      const saved = await readProjectFilter(home);
      checkConfiguration(version);
      if (["devices", "device-scan", "identity", "share-status"].includes(input.report)) {
        await requireSharingIdentity(home);
        checkConfiguration(version);
      }
      const feature = REPORTS.find((item) => item.id === input.report);
      const scoped = feature !== undefined && "scoped" in feature && feature.scoped === true;
      const filter = scoped ? mergeProjectFilter(saved, {
        project: normalizePatterns(input.project, home), exclude: normalizePatterns(input.exclude, home),
      }) : { project: [], exclude: [] };
      const command = commandFor(input, filter);
      const key = JSON.stringify([cliPath, input.report, input.period, input.range, input.provider, input.project, input.exclude, input.params, saved]);
      if (input.snapshot && input.refresh) throw new Error("Refresh must not reuse an existing snapshot token");
      let snapshot = input.snapshot ? snapshots.get(input.snapshot) : undefined;
      if (input.snapshot && (!snapshot || snapshot.key !== key)) throw new Error("Invalid or expired CodeBurn report snapshot");
      if (!snapshot) {
        if (input.focus.length || input.page || input.search) throw new Error("Navigate or search only within an existing snapshot");
        const generation = ++sequence;
        const data: Payload = input.report === "project-filter" ? saved : command.commands.length === 1
          ? await json(cliPath, command.commands[0]!, signal)
          : { configuredPlan: await json(cliPath, command.commands[0]!, signal), accountStatus: await json(cliPath, command.commands[1]!, signal) };
        ensureActive(signal, disposed);
        checkConfiguration(version);
        snapshot = { id: token(), key, data, generated: new Date(now()).toISOString(), at: now(), sequence: generation };
        if (snapshots.size === 2 && [...snapshots.values()].every((entry) => entry.sequence > generation)) {
          throw new Error("CodeBurn report refresh was superseded; refresh again");
        }
        snapshots.set(snapshot.id, snapshot);
        while (snapshots.size > 2) {
          const oldest = [...snapshots.values()].sort((a, b) => a.sequence - b.sequence)[0]!;
          snapshots.delete(oldest.id);
        }
      }
      const initialFocus = !input.snapshot && input.report === "overview" ? ["current"]
        : !input.snapshot && input.report === "timeline" ? ["history", "daily"] : input.focus;
      return explore(snapshot, { ...input, focus: initialFocus }, command.note + (scoped && saved.project.length ? "; saved project visibility applies" : ""));
    },
    async preview(raw: ActionQuery & { cliPath: string }, signal: AbortSignal): Promise<ActionPreview> {
      ensureActive(signal, disposed); await expired(); executableSchema.parse(raw.cliPath);
      const input = actionQuerySchema.parse({ action: raw.action, values: raw.values });
      if (tickets.size >= 64) throw new Error("Too many pending CodeBurn action previews");
      const action = actionCommand(input, home);
      const description = ACTIONS.find((item) => item.id === input.action)!.description;
      const id = token(); const expires = now() + TICKET_TTL;
      tickets.set(id, { cliPath: raw.cliPath, args: Object.freeze([...action.args]), expires, filter: action.filter });
      return { ticket: id, expiresAt: new Date(expires).toISOString(), description,
        command: action.filter ? ["atomic file replacement", projectFilterPath(home), `${JSON.stringify(action.filter, null, 2)}\n`] : [raw.cliPath, ...action.args] };
    },
    async confirm(raw: { cliPath: string; ticket: string }, signal: AbortSignal) {
      ensureActive(signal, disposed); await expired(); executableSchema.parse(raw.cliPath);
      const ticket = tickets.get(raw.ticket);
      if (!ticket) throw new Error("Invalid or expired CodeBurn action ticket");
      if (ticket.cliPath !== raw.cliPath) throw new Error("Action ticket does not match executable");
      tickets.delete(raw.ticket);
      pendingMutations++;
      configurationVersion++;
      snapshots.clear();
      const mutation = mutationTail.then(async () => {
        try {
          ensureActive(signal, disposed);
          if (ticket.expires <= now()) throw new Error("CodeBurn action ticket expired while waiting for another change");
          if (ticket.filter) {
            await readProjectFilter(home);
            ensureActive(signal, disposed);
            await writeProjectFilter(ticket.filter, home);
            return { stdout: "CodeBurn project visibility saved to app-filter.json", stderr: "" };
          }
          return await run(raw.cliPath, [...ticket.args], signal);
        } finally {
          snapshots.clear();
          configurationVersion++;
          pendingMutations--;
        }
      });
      // The caller receives the rejecting mutation. Only the queue tail absorbs
      // failure so a later independently confirmed change can still execute.
      mutationTail = mutation.then(() => undefined, () => undefined);
      return mutation;
    },
    async exportStart(raw: ExportQuery & { cliPath: string }, signal: AbortSignal): Promise<ExportLease> {
      ensureActive(signal, disposed);
      const finished = Promise.withResolvers<void>();
      pendingExports.add(finished.promise);
      let directory: string | undefined;
      let reserved = false;
      try {
        await expired();
        executableSchema.parse(raw.cliPath);
        const version = configurationVersion;
        checkConfiguration(version);
        const { cliPath, ...scopeInput } = raw;
        const input = exportStartSchema.parse(scopeInput);
        const filter = mergeProjectFilter(await readProjectFilter(home), {
          project: normalizePatterns(input.project, home), exclude: normalizePatterns(input.exclude, home),
        });
        ensureActive(signal, disposed);
        checkConfiguration(version);
        if (leases.size + exportReservations >= 2) throw new Error("Too many active CodeBurn exports; release an existing lease");
        exportReservations++;
        reserved = true;
        const window = exportDateWindow(input, now());
        const ownedDirectory = await mkdtemp(join(tmpdir(), "bb-codeburn-parity-"));
        directory = ownedDirectory;
        const destination = join(ownedDirectory, input.format === "csv" ? "usage-csv" : "usage.json");
        await run(cliPath, ["export", "--format", input.format, "--output", destination, "--from", window.from, "--to", window.to,
          ...(input.provider === "all" ? [] : ["--provider", input.provider]), ...projectFilterArgs(filter)], signal);
        const files = new Map<string, LeasedFile>();
        const root = await realpath(ownedDirectory);
        const inspect = async (path: string): Promise<void> => {
          const info = await lstat(path, { bigint: true });
          if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error("CodeBurn export contains a non-regular file");
          if (info.isDirectory()) {
            for (const name of await readdir(path)) await inspect(join(path, name));
            return;
          }
          const real = await realpath(path);
          if (!real.startsWith(`${root}${sep}`)) throw new Error("CodeBurn export file escapes private directory");
          const name = relative(ownedDirectory, path).split(sep).join("/");
          if (name.startsWith("../") || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..") || name.length > 1000) throw new Error("Invalid CodeBurn export filename");
          if (files.size >= 100) throw new Error("CodeBurn export contains too many files");
          const size = Number(info.size);
          if (size > MAX_BYTES || [...files.values()].reduce((sum, file) => sum + file.size, 0) + size > MAX_BYTES) throw new Error("CodeBurn export exceeds the 64 MiB bound");
          const mime = name.endsWith(".json") ? "application/json" : name.endsWith(".csv") ? "text/csv" : "text/plain";
          files.set(name, { path, size, mime, dev: info.dev, ino: info.ino, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs });
        };
        await inspect(destination);
        if (!files.size || [...files.values()].every((file) => file.size === 0)) throw new Error("CodeBurn did not create a non-empty native export");
        ensureActive(signal, disposed);
        checkConfiguration(version);
        const id = token(); const expires = now() + SNAPSHOT_TTL;
        leases.set(id, { cliPath, directory: ownedDirectory, files, expires });
        return { id, expiresAt: new Date(expires).toISOString(), files: [...files].map(([name, file]) => ({ name, size: file.size, mime: file.mime })) };
      } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true });
        throw error;
      } finally {
        if (reserved) exportReservations--;
        pendingExports.delete(finished.promise);
        finished.resolve();
      }
    },
    async exportRead(raw: { cliPath: string; id: string; name: string; offset: number }, signal: AbortSignal): Promise<ExportChunk> {
      ensureActive(signal, disposed); await expired(); executableSchema.parse(raw.cliPath);
      const input = exportReadSchema.parse({ id: raw.id, name: raw.name, offset: raw.offset });
      const lease = leases.get(input.id);
      if (!lease || lease.cliPath !== raw.cliPath) throw new Error("Invalid or expired CodeBurn export lease");
      const file = lease.files.get(input.name);
      if (!file || input.name.includes("..") || input.name.startsWith("/")) throw new Error("Invalid CodeBurn export filename");
      if (input.offset > file.size) throw new Error("Invalid CodeBurn export file offset");
      if (input.name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid CodeBurn export filename");
      verifyExportFile(await lstat(file.path, { bigint: true }), file);
      const handle = await open(file.path, "r");
      try {
        verifyExportFile(await handle.stat({ bigint: true }), file);
        const buffer = Buffer.allocUnsafe(Math.min(MAX_CHUNK, file.size - input.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
        verifyExportFile(await handle.stat({ bigint: true }), file);
        ensureActive(signal, disposed);
        if (bytesRead !== buffer.length) throw new Error("CodeBurn export file changed during read");
        const nextOffset = input.offset + bytesRead;
        return { base64: buffer.toString("base64"), nextOffset, totalSize: file.size, eof: nextOffset === file.size };
      } finally { await handle.close(); }
    },
    async exportEnd(raw: { cliPath: string; id: string }, signal: AbortSignal) {
      ensureActive(signal, disposed); await expired(); executableSchema.parse(raw.cliPath);
      const input = exportEndSchema.parse({ id: raw.id });
      const lease = leases.get(input.id);
      if (!lease || lease.cliPath !== raw.cliPath) throw new Error("Invalid or expired CodeBurn export lease");
      leases.delete(input.id); await rm(lease.directory, { recursive: true, force: true });
      return { released: true };
    },
    async dispose(): Promise<void> {
      disposed = true;
      for (const controller of active) controller.abort();
      await Promise.all([...running, ...pendingExports, mutationTail]);
      active.clear(); snapshots.clear(); tickets.clear();
      const directories = [...leases.values()].map((lease) => lease.directory);
      leases.clear();
      await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    },
  };
}
