import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ANTHROPIC_PRICES, listCost, priceOf, withPrices, type PriceOverrides } from "../../../src/prices.js";
import { buildReport, promptExcerpt, type EntryLike, type TokenParts } from "../../../src/report.js";

export const antigravityBrainDir = (env = process.env, home = homedir()) =>
  join(resolve(home, env.BB_ANTIGRAVITY_GEMINI_DIR || ".gemini", env.BB_ANTIGRAVITY_APP_DATA_DIR || "antigravity-cli"), "brain");
const sessionId = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const counter = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
type Step = { timestamp: string } & (
  { prompt: string } | { model: string; tokens: TokenParts; reasoning: number; tools: string[] }
);
type Snapshot = { stamp: number; size: number; ino: number; steps: Map<number, Step>; partial: boolean };

function stepOf(row: Record<string, unknown>): Step | undefined {
  const timestamp = row.created_at;
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return;
  if (row.type === "USER_INPUT" && row.source === "USER_EXPLICIT") {
    return { timestamp, prompt: promptExcerpt(typeof row.content === "string" ? row.content : undefined) };
  }
  if (![row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.cache_creation_input_tokens].some(counter)) return;
  const count = (v: unknown) => counter(v) ? v : 0;
  const tokens = {
    input: count(row.input_tokens), output: count(row.output_tokens),
    cacheRead: count(row.cache_read_tokens), cacheWrite: count(row.cache_write_tokens ?? row.cache_creation_input_tokens),
  };
  const tools = Array.isArray(row.tool_calls) ? row.tool_calls.flatMap(t => typeof t?.name === "string" ? [t.name] : []) : [];
  return { timestamp, model: typeof row.model === "string" ? row.model : "unknown", tokens, reasoning: count(row.thinking_tokens), tools };
}

/** The documented transcript is one snapshot of the trajectory. Chunk and full files can mirror its steps. */
export function createAntigravitySessions(dir = antigravityBrainDir()) {
  const cache = new Map<string, Snapshot>();
  async function read(id: string): Promise<Snapshot | null> {
    let file;
    try {
      file = await open(join(dir, id, ".system_generated", "logs", "transcript.jsonl"), "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      const { mtimeMs: stamp, size, ino } = await file.stat();
      const previous = cache.get(id);
      if (previous && previous.stamp === stamp && previous.size === size && previous.ino === ino) return previous;
      const steps = new Map<number, Step>();
      let partial = false;
      // Read a bounded snapshot even while the CLI appends, and cache only metering fields and prompt excerpts.
      if (size) for await (const line of file.readLines({ start: 0, end: size - 1, autoClose: false })) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { partial = true; continue; }
        if (!row || !counter(row.step_index)) { partial = true; continue; }
        const step = stepOf(row);
        if (step) steps.set(row.step_index, step);
        else if (row.type === "PLANNER_RESPONSE" && row.status === "DONE") partial = true;
      }
      const snapshot = { stamp, size, ino, steps, partial };
      cache.delete(id);
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(id, snapshot);
      return snapshot;
    } finally { await file.close(); }
  }
  return {
    async reportOf(ids: readonly string[], timeZone: string, opts: { prices?: PriceOverrides; since?: number; parentSessionIds?: readonly string[] } = {}) {
      const prices = withPrices(ANTHROPIC_PRICES, opts.prices ?? {});
      const entries: EntryLike[] = [];
      let stamp = 0;
      let partial = false;
      const unpriced = new Set<string>();
      // agy timestamps have second precision. At the fork boundary distinguish copied steps from new ones.
      const since = opts.since ?? 0;
      const boundary = Math.floor(since / 1000) * 1000;
      const inherited = new Set<string>();
      for (const id of new Set(opts.parentSessionIds?.filter(id => sessionId.test(id)))) {
        const parent = await read(id);
        if (!parent) partial = true;
        for (const [idx, step] of parent?.steps ?? []) {
          if (Date.parse(step.timestamp) === boundary) inherited.add(JSON.stringify([idx, step]));
        }
      }
      for (const id of new Set(ids.filter(id => sessionId.test(id)))) {
        const snapshot = await read(id);
        if (!snapshot) { partial = true; continue; }
        stamp = Math.max(stamp, snapshot.stamp);
        partial ||= snapshot.partial;
        for (const [idx, step] of snapshot.steps) {
          const at = Date.parse(step.timestamp);
          if (at < since && at !== boundary) continue;
          if (at === boundary && inherited.has(JSON.stringify([idx, step]))) continue;
          const { timestamp } = step;
          if ("prompt" in step) {
            entries.push({ type: "message", timestamp, message: { role: "user", content: step.prompt } } as EntryLike);
            continue;
          }
          const base = step.model.replace(/-(?:low|medium|high|xhigh|max)$/, "");
          const price = priceOf(prices, step.model) ?? priceOf(prices, base);
          if (!price) unpriced.add(step.model);
          const cost = price ? listCost(price, step.tokens, { tiers: true }) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          const message = {
            role: "assistant", provider: "antigravity-plus", model: step.model,
            usage: { ...step.tokens, reasoning: step.reasoning, cost, estimated: price !== null },
            content: step.tools.map(name => ({ type: "toolCall", name })),
          };
          entries.push({ type: "message", timestamp, message } as EntryLike);
        }
      }
      if (!stamp || !entries.length) return null;
      entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      const report = buildReport(entries, undefined, { timeZone });
      if (!report.calls) return null;
      if (partial || unpriced.size) {
        report.coverage = "partial";
        report.coverageNote = [
          partial ? "Some Antigravity transcript usage is unavailable." : "",
          unpriced.size ? "Tokens include models without a configured price; cost covers priced calls only." : "",
        ].filter(Boolean).join(" ");
      }
      return { report, at: stamp };
    },
  };
}
