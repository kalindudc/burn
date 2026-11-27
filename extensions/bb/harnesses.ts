import { ANTHROPIC_PRICES, OPENAI_CODEX_PRICES, type PriceOverrides, type PriceTable, withPrices } from "../../src/prices.js";

/** How Burn reads one bb provider's threads. */
export interface Harness {
  /** "pi-log": the host entry reads pi's session logs; "opencode-db": opencode's own database; "events": the usage bb records. */
  reader: "pi-log" | "omp-log" | "opencode-db" | "claude-log" | "antigravity-log" | "events";
  /** The list prices for tokens of a session that records no cost; null to show tokens. */
  prices: PriceTable | null;
  /** Whether inputTokens includes cached and cache-write tokens; null when unknown. */
  cacheInInput: boolean | null;
  // Each usage event is one model call, so price tiers and the stop apply.
  perCall: boolean;
  /** The bridge reuses the parent provider id for native child usage counters. */
  separateChildCounters?: boolean;
}

const HARNESSES: Readonly<Record<string, Harness>> = {
  pi: { reader: "pi-log", prices: null, cacheInInput: false, perCall: true },
  "antigravity-plus": { reader: "antigravity-log", prices: ANTHROPIC_PRICES, cacheInInput: false, perCall: true },
  "acp-omp": { reader: "omp-log", prices: null, cacheInInput: false, perCall: true },
  "acp-opencode": { reader: "opencode-db", prices: null, cacheInInput: false, perCall: true },
  // bb-plugin-opencode2 runs OpenCode v2 itself and keeps the same database
  // (session_message / session_v2), which the opencode-db reader already reads.
  opencode2: { reader: "opencode-db", prices: null, cacheInInput: false, perCall: true },
  codex: { reader: "events", prices: OPENAI_CODEX_PRICES, cacheInInput: true, perCall: true, separateChildCounters: true },
  "claude-code": { reader: "claude-log", prices: ANTHROPIC_PRICES, cacheInInput: false, perCall: false },
};

const OTHER: Harness = { reader: "events", prices: null, cacheInInput: null, perCall: false };

const NAMES: Readonly<Record<string, string>> = { "antigravity-plus": "Antigravity", pi: "pi", "acp-omp": "OMP", "acp-opencode": "OpenCode", opencode2: "OpenCode v2", codex: "Codex", "claude-code": "Claude Code" };

/** A bb provider's name for people; one Burn does not know reads as its id. */
export const harnessName = (providerId: string): string => (Object.hasOwn(NAMES, providerId) ? (NAMES[providerId] as string) : providerId);

export const harnessOf = (providerId: string): Harness => (Object.hasOwn(HARNESSES, providerId) ? (HARNESSES[providerId] as Harness) : OTHER);

/** Host readers participating in the shared report, refresh, and pricing pipeline. */
export const hostReaders = {
  "pi-log": "pi", "omp-log": "omp", "opencode-db": "opencode", "claude-log": "claude", "antigravity-log": "antigravity",
} as const satisfies Record<Exclude<Harness["reader"], "events">, string>;
export type HostHarness = (typeof hostReaders)[keyof typeof hostReaders];

/** The harness with the settings' price overrides laid over its list prices. */
export function harnessWithPrices(providerId: string, overrides: PriceOverrides = {}): Harness {
  const harness = harnessOf(providerId);
  if (harness.prices) return { ...harness, prices: withPrices(harness.prices, overrides) };
  // Standard BB token events can be priced by model even for a provider without a built-in table.
  return harness.reader === "events" && Object.keys(overrides).length ? { ...harness, prices: overrides } : harness;
}
