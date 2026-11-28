import { z } from "zod";
import { CALL_TIME_BUCKETS } from "../../../src/report.js";

// The Spend page's slice of the plugin's rpc contract. server.ts spreads it into the one contract it registers.

export const SPEND_RANGES = ["today", "7d", "30d"] as const;
export type SpendRange = (typeof SPEND_RANGES)[number];
/** Which calendar days count: the bb server's local ones, or UTC ones as Shopify's AI proxy counts them. */
export const SPEND_ZONES = ["local", "utc"] as const;
export type SpendZone = (typeof SPEND_ZONES)[number];
/** What the page ranks and charts by. */
export const SPEND_METRICS = ["cost", "tokens", "calls"] as const;
export type SpendMetric = (typeof SPEND_METRICS)[number];
/** The page's panels that can be hidden, in page order. */
export const SPEND_PANELS = ["usage", "chart", "mix", "time", "activity", "threads", "models", "projects", "harnesses"] as const;
export type SpendPanel = (typeof SPEND_PANELS)[number];

const amount = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const ratio = z.number().finite().nullable();
const usage = { cost: amount, tokens: amount, calls: count };

export const spendOutputSchema = z.object({
  range: z.enum(SPEND_RANGES),
  tz: z.enum(SPEND_ZONES),
  metric: z.enum(SPEND_METRICS),
  /** Today in `tz`, YYYY-MM-DD: the latest day a range can end on. */
  today: z.string(),
  /** Days covered in `tz`, oldest first, YYYY-MM-DD; `models` are the chart's, folded as `models` below. */
  days: z.array(z.object({ day: z.string(), ...usage, models: z.array(z.object({ key: z.string(), ...usage })) })),
  total: amount,
  /** The same length of time just before the range, for "▲ 18% vs previous 7 days". */
  previousTotal: amount,
  tokens: amount,
  previousTokens: amount,
  calls: count,
  prompts: count,
  runningCount: count,
  threadCount: count,
  overBudgetCount: count,
  medianThreadCost: amount.nullable(),
  perCall: amount.nullable(),
  cacheHitPct: ratio,
  mix: z.object({
    tokens: z.object({ input: amount, output: amount, cacheRead: amount, cacheWrite: amount, reasoning: amount }),
    costs: z.object({ input: amount, output: amount, cacheRead: amount, cacheWrite: amount }),
  }),
  /** Call times in ms, from the calls that recorded one. */
  callTime: z.object({
    buckets: z.array(count).length(CALL_TIME_BUCKETS),
    timed: count,
    failed: count,
    aborted: count,
    p50: amount.nullable(),
    p90: amount.nullable(),
  }),
  /** Day Cost only: known dollar amounts in UTC hour buckets, not reconciled to the day total. */
  hourlyCost: z.object({
    start: z.number().int(),
    /** End of the calendar day, or the request time if the day is in progress. */
    end: z.number().int(),
    /** The server calendar's IANA zone, or null if the runtime cannot name it. */
    timeZone: z.string().nullable(),
    /** `at` is the start of the bucket, in epoch milliseconds. Even a historic offset change spans at most 48 hours. */
    hours: z.array(z.object({ at: z.number().int(), cost: amount })).max(48),
    omittedBoundaryCost: z.boolean(),
    /** Only the newest local Day for all projects at discounted prices matches the daily budget. */
    budget: amount.nullable(),
  }).optional(),
  /** Each day's use per hour of the day, in `metric`. */
  activity: z.array(z.object({ day: z.string(), hours: z.array(amount).length(24) })),
  threads: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      projectName: z.string().nullable(),
      model: z.string().nullable(),
      /** The harness's name, such as "pi" or "Codex". */
      harness: z.string(),
      childCount: count,
      calls: count,
      tokens: amount,
      rangeCost: amount,
      total: amount,
      budgetCost: amount.optional(),
      budget: amount.nullable(),
      running: z.boolean(),
      estimated: z.boolean(),
    }),
  ),
  projects: z.array(z.object({ projectId: z.string().nullable(), name: z.string(), ...usage })),
  /** The chart's models, Other last. */
  models: z.array(z.object({ key: z.string(), ...usage })),
  /** The Models table: use from the chosen days; the four ratios from the whole life of the threads in range. */
  modelStats: z.array(
    z.object({
      key: z.string(),
      harness: z.string().nullable(),
      ...usage,
      cacheHitPct: ratio,
      avgCallMs: ratio,
      outputPerSec: ratio,
      failedPct: ratio,
      estimated: z.boolean(),
    }),
  ),
  harnesses: z.array(z.object({ providerId: z.string(), name: z.string(), ...usage, estimated: z.boolean() })),
  projectOptions: z.array(z.object({ projectId: z.string(), name: z.string() })),
  dailyBudget: amount.nullable(),
  /** Threads with a stored report in any project and at any time; 0 means no thread has reported. */
  reportedThreads: count,
  /** Threads whose figures this answer could not read in time; the rest arrive with a usage signal. */
  reading: count,
  /** Some counted spend is a list-price estimate. */
  estimated: z.boolean(),
  /** At list price, without Burn's discount settings; budgets are left out, since they apply to the discounted figures. */
  listPrice: z.boolean(),
});
export type SpendOutput = z.infer<typeof spendOutputSchema>;

const panelsSchema = z.object({ hidden: z.array(z.enum(SPEND_PANELS)).max(SPEND_PANELS.length) });
export type SpendPanels = z.infer<typeof panelsSchema>;

export const spendMethods = {
  spend: {
    input: z.object({
      range: z.enum(SPEND_RANGES),
      projectId: z.string().max(100).nullable(),
      tz: z.enum(SPEND_ZONES).default("local"),
      metric: z.enum(SPEND_METRICS).default("cost"),
      /** Answer at list price, without Burn's discount settings. */
      listPrice: z.boolean().default(false),
      /** The range's last day in `tz`; null, or a day after today, ends it today. */
      end: z.iso.date().nullable().default(null),
    }),
    output: spendOutputSchema,
  },
  /** The panels hidden on the Burn page, kept by the plugin for every bb window. */
  spendPanels: { input: z.object({}), output: panelsSchema },
  setSpendPanels: { input: panelsSchema, output: panelsSchema },
};
