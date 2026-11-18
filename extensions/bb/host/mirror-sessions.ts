import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PriceOverrides } from "../../../src/prices.js";
import { buildReport, type EntryLike, type UsageReport } from "../../../src/report.js";
import { ollamaCost } from "./ollama-prices.js";

export const mirrorDbPath = (home = homedir()) => join(home, ".mirror", "state.db");
type Field = { n: number; wire: number; value: number | Buffer };
/** Decode only the protobuf wire types used by Mirror's AgentMessage. */
export function fields(data: Uint8Array): Field[] {
  const b = Buffer.from(data), out: Field[] = [];
  let i = 0;
  const v = () => {
    let result = 0, shift = 0;
    for (let n = 0; n < 10 && i < b.length; n++, shift += 7) {
      const c = b[i++]!; result += (c & 127) * 2 ** shift;
      if (!(c & 128)) return result;
    }
    throw new Error("invalid protobuf varint");
  };
  while (i < b.length) {
    const tag = v(), n = Math.floor(tag / 8), wire = tag & 7;
    if (!n) throw new Error("invalid protobuf field");
    if (wire === 0) out.push({ n, wire, value: v() });
    else if (wire === 2) {
      const len = v(); if (len > b.length - i) throw new Error("invalid protobuf length");
      out.push({ n, wire, value: b.subarray(i, i + len) }); i += len;
    } else if (wire === 1) { if (i + 8 > b.length) throw new Error("invalid protobuf field"); i += 8; }
    else if (wire === 5) { if (i + 4 > b.length) throw new Error("invalid protobuf field"); i += 4; }
    else throw new Error("unsupported protobuf wire type");
  }
  return out;
}
const buf = (f: Field[] | undefined, n: number) => f?.find(x => x.n === n && Buffer.isBuffer(x.value))?.value as Buffer | undefined;
const number = (f: Field[] | undefined, n: number) => {
  const v = f?.find(x => x.n === n && typeof x.value === "number")?.value;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
};
const text = (f: Field[] | undefined, n: number) => buf(f, n)?.toString("utf8") ?? "";
const safe = (id: string) => /^[A-Za-z0-9_-]+$/.test(id) && !id.startsWith("thr_");
export function createMirrorSessions(opts: { path: string }) {
  return {
    async reportOf(sessionIds: readonly string[], timeZone: string, own: { since?: number; prices?: PriceOverrides } = {}): Promise<{ report: UsageReport; at: number } | null> {
      let info;
      try { info = await stat(opts.path); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
      const db = new DatabaseSync(opts.path, { readOnly: true });
      const entries: EntryLike[] = [];
      let found = 0, missing = 0, partial = own.since !== undefined, unpriced = false, at = info.mtimeMs;
      try {
        for (const id of new Set(sessionIds.filter(safe))) {
          if (!db.prepare("SELECT 1 FROM react_session WHERE id = ?").get(id)) { missing++; continue; }
          found++;
          const rows = db.prepare("SELECT payload FROM react_entry WHERE session_id = ? ORDER BY sequence DESC LIMIT 20001").all(id);
          if (rows.length > 20_000) { rows.pop(); partial = true; }
          for (const row of rows) {
            try {
              if (!(row.payload instanceof Uint8Array)) { partial = true; continue; }
              const msg = fields(row.payload), chatBytes = buf(msg, 4), stampBytes = buf(msg, 3), configBytes = buf(msg, 8);
              if (!chatBytes || !stampBytes) continue;
              const chat = fields(chatBytes), usageBytes = buf(chat, 5);
              if (!usageBytes) continue;
              const stamp = fields(stampBytes), ts = number(stamp, 1) * 1000 + Math.floor(number(stamp, 2) / 1e6);
              if (!ts || ts > 8.64e15 || (own.since !== undefined && ts < own.since)) continue;
              const u = fields(usageBytes), config = configBytes ? fields(configBytes) : [];
              const model = text(config, 1), base = text(config, 3);
              let provider = "";
              try { if (new URL(base).hostname === "ollama.com") provider = "ollama-cloud"; } catch { /* unknown provider */ }
              const cacheRead = number(u, 3), cacheWrite = number(u, 4);
              const tokens = { input: Math.max(0, number(u, 1) - cacheRead - cacheWrite), output: number(u, 2), cacheRead, cacheWrite };
              const priced = ollamaCost(provider, model, tokens, ts, own.prices);
              unpriced ||= priced.partial;
              entries.push({ type: "message", timestamp: new Date(ts).toISOString(), message: { role: "assistant", provider: provider || "unknown", model,
                usage: { ...tokens, cost: priced.cost, estimated: priced.priced } } } as EntryLike);
              at = Math.max(at, ts);
            } catch { partial = true; }
          }
        }
      } finally { db.close(); }
      if (!found || !entries.length) return null;
      const report = buildReport(entries.sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp)), null, { timeZone });
      report.coverage = partial || missing || unpriced ? "partial" : "available";
      if (report.coverage === "partial") report.coverageNote = unpriced
        ? "Partial estimate: some models or cache writes have no known Ollama price."
        : "Partial Mirror history: some session or inherited fork data may be unavailable.";
      return { report, at };
    },
  };
}
