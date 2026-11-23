import { open, stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listCost, type PriceOverrides, priceOf, type PriceRow } from "../../../src/prices.js";
import { buildReport, type EntryLike, promptExcerpt, type UsageReport } from "../../../src/report.js";
import { opencodeModelsPath } from "./opencode-db.js";

const NEWLINE = 0x0a;
const CHUNK_BYTES = 1024 * 1024;
const FILES_MAX = 1000;
const CARRY_MAX_BYTES = 4 * 1024 * 1024;
const PER_MILLION = 1_000_000;
const EFFORT_SUFFIX = /-(?:low|medium|high|xhigh|max)$/;
const PREFERRED_PROVIDERS = ["google", "anthropic", "openai", "opencode"] as const;

export const antigravityBrainDir = (home = homedir()): string => join(home, ".gemini", "antigravity-cli", "brain");

const safeId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

interface CatalogRates {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

type ParsedRow =
  | { kind: "user"; timestamp: string; content: string }
  | {
      kind: "assistant";
      timestamp: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning?: number;
      toolCalls: { type: "toolCall"; name: string }[];
      stopReason?: "error" | "aborted";
    };

interface FileState {
  offset: number;
  carry: Buffer;
  stamp: number;
  ino: number;
  firstLine: string | null;
  rows: ParsedRow[];
}

export interface AntigravityOptions {
  /** Burn's price overrides, used as fallback when models.dev has no rate for the model. */
  prices?: PriceOverrides;
}

export interface AntigravitySessions {
  reportOf(sessionIds: readonly string[], timeZone: string, opts?: AntigravityOptions): Promise<{ report: UsageReport; at: number } | null>;
}

/** Extracts user prompt text from `<USER_REQUEST>` while stripping injected `<system_instructions>`. */
export function extractAntigravityPrompt(content: unknown): string {
  if (typeof content !== "string") return "";
  const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const body = (match ? (match[1] ?? "") : content).replace(/<system_instructions>[\s\S]*?<\/system_instructions>/g, "");
  return promptExcerpt(body);
}

/** Strips an Antigravity effort suffix (`-low`, `-medium`, `-high`, `-xhigh`, `-max`) from a model id. */
export function stripEffortSuffix(model: string): string {
  return model.replace(EFFORT_SUFFIX, "");
}

function catalogCostToRates(cost: unknown): CatalogRates | null {
  if (!isRecord(cost)) return null;
  const input = num(cost.input);
  const output = num(cost.output);
  const cacheRead = num(cost.cache_read);
  const cacheWrite = num(cost.cache_write);
  const reasoning = typeof cost.reasoning === "number" && Number.isFinite(cost.reasoning) && cost.reasoning >= 0 ? cost.reasoning : output;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) return null;
  return { input, output, reasoning, cacheRead, cacheWrite };
}

function lookupInProvider(provider: unknown, candidates: readonly string[]): CatalogRates | null {
  if (!isRecord(provider) || !isRecord(provider.models)) return null;
  const { models } = provider;
  for (const id of candidates) {
    const entry = models[id];
    if (isRecord(entry)) {
      const rates = catalogCostToRates(entry.cost);
      if (rates !== null) return rates;
    }
  }
  for (const [key, entry] of Object.entries(models)) {
    const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
    if (candidates.includes(bare) && isRecord(entry)) {
      const rates = catalogCostToRates(entry.cost);
      if (rates !== null) return rates;
    }
  }
  return null;
}

function catalogRatesOf(catalog: unknown, model: string): CatalogRates | null {
  if (!isRecord(catalog)) return null;
  const stripped = stripEffortSuffix(model);
  const candidates = stripped !== model ? [stripped, model] : [model];
  for (const providerId of PREFERRED_PROVIDERS) {
    const rates = lookupInProvider(catalog[providerId], candidates);
    if (rates !== null) return rates;
  }
  for (const [providerId, provider] of Object.entries(catalog)) {
    if ((PREFERRED_PROVIDERS as readonly string[]).includes(providerId)) continue;
    const rates = lookupInProvider(provider, candidates);
    if (rates !== null) return rates;
  }
  return null;
}

function priceFromCatalog(rates: CatalogRates, row: Extract<ParsedRow, { kind: "assistant" }>) {
  const reasoning = row.reasoning ?? 0;
  // In Antigravity logs `output_tokens` is total output; split any separately recorded reasoning if present.
  const answered = Math.max(0, row.output - reasoning);
  const input = (row.input * rates.input) / PER_MILLION;
  const output = (answered * rates.output + reasoning * rates.reasoning) / PER_MILLION;
  const cacheRead = (row.cacheRead * rates.cacheRead) / PER_MILLION;
  const cacheWrite = (row.cacheWrite * rates.cacheWrite) / PER_MILLION;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function priceRowToCost(price: PriceRow, row: Extract<ParsedRow, { kind: "assistant" }>) {
  return listCost(price, { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite }, { tiers: true });
}

function toEntry(row: ParsedRow, catalog: unknown, overrides: PriceOverrides): EntryLike {
  if (row.kind === "user") {
    return { type: "message", timestamp: row.timestamp, message: { role: "user", content: row.content } } as EntryLike;
  }
  const catalogRates = catalogRatesOf(catalog, row.model);
  let cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let estimated = false;
  if (catalogRates !== null) {
    cost = priceFromCatalog(catalogRates, row);
    estimated = true;
  } else {
    const override = priceOf(overrides, row.model);
    if (override !== null) {
      cost = priceRowToCost(override, row);
      estimated = true;
    }
  }
  return {
    type: "message",
    timestamp: row.timestamp,
    message: {
      role: "assistant",
      provider: "acp-antigravity",
      model: row.model,
      ...(row.stopReason !== undefined ? { stopReason: row.stopReason } : {}),
      ...(row.toolCalls.length > 0 ? { content: row.toolCalls } : {}),
      usage: {
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        ...(row.reasoning !== undefined ? { reasoning: row.reasoning } : {}),
        cost,
        estimated,
      },
    },
  } as EntryLike;
}

function consumeLine(state: FileState, line: string): void {
  if (line.trim() === "") return;
  if (state.firstLine === null) state.firstLine = line;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(raw) || typeof raw.type !== "string" || typeof raw.created_at !== "string") return;
  if (!Number.isFinite(Date.parse(raw.created_at))) return;

  if (raw.type === "USER_INPUT") {
    state.rows.push({ kind: "user", timestamp: raw.created_at, content: extractAntigravityPrompt(raw.content) });
    return;
  }
  if (raw.type !== "PLANNER_RESPONSE") return;

  const stopReason: "error" | "aborted" | undefined =
    raw.status === "ERROR" || raw.error !== undefined
      ? "error"
      : raw.status === "ABORTED" || raw.status === "CANCELLED"
        ? "aborted"
        : undefined;
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const cacheRead = num(raw.cache_read_tokens);
  const cacheWrite = num(raw.cache_write_tokens);
  const rawReasoning = raw.reasoning_tokens ?? raw.thinking_tokens;
  const reasoning = typeof rawReasoning === "number" && Number.isFinite(rawReasoning) && rawReasoning >= 0 ? rawReasoning : undefined;
  if (input + output + cacheRead + cacheWrite === 0 && stopReason === undefined) return;

  const toolCalls: { type: "toolCall"; name: string }[] = [];
  if (Array.isArray(raw.tool_calls)) {
    for (const tc of raw.tool_calls) {
      if (isRecord(tc) && typeof tc.name === "string" && tc.name !== "") toolCalls.push({ type: "toolCall", name: tc.name });
    }
  }
  state.rows.push({
    kind: "assistant",
    timestamp: raw.created_at,
    model: typeof raw.model === "string" && raw.model !== "" ? raw.model : "unknown",
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    toolCalls,
    stopReason,
  });
}

/**
 * Reads Antigravity CLI (`agy`) session transcripts under `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl`.
 * Prices tokens from opencode's cached `models.dev` catalog (stripping effort suffixes such as `-high`),
 * falling back to Burn's `priceOverrides` (by exact model id), or leaving tokens unpriced.
 */
export function createAntigravitySessions(opts: { dir: string; modelsPath?: string }): AntigravitySessions {
  const modelsPath = opts.modelsPath ?? opencodeModelsPath();
  const files = new Map<string, FileState>();
  let catalog: unknown = null;
  let catalogStamp: number | null = null;
  let gate: Promise<unknown> = Promise.resolve();
  const warned = new Set<string>();

  function warnOnce(what: string, err: unknown): void {
    if (warned.has(what)) return;
    if (warned.size > 20) warned.clear();
    warned.add(what);
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[burn] ${what}: ${detail}`);
  }

  function loadCatalog(): unknown {
    let stamp: number;
    try {
      stamp = statSync(modelsPath).mtimeMs;
    } catch {
      catalogStamp = null;
      catalog = null;
      return null;
    }
    if (stamp !== catalogStamp) {
      catalogStamp = stamp;
      try {
        catalog = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
      } catch (err) {
        warnOnce("opencode's model catalog is not valid JSON, so Antigravity transcripts skip catalog pricing", err);
        catalog = null;
      }
    }
    return catalog;
  }

  async function readTranscript(path: string): Promise<FileState | null> {
    let info;
    try {
      info = await stat(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw err;
    }
    let state = files.get(path);
    if (state?.firstLine !== null && state !== undefined && info.size > state.offset) {
      const head = await open(path, "r");
      try {
        const bytes = Buffer.alloc(Buffer.byteLength(state.firstLine));
        const read = await head.read(bytes, 0, bytes.length, 0);
        if (bytes.toString("utf8", 0, read.bytesRead) !== state.firstLine) state = undefined;
      } finally {
        await head.close();
      }
    }
    if (!state || info.size < state.offset || info.ino !== state.ino || (info.size === state.offset && info.mtimeMs !== state.stamp)) {
      state = { offset: 0, carry: Buffer.alloc(0), stamp: 0, ino: info.ino, firstLine: null, rows: [] };
    }
    if (state.offset < info.size) {
      const handle = await open(path, "r");
      try {
        while (state.offset < info.size) {
          const buf = Buffer.alloc(Math.min(CHUNK_BYTES, info.size - state.offset));
          const { bytesRead } = await handle.read(buf, 0, buf.length, state.offset);
          if (!bytesRead) break;
          state.offset += bytesRead;
          const data = state.carry.length > 0 ? Buffer.concat([state.carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          let start = 0;
          for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, start)) {
            consumeLine(state, data.toString("utf8", start, end));
            start = end + 1;
          }
          state.carry = Buffer.from(data.subarray(start));
          if (state.carry.length > CARRY_MAX_BYTES) state.carry = Buffer.alloc(0);
        }
      } finally {
        await handle.close();
      }
    }
    state.stamp = info.mtimeMs;
    files.delete(path);
    files.set(path, state);
    if (files.size > FILES_MAX) {
      const oldest = files.keys().next().value;
      if (oldest !== undefined) files.delete(oldest);
    }
    return state;
  }

  async function report(sessionIds: readonly string[], timeZone: string, own: AntigravityOptions): Promise<{ report: UsageReport; at: number } | null> {
    const ids = [...new Set(sessionIds)].filter((id) => !id.startsWith("thr_") && safeId(id));
    if (ids.length === 0) return null;
    const loadedCatalog = loadCatalog();
    const overrides = own.prices ?? {};
    const entries: EntryLike[] = [];
    let found = 0;
    let missing = 0;
    let at = 0;
    for (const id of ids) {
      const path = join(opts.dir, id, ".system_generated", "logs", "transcript.jsonl");
      let state: FileState | null;
      try {
        state = await readTranscript(path);
      } catch (err) {
        warnOnce(`could not read Antigravity transcript for ${id}`, err);
        missing++;
        continue;
      }
      if (state === null) {
        missing++;
        continue;
      }
      found++;
      at = Math.max(at, state.stamp);
      for (const row of state.rows) entries.push(toEntry(row, loadedCatalog, overrides));
    }
    if (found === 0 || entries.length === 0) return null;
    entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const built = buildReport(entries, null, { timeZone });
    if (missing > 0) {
      built.coverage = "partial";
      built.coverageNote = "Partial Antigravity history: some session transcripts are unavailable.";
    }
    return { report: built, at };
  }

  return {
    reportOf(ids, zone, own = {}) {
      const run = gate.then(() => report(ids, zone, own));
      gate = run.catch(() => undefined);
      return run;
    },
  };
}
