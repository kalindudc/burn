import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { PriceOverrides } from "../../../src/prices.js";
import { buildReport, promptExcerpt, type EntryLike, type TokenParts, type UsageReport } from "../../../src/report.js";
import { ollamaCost } from "./ollama-prices.js";

export const dshSessionsDir = (home = homedir()): string => join(home, ".dsh", "sessions");
const safeId = (s: string) => /^[a-zA-Z0-9_-]+$/.test(s) && !s.startsWith("thr_");
const object = (v: unknown): Record<string, any> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const fileLimit = 64 * 1024 * 1024;
interface Row { at: number; prompt?: string; provider?: string; model?: string; tokens?: TokenParts }
interface State { stamp: number; size: number; rows: Row[]; partial: boolean; next: number; head: string; ino: number; damaged: boolean }

async function dirs(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
}

/** Find a complete standard Zstandard frame by its block boundaries; incomplete tails wait for the next read. */
export function frameEnd(data: Buffer, start: number): number | null {
  if (start + 5 > data.length || data.readUInt32LE(start) !== 0xfd2fb528) return null;
  let p = start + 4;
  const descriptor = data[p++]!;
  if (descriptor & 0x18) return null;
  const sizeFlag = descriptor >> 6, single = (descriptor & 0x20) !== 0, dict = descriptor & 3;
  p += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag);
  if (p > data.length) return null;
  for (;;) {
    if (p + 3 > data.length) return null;
    const header = data.readUIntLE(p, 3); p += 3;
    const kind = (header >> 1) & 3, count = header >>> 3;
    if (kind === 3) return null;
    p += kind === 1 ? 1 : count;
    if (p > data.length) return null;
    if (header & 1) break;
  }
  if (descriptor & 4) p += 4;
  return p <= data.length ? p : null;
}

/** Reads DSH's concatenated, checksummed Zstandard JSONL frames by exact session id. */
export function createDshSessions(opts: { dir: string }) {
  const cached = new Map<string, State>();
  async function read(path: string): Promise<State | null> {
    let info;
    try { info = await stat(path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    const previous = cached.get(path);
    if (previous && previous.size === info.size && previous.stamp === info.mtimeMs) return previous;
    if (info.size > fileLimit) return { rows: [], size: info.size, stamp: info.mtimeMs, partial: true, next: 0, head: "", ino: info.ino, damaged: true };
    const bytes = await readFile(path);
    const head = bytes.subarray(0, Math.min(64, bytes.length)).toString("hex");
    const append = previous && previous.ino === info.ino && info.size > previous.size && head.startsWith(previous.head);
    const rows: Row[] = append ? [...previous.rows] : [];
    let partial = append ? previous.damaged : false, offset = append ? previous.next : 0;
    let damaged = partial, pending = false;
    while (offset < bytes.length) {
      const end = frameEnd(bytes, offset);
      if (end === null) { pending = true; break; }
      let text: string;
      try { text = zstdDecompressSync(bytes.subarray(offset, end), { maxOutputLength: 8 * 1024 * 1024 }).toString("utf8"); }
      catch { damaged = true; break; }
      offset = end;
      for (const line of text.split("\n")) {
        if (!line) continue;
        let event: Record<string, any> | null;
        try { event = object(JSON.parse(line)); } catch { damaged = true; continue; }
        if (!event || typeof event.time !== "number" || !Number.isFinite(event.time) || event.time < 0 || event.time > 8.64e15) continue;
        const data = object(event.data);
        if (!data) continue;
        if (event.type === "user/message") {
          const content = data.content;
          if (typeof content === "string" || Array.isArray(content)) rows.push({ at: event.time, prompt: promptExcerpt(content) });
        }
        if (event.type !== "assistant/message") continue;
        const source = object(object(data.message)?.source);
        const u = object(data.usage);
        if (!u || !source || typeof source.provider !== "string" || typeof source.model !== "string") { damaged = true; continue; }
        rows.push({ at: event.time, provider: source.provider, model: source.model,
          tokens: { input: num(u.inputTokens), output: num(u.outputTokens), cacheRead: num(u.cacheReadTokens), cacheWrite: num(u.cacheWriteTokens) } });
      }
      if (rows.length > 50_000) { rows.splice(0, rows.length - 50_000); damaged = true; }
    }
    const state = { stamp: info.mtimeMs, size: info.size, rows, partial: damaged || pending, next: offset, head, ino: info.ino, damaged };
    cached.delete(path); cached.set(path, state);
    if (cached.size > 32) cached.delete(cached.keys().next().value!);
    return state;
  }
  return {
    async reportOf(sessionIds: readonly string[], timeZone: string, opts2: { since?: number; prices?: PriceOverrides } = {}): Promise<{ report: UsageReport; at: number } | null> {
      const entries: EntryLike[] = [], roots = await dirs(opts.dir);
      let found = 0, missing = 0, at = 0, partial = opts2.since !== undefined, unpriced = false;
      for (const id of new Set(sessionIds.filter(safeId))) {
        let matched = false;
        for (const root of roots) {
          const file = join(opts.dir, root, id, "session.v3.jsonl.zstd");
          const state = await read(file);
          if (!state) continue;
          matched = true; at = Math.max(at, state.stamp); partial ||= state.partial;
          for (const row of state.rows) {
            if (opts2.since !== undefined && row.at < opts2.since) continue;
            const timestamp = new Date(row.at).toISOString();
            if (row.prompt !== undefined) {
              entries.push({ type: "message", timestamp, message: { role: "user", content: row.prompt } } as EntryLike); continue;
            }
            if (!row.tokens || !row.model || !row.provider) continue;
            const priced = ollamaCost(row.provider, row.model, row.tokens, row.at, opts2.prices);
            unpriced ||= priced.partial;
            entries.push({ type: "message", timestamp, message: { role: "assistant", provider: row.provider, model: row.model,
              usage: { ...row.tokens, cost: priced.cost, estimated: priced.priced } } } as EntryLike);
          }
        }
        if (matched) found++; else missing++;
      }
      if (!found || !at || !entries.some(e => (e as EntryLike & { message?: { role?: string } }).message?.role === "assistant")) return null;
      const report = buildReport(entries.sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp)), null, { timeZone });
      report.coverage = partial || missing || unpriced ? "partial" : "available";
      if (report.coverage === "partial") report.coverageNote = unpriced
        ? "Partial estimate: some models or cache writes have no known Ollama price."
        : "Partial DSH history: some session data, subagents, or inherited fork history may be unavailable.";
      return { report, at };
    },
  };
}
