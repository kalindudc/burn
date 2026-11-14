import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PriceOverrides } from "../../../src/prices.js";
import { buildReport, type EntryLike, type UsageReport } from "../../../src/report.js";
import { ollamaCost } from "./ollama-prices.js";

export const hermesDir = (home = homedir()) => join(home, ".hermes");
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const valid = (s: string) => /^[A-Za-z0-9_-]+$/.test(s) && !s.startsWith("thr_");
export function createHermesSessions(opts: { dir: string }) {
  return {
    async reportOf(sessionIds: readonly string[], timeZone: string, own: { since?: number; prices?: PriceOverrides } = {}): Promise<{ report: UsageReport; at: number } | null> {
      let profiles: string[] = [];
      try { profiles = (await readdir(join(opts.dir, "profiles"), { withFileTypes: true })).filter(x => x.isDirectory()).slice(0, 32).map(x => x.name); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const paths = [join(opts.dir, "state.db"), ...profiles.map(p => join(opts.dir, "profiles", p, "state.db"))];
      const ids = [...new Set(sessionIds.filter(valid))], missing = new Set(ids);
      const entries: EntryLike[] = [];
      const calls = new Map<string, number>();
      let found = 0, unpriced = false, at = 0;
      for (const path of paths) {
        let info;
        try { info = await stat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          for (const id of ids) {
            if (!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id)) continue;
            // The same session cannot safely be counted twice if copied across Hermes profiles.
            if (!missing.has(id)) continue;
            missing.delete(id); found++; at = Math.max(at, info.mtimeMs);
            const rows = db.prepare("SELECT model,billing_provider,billing_base_url,api_call_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,first_seen,last_seen FROM session_model_usage WHERE session_id = ?").all(id);
            for (const row of rows) {
              const first = num(row.first_seen) * 1000, last = num(row.last_seen) * 1000;
              if (!first || first > 8.64e15 || (own.since !== undefined && last < own.since)) continue;
              const provider = typeof row.billing_provider === "string" ? row.billing_provider : "";
              const model = typeof row.model === "string" ? row.model : "";
              if (provider !== "ollama-cloud") return null;
              const tokens = { input: num(row.input_tokens), output: num(row.output_tokens), cacheRead: num(row.cache_read_tokens), cacheWrite: num(row.cache_write_tokens) };
              const priced = ollamaCost(provider, model, tokens, first, own.prices);
              unpriced ||= priced.partial;
              const key = provider + "/" + model;
              calls.set(key, (calls.get(key) ?? 0) + num(row.api_call_count));
              entries.push({ type: "message", timestamp: new Date(first).toISOString(), message: { role: "assistant", provider, model,
                usage: { ...tokens, cost: priced.cost, estimated: priced.priced } } } as EntryLike);
              at = Math.max(at, last, first);
            }
          }
        } finally { db.close(); }
      }
      if (!found || !entries.length) return null;
      const report = buildReport(entries.sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp)), null, { timeZone });
      report.calls = [...calls.values()].reduce((a,b) => a+b, 0);
      for (const row of report.byModel) row.calls = calls.get(row.key) ?? row.calls;
      // Hermes stores per-model aggregates: exact call times, prompt splits and peak/off-peak transitions are unavailable.
      report.coverage = "partial";
      report.coverageNote = unpriced
        ? "Partial estimate: some models or cache writes have no known Ollama price."
        : "Partial Hermes history: model totals lack individual call times and may span different rates.";
      return { report, at };
    },
  };
}
