import { listCost, type PriceOverrides, type PriceRow, type PriceTable } from "../../../src/prices.js";
import type { CostParts, TokenParts } from "../../../src/report.js";

/** Ollama Cloud list prices, USD per million, https://ollama.com/pricing (2026-11-14).
 * Never use these prices without an explicit Ollama Cloud provider identity.
 * Cache writes are not separately published and require an override if nonzero.
 */
export const OLLAMA_PRICES: PriceTable = {
  "beam": { input: .125, cacheRead: .015, output: .4, cacheWrite: 0 },
  "deepseek-v4.1-flash": { input: .3, cacheRead: .006, output: 1.2, cacheWrite: 0 },
  "deepseek-v4-pro": { input: 1.32, cacheRead: .044, output: 3.96, cacheWrite: 0 },
  "gemma4:31b": { input: .14, cacheRead: .05, output: .4, cacheWrite: 0 },
  "glm-5.3": { input: 1.4, cacheRead: .26, output: 4.4, cacheWrite: 0 },
  "glm-5.3-flash": { input: .15, cacheRead: .03, output: .5, cacheWrite: 0 },
  "glm-5.2": { input: 1.4, cacheRead: .26, output: 4.4, cacheWrite: 0 },
  "gpt-oss:120b": { input: .15, cacheRead: .014, output: .6, cacheWrite: 0 },
  "gpt-oss:20b": { input: .07, cacheRead: .035, output: .3, cacheWrite: 0 },
  "inkling-2-small": { input: .3, cacheRead: .03, output: 1, cacheWrite: 0 },
  "kimi-k3.1-pro": { input: 2, cacheRead: .2, output: 10, cacheWrite: 0 },
  "kimi-k3": { input: 3, cacheRead: .3, output: 15, cacheWrite: 0 },
  "kimi-k2.7-code": { input: .95, cacheRead: .19, output: 4, cacheWrite: 0 },
  "kimi-k2.6": { input: .95, cacheRead: .16, output: 4, cacheWrite: 0 },
  "mimo-v2.6-flash": { input: .14, cacheRead: .0028, output: .28, cacheWrite: 0 },
  "mimo-v2.6-pro": { input: .435, cacheRead: .0036, output: .87, cacheWrite: 0 },
  "minimax-m3.1-flash": { input: .15, cacheRead: .015, output: .6, cacheWrite: 0 },
  "minimax-m3": { input: .6, cacheRead: .12, output: 2.4, cacheWrite: 0 },
  "mistral-large-4": { input: .7, cacheRead: .07, output: 2.1, cacheWrite: 0 },
  "muse-spark-open": { input: 1.25, cacheRead: .15, output: 4.25, cacheWrite: 0 },
  "nemotron-3-super": { input: .015, cacheRead: .015, output: .6, cacheWrite: 0 },
  "nemotron-3-ultra": { input: .1, cacheRead: .1, output: .3, cacheWrite: 0 },
};
const aliases: Record<string, string> = {
  "deepseek-v4-pro:0813": "deepseek-v4-pro",
  "deepseek-v4.1-flash:1017": "deepseek-v4.1-flash",
};
const zero = (): CostParts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

/** Price a specific Ollama Cloud call at its UTC call time; overrides are exact fully qualified IDs. */
export function ollamaCost(provider: string, model: string, tokens: TokenParts, at: number, overrides: PriceOverrides = {}):
  { cost: CostParts; priced: boolean; partial: boolean } {
  if (provider !== "ollama-cloud") return { cost: zero(), priced: false, partial: true };
  const key = "ollama-cloud/" + model;
  const custom = overrides[key] as PriceRow | undefined;
  const base = custom ?? OLLAMA_PRICES[aliases[model] ?? model];
  if (!base) return { cost: zero(), priced: false, partial: true };
  const d = new Date(at);
  const utcDay = d.getUTCDay(), h = d.getUTCHours();
  const offPeak = !custom && (model.startsWith("deepseek-v4.1-flash") || model.startsWith("deepseek-v4-pro")) &&
    (utcDay === 0 || utcDay === 6 || h < 12 || h >= 18);
  const price = offPeak ? { ...base, input: base.input / 2, output: base.output / 2, cacheRead: base.cacheRead / 2 } : base;
  return { cost: listCost(price, tokens, { tiers: true }), priced: true, partial: tokens.cacheWrite > 0 && !custom };
}
