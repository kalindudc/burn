import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PriceOverrides } from "../../../src/prices.js";
import { buildReport, type EntryLike, type UsageReport } from "../../../src/report.js";
import { ollamaCost } from "./ollama-prices.js";

export const minimaxDbPath = (home = homedir()) => join(home, ".minimax", "v2", "sqlite", "runtime-state.sqlite");
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const object = (v: unknown): Record<string, any> | null => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, any> : null;
const valid = (s: string) => /^[A-Za-z0-9_-]+$/.test(s) && !s.startsWith("thr_");
export function createMinimaxSessions(opts: { path: string }) {
  return {
    async reportOf(sessionIds: readonly string[], timeZone: string, own: { since?: number; prices?: PriceOverrides } = {}): Promise<{ report: UsageReport; at: number } | null> {
      let info;
      try { info = await stat(opts.path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
      const db = new DatabaseSync(opts.path, { readOnly: true }), entries: EntryLike[] = [];
      let found = 0, missing = 0, partial = own.since !== undefined, unpriced = false, at = info.mtimeMs;
      try {
        for (const id of new Set(sessionIds.filter(valid))) {
          if (!db.prepare("SELECT 1 FROM local_runtime_sessions WHERE session_id = ?").get(id)) { missing++; continue; }
          found++;
          // MiniMax's pi history retains provider identity on each assistant message;
          // aggregate token-usage rows alone cannot safely distinguish Ollama from MiniMax's API.
          const rows = db.prepare("SELECT created_at_ms, data_json FROM local_runtime_pi_history_rows WHERE session_id = ? ORDER BY id DESC LIMIT 20001").all(id);
          if (rows.length > 20_000) { rows.pop(); partial = true; }
          for (const row of rows) {
            try {
              const msg = object(JSON.parse(String(row.data_json)));
              if (!msg || msg.role !== "assistant") continue;
              const usage = object(msg.usage);
              if (!usage) continue;
              const ts = num(msg.timestamp) || num(row.created_at_ms);
              if (!ts || ts > 8.64e15 || (own.since !== undefined && ts < own.since)) continue;
              const provider = typeof msg.provider === "string" ? msg.provider : "";
              const model = typeof msg.model === "string" ? msg.model : "";
              const cloud = provider === "ollama-cloud" || provider === "custom_provider:ollama-cloud-minimax";
              if (!cloud) { partial = true; continue; }
              const tokens = { input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite) };
              const priced = ollamaCost(cloud ? "ollama-cloud" : provider, model, tokens, ts, own.prices);
              unpriced ||= priced.partial;
              entries.push({ type: "message", timestamp: new Date(ts).toISOString(), message: { role: "assistant", provider, model,
                usage: { ...tokens, cost: priced.cost, estimated: priced.priced } } } as EntryLike);
              at = Math.max(at, ts);
            } catch { partial = true; }
          }
          // A usage ledger without message history cannot be priced safely by provider.
          if (rows.length === 0 && db.prepare("SELECT 1 FROM local_runtime_token_usage WHERE session_id = ? LIMIT 1").get(id)) partial = true;
        }
      } finally { db.close(); }
      if (!found || !entries.length) return null;
      const report = buildReport(entries.sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp)), null, { timeZone });
      report.coverage = partial || missing || unpriced ? "partial" : "available";
      if (report.coverage === "partial") report.coverageNote = unpriced
        ? "Partial estimate: some models or cache writes have no known Ollama price."
        : "Partial MiniMax history: some sessions or provider identities may be unavailable.";
      return { report, at };
    },
  };
}
