import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listCost, OLLAMA_KIMI_PRICES, priceOf, type PriceOverrides, withPrices } from "../../../src/prices.js";
import { buildReport, promptExcerpt, type EntryLike, type TokenParts, type UsageReport } from "../../../src/report.js";

export const kimiSessionsDir = (home = homedir()): string => join(home, ".kimi-code", "sessions");
const safeId = (id: string): boolean => /^session_[A-Za-z0-9_-]+$/.test(id);
const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const validNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
type RecordRow =
  | { kind: "prompt"; at: number; text: string }
  | { kind: "usage"; at: number; model: string; tokens: TokenParts };
interface FileState {
  offset: number;
  stamp: number;
  ino: number;
  carry: Buffer;
  firstLine: string | null;
  skipping: boolean;
  partial: boolean;
  rows: RecordRow[];
}
const FILE_LIMIT = 50_000;
const LINE_LIMIT = 4 * 1024 * 1024;
const FILES_MAX = 200;
const fresh = (ino: number): FileState => ({ offset: 0, stamp: 0, ino, carry: Buffer.alloc(0), firstLine: null, skipping: false, partial: false, rows: [] });

function consume(state: FileState, line: string, main: boolean): void {
  state.firstLine ??= line;
  let row: Record<string, unknown> | null;
  try { row = obj(JSON.parse(line)); } catch { return; }
  if (!row || !validNumber(row.time) || row.time > 8.64e15) return;
  if (row.type === "turn.prompt" && main && obj(row.origin)?.kind === "user" && Array.isArray(row.input)) {
    const blocks = row.input.filter((b): b is { type: string; text: string } => {
      const v = obj(b);
      return v?.type === "text" && typeof v.text === "string";
    });
    state.rows.push({ kind: "prompt", at: row.time, text: promptExcerpt(blocks) });
  } else if (row.type === "usage.record" && row.usageScope === "turn" && typeof row.model === "string") {
    const u = obj(row.usage);
    if (!u || ![u.inputOther, u.output, u.inputCacheRead, u.inputCacheCreation].every(validNumber)) {
      state.partial = true;
      return;
    }
    state.rows.push({ kind: "usage", at: row.time, model: row.model, tokens: {
      input: u.inputOther as number, output: u.output as number,
      cacheRead: u.inputCacheRead as number, cacheWrite: u.inputCacheCreation as number,
    } });
  }
  if (state.rows.length > FILE_LIMIT) {
    state.rows.splice(0, state.rows.length - FILE_LIMIT);
    state.partial = true;
  }
}

async function dirs(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
}

/** Reads only exact session IDs and each session's agent logs. No conversation text leaves the host except prompt excerpts. */
export function createKimiSessions(opts: { dir: string }) {
  const files = new Map<string, FileState>();
  let gate: Promise<unknown> = Promise.resolve();
  async function read(path: string, main: boolean): Promise<FileState | null> {
    let info;
    try { info = await stat(path); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") { files.delete(path); return null; } throw err; }
    let state = files.get(path);
    if (state?.firstLine && info.size > state.offset) {
      const h = await open(path, "r");
      try {
        const b = Buffer.alloc(Buffer.byteLength(state.firstLine));
        const n = await h.read(b, 0, b.length, 0);
        if (b.toString("utf8", 0, n.bytesRead) !== state.firstLine) state = undefined;
      } finally { await h.close(); }
    }
    if (!state || info.ino !== state.ino || info.size < state.offset || (info.size === state.offset && info.mtimeMs !== state.stamp))
      state = fresh(info.ino);
    const h = await open(path, "r");
    try {
      while (state.offset < info.size) {
        const b = Buffer.alloc(Math.min(1024 * 1024, info.size - state.offset));
        const { bytesRead } = await h.read(b, 0, b.length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        const data = Buffer.concat([state.carry, b.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          if (!state.skipping && end - start <= LINE_LIMIT) consume(state, data.toString("utf8", start, end), main);
          else state.partial = true;
          state.skipping = false;
          start = end + 1;
        }
        state.carry = Buffer.from(data.subarray(start));
        if (state.carry.length > LINE_LIMIT) { state.carry = Buffer.alloc(0); state.skipping = true; state.partial = true; }
      }
    } finally { await h.close(); }
    state.stamp = info.mtimeMs;
    files.delete(path); files.set(path, state);
    while (files.size > 1 && (files.size > FILES_MAX || [...files.values()].reduce((sum, f) => sum + f.rows.length, 0) > 200_000))
      files.delete(files.keys().next().value!);
    return state;
  }
  async function reportOf(sessionIds: readonly string[], timeZone: string, own: { since?: number; prices?: PriceOverrides } = {}): Promise<{ report: UsageReport; at: number } | null> {
    const roots = await dirs(opts.dir);
    const entries: EntryLike[] = [];
    const prices = withPrices(OLLAMA_KIMI_PRICES, own.prices ?? {});
    let at = 0, found = 0, missing = 0, partial = own.since !== undefined;
    let unpriced = false;
    for (const id of new Set(sessionIds.filter(safeId))) {
      let matched = false;
      for (const root of roots) {
        const session = join(opts.dir, root, id);
        const agents = await dirs(join(session, "agents"));
        if (!agents.length) continue;
        matched = true;
        for (const agent of agents) {
          const state = await read(join(session, "agents", agent, "wire.jsonl"), agent === "main");
          if (!state) { partial = true; continue; }
          at = Math.max(at, state.stamp);
          partial ||= state.partial;
          for (const row of state.rows) {
            if (own.since !== undefined && row.at < own.since) continue;
            const timestamp = new Date(row.at).toISOString();
            if (row.kind === "prompt") {
              entries.push({ type: "message", timestamp, message: { role: "user", content: row.text } } as EntryLike);
              continue;
            }
            const price = priceOf(prices, row.model);
            if (!price || (row.tokens.cacheWrite > 0 && !own.prices?.[row.model])) unpriced = true;
            const cost = price ? listCost(price, row.tokens, { tiers: true }) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
            entries.push({
              type: "message", timestamp, ...(agent === "main" ? {} : { agentId: id + ":" + agent }),
              message: { role: "assistant", provider: "kimi-code", model: row.model, usage: { ...row.tokens, cost, estimated: price !== null } },
            } as EntryLike);
          }
        }
      }
      if (matched) found++; else missing++;
    }
    if (!found || !at) return null;
    const report = buildReport(entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), null, { timeZone });
    const historyPartial = partial || missing > 0;
    partial = historyPartial || unpriced;
    report.coverage = partial ? "partial" : "available";
    if (report.agents) report.agents.coverage = partial ? "partial" : "available";
    if (partial) {
      const notes = [];
      if (historyPartial) notes.push("Partial Kimi Code history: some session data or inherited fork history may be unavailable.");
      if (unpriced) notes.push("Partial estimate: some models or cache writes have no known price.");
      report.coverageNote = notes.join(" ");
    }
    return { report, at };
  }
  return {
    reportOf(sessionIds: readonly string[], timeZone: string, own?: { since?: number; prices?: PriceOverrides }) {
      const run = gate.then(() => reportOf(sessionIds, timeZone, own));
      gate = run.catch(() => undefined);
      return run;
    },
  };
}
