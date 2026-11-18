import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PriceOverrides } from "../../../src/prices.js";
import { buildReport, type EntryLike, type UsageReport } from "../../../src/report.js";
import { ollamaCost } from "./ollama-prices.js";

export const zcodePaths = (home = homedir()) => ({
  mapping: join(home, ".zcode", "v2", "acp-lazy-sessions.json"),
  database: join(home, ".zcode", "cli", "db", "db.sqlite"),
});
const valid = (id: string) => /^[A-Za-z0-9_-]+$/.test(id) && !id.startsWith("thr_");
const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

export function createZcodeSessions(opts: { mapping: string; database: string }) {
  return {
    async reportOf(sessionIds: readonly string[], timeZone: string, own: { since?: number; prices?: PriceOverrides } = {}): Promise<{ report: UsageReport; at: number } | null> {
      let mapping: Record<string, { zcodeSid?: unknown }>, info;
      try {
        mapping = JSON.parse(await readFile(opts.mapping, "utf8"));
        info = await stat(opts.database);
      } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
      const ids = [...new Set(sessionIds.filter(valid).map(id => mapping[id]?.zcodeSid).filter((id): id is string => typeof id === "string" && valid(id)))];
      if (!ids.length) return null;
      const db = new DatabaseSync(opts.database, { readOnly: true });
      const entries: EntryLike[] = [];
      let partial = own.since !== undefined || ids.length < sessionIds.filter(valid).length;
      let unpriced = false, latest = 0;
      try {
        for (const id of ids) {
          const rows = db.prepare("SELECT provider_id, model_id, started_at, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens FROM model_usage WHERE session_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 20001").all(id);
          if (rows.length > 20_000) { partial = true; rows.pop(); }
          if (db.prepare("SELECT 1 FROM session_task_link WHERE parent_session_id = ? LIMIT 1").get(id)) partial = true;
          for (const row of rows) {
            const at = count(row.started_at);
            if (!at || at > 8.64e15 || (own.since !== undefined && at < own.since)) continue;
            latest = Math.max(latest, at);
            const provider = typeof row.provider_id === "string" ? row.provider_id : "";
            const model = typeof row.model_id === "string" ? row.model_id : "";
            const read = count(row.cache_read_input_tokens), write = count(row.cache_creation_input_tokens);
            // ZCode's input_tokens is inclusive of cached input, as confirmed by provider_total_tokens.
            const tokens = { input: Math.max(0, count(row.input_tokens) - read - write), output: count(row.output_tokens), cacheRead: read, cacheWrite: write };
            const priced = ollamaCost(provider, model, tokens, at, own.prices);
            unpriced ||= priced.partial;
            entries.push({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider, model,
              usage: { ...tokens, cost: priced.cost, estimated: priced.priced } } } as EntryLike);
          }
        }
      } finally { db.close(); }
      if (!entries.length) return null;
      const report = buildReport(entries.sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp)), null, { timeZone });
      report.coverage = partial || unpriced ? "partial" : "available";
      if (report.coverage === "partial") report.coverageNote = unpriced
        ? "Partial estimate: some models or cache writes have no known Ollama price."
        : "Partial ZCode history: some sessions, native agents, or inherited fork history may be unavailable.";
      return { report, at: Math.max(info.mtimeMs, latest) };
    },
  };
}
