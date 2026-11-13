import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PAGE_SIZE, rowSchema, type StatsQuery, type StatsReply, type StatsRow, type TableName } from "./contract.js";
import { readProjectFilter } from "./project-filter.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 90_000;
const CACHE_MS = 30_000;
const MAX_CACHED_EXPORTS = 1;

const count = z.number().int().nonnegative();
const amount = z.number().finite().nonnegative();
const nativeRows = z.custom<StatsRow[]>(
  (value) => Array.isArray(value) && value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row)),
  "expected an array of native export rows",
);
const dailyRow = z.object({
  date: z.string().min(1),
  cost: amount,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
}).passthrough();
const exportSchema = z.object({
  schema: z.literal("codeburn.export.v3"),
  generated: z.string().min(1),
  currency: z.object({ code: z.string().min(1).max(20), symbol: z.string().max(20) }),
  summary: z.array(z.object({
    period: z.string().min(1), cost: amount, saved: amount,
    apiCalls: count, sessions: count, projects: count,
  })).length(1),
  periods: z.array(z.object({
    label: z.string().min(1),
    daily: z.array(dailyRow),
    activity: nativeRows,
    models: nativeRows,
  })).length(1),
  projects: nativeRows,
  sessions: nativeRows,
  records: nativeRows,
  tools: nativeRows,
  mcp: nativeRows,
  shellCommands: nativeRows,
});
type ExportData = z.infer<typeof exportSchema>;

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dateWindow(period: StatsQuery["period"], now: Date): { from: string; to: string } {
  const daysBefore = period === "30d" ? 30 : period === "7d" ? 7 : 0;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBefore);
  return { from: localDate(from), to: localDate(now) };
}

async function runExport(cliPath: string, args: string[], signal: AbortSignal): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-codeburn-export-"));
  const outputPath = join(directory, "usage.json");
  let completed = false;
  try {
    await execFileAsync(cliPath, [...args, "--output", outputPath], {
      signal,
      timeout: EXPORT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
      shell: false,
      env: { ...process.env, CODEBURN_CURSOR_SYNC: "0" },
    });
    completed = true;
    const file = await stat(outputPath);
    if (!file.isFile()) throw new Error("CodeBurn did not create a JSON export file");
    if (file.size > MAX_OUTPUT_BYTES) throw new Error("CodeBurn export exceeded the 64 MiB output bound");
    return await readFile(outputPath, "utf8");
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (signal.aborted || code === "ABORT_ERR") throw new Error("CodeBurn export was cancelled", { cause: error });
    if (code === "ENOENT") {
      throw new Error(completed
        ? "CodeBurn exited without writing its JSON export file"
        : `CodeBurn executable not found: ${cliPath}. Install or upgrade CodeBurn to 0.9.28 or newer.`, { cause: error });
    }
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("CodeBurn export exceeded the 64 MiB output bound", { cause: error });
    if (code === "ETIMEDOUT" || (error !== null && typeof error === "object" && "killed" in error && error.killed === true)) {
      throw new Error("CodeBurn export timed out after 90 seconds", { cause: error });
    }
    throw new Error(`CodeBurn export failed (${cliPath}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseExport(stdout: string): ExportData {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new Error("CodeBurn returned malformed JSON; export cannot be displayed", { cause: error });
  }
  if (raw === null || typeof raw !== "object" || !("schema" in raw) || raw.schema !== "codeburn.export.v3") {
    throw new Error("Unsupported CodeBurn export schema; expected codeburn.export.v3. Upgrade CodeBurn to 0.9.28 or newer.");
  }
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`Invalid CodeBurn export at ${first?.path.join(".") || "root"}: ${first?.message ?? "invalid data"}`);
  }
  return parsed.data;
}

function tableRows(data: ExportData, table: TableName): unknown[] {
  switch (table) {
    case "daily": return data.periods[0]!.daily;
    case "activity": return data.periods[0]!.activity;
    case "models": return data.periods[0]!.models;
    case "projects": return data.projects;
    case "sessions": return data.sessions;
    case "tools": return data.tools;
    case "mcp": return data.mcp;
    case "shellCommands": return data.shellCommands;
    case "records": return data.records;
  }
}

function reply(data: ExportData, input: StatsQuery, from: string, to: string): StatsReply {
  const allRows = tableRows(data, input.table);
  const search = input.search.trim().toLocaleLowerCase();
  const filtered = search ? allRows.filter((row) => JSON.stringify(row).toLocaleLowerCase().includes(search)) : allRows;
  const totalRows = filtered.length;
  const page = Math.min(input.page, Math.max(0, Math.ceil(totalRows / PAGE_SIZE) - 1));
  const rows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row, index) => {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) throw new Error(`Invalid CodeBurn ${input.table} row ${page * PAGE_SIZE + index}: ${parsed.error.issues[0]?.message ?? "invalid JSON field"}`);
    return parsed.data;
  });
  const columnNames = new Set<string>();
  for (const row of allRows) {
    for (const column of Object.keys(row as StatsRow)) columnNames.add(column);
  }
  const columns = [...columnNames];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const day of data.periods[0]!.daily) {
    tokens.input += day.inputTokens;
    tokens.output += day.outputTokens;
    tokens.cacheRead += day.cacheReadTokens;
    tokens.cacheWrite += day.cacheWriteTokens;
  }
  const summary = data.summary[0]!;
  return {
    schema: "codeburn.export.v3",
    generated: data.generated,
    from, to,
    currency: { code: data.currency.code, symbol: data.currency.symbol },
    summary: { cost: summary.cost, saved: summary.saved, apiCalls: summary.apiCalls, sessions: summary.sessions, projects: summary.projects },
    tokens, columns, rows, totalRows, page, pageSize: PAGE_SIZE,
  };
}

export function createCollector(opts: {
  now?: () => Date;
  run?: (cliPath: string, args: string[], signal: AbortSignal) => Promise<string>;
  readFilter?: () => Promise<{ project: string[]; exclude: string[] }>;
} = {}): {
  statistics(input: StatsQuery & { cliPath: string }, signal: AbortSignal): Promise<StatsReply>;
  dispose(): void;
} {
  const now = opts.now ?? (() => new Date());
  const run = opts.run ?? runExport;
  const readFilter = opts.readFilter ?? readProjectFilter;
  const active = new Set<AbortController>();
  const cache = new Map<string, { data: ExportData; at: number }>();
  let disposed = false;
  let scanGeneration = 0;

  return {
    async statistics(input, signal) {
      if (disposed) throw new Error("CodeBurn collector has been disposed");
      if (signal.aborted) throw new Error("CodeBurn export was cancelled");
      const time = now();
      const { from, to } = dateWindow(input.period, time);
      const filter = await readFilter();
      if (signal.aborted || disposed) throw new Error("CodeBurn export was cancelled");
      const key = JSON.stringify([input.cliPath, input.period, to, filter.project, filter.exclude]);
      const timestamp = time.getTime();
      for (const [cacheKey, entry] of cache) {
        if (timestamp < entry.at || timestamp - entry.at >= CACHE_MS) cache.delete(cacheKey);
      }
      let data = !input.refresh ? cache.get(key)?.data : undefined;
      if (!data) {
        const generation = ++scanGeneration;
        const controller = new AbortController();
        active.add(controller);
        const onAbort = () => controller.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (signal.aborted) throw new Error("CodeBurn export was cancelled");
          const stdout = await run(input.cliPath, [
            "export", "--format", "json", "--from", from, "--to", to,
            ...filter.project.map((pattern) => `--project=${pattern}`),
            ...filter.exclude.map((pattern) => `--exclude=${pattern}`),
          ], controller.signal);
          if (controller.signal.aborted || signal.aborted || disposed) throw new Error("CodeBurn export was cancelled");
          data = parseExport(stdout);
          if (generation === scanGeneration) {
            cache.set(key, { data, at: now().getTime() });
            if (cache.size > MAX_CACHED_EXPORTS) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          active.delete(controller);
        }
      }
      if (signal.aborted || disposed) throw new Error("CodeBurn export was cancelled");
      return reply(data, input, from, to);
    },
    dispose() {
      disposed = true;
      for (const controller of active) controller.abort();
      active.clear();
      cache.clear();
    },
  };
}
