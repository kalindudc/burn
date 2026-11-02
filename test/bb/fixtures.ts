import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { CostRow, rpcContract, UsageAnswer } from "../../extensions/bb/contract.js";
import type { EventRow, Totals } from "../../extensions/bb/ledger.js";
import { sampleReport } from "../helpers.js";

export const THREAD = "thr_aaaaaaaa";
export const CHILD = "thr_cccccccc";
export const OTHER = "thr_bbbbbbbb";
export const QUIET = { budget: null, stopAtBudget: false, notifyExpensiveTurn: false };

export function answer(over: Partial<UsageAnswer> = {}): UsageAnswer {
  return {
    report: sampleReport(),
    source: "pi",
    reportedAt: Date.now() - 12_000,
    title: "burn UX polish",
    budget: null,
    policy: QUIET,
    family: { total: 4.82, calls: 23, estimated: false, children: [] },
    ...over,
  };
}

export const costRow = (over: Partial<CostRow> & { threadId: string }): CostRow => ({
  cost: 4.82,
  label: "$4.82",
  familyCost: null,
  budget: null,
  state: "none",
  estimated: false,
  ...over,
});

export const totals = (over: Partial<Totals>): Totals => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  ...over,
});

let eventSeq = 0;

/** A thread event row as bb stores it; every row gets the next seq. */
export const event = (threadId: string, type: string, data: unknown, at = Date.now()): EventRow =>
  ({ id: `ev_${++eventSeq}`, scope: { kind: "thread" }, threadId, seq: eventSeq, createdAt: at, type, data }) as unknown as EventRow;

type Request = { initiator?: "user" | "agent" | "system"; kind?: "thread-start" | "new-turn" | "auto" | "steer" };
export const requestEvent = (threadId: string, text: string, model: string, opts: Request = {}) =>
  event(threadId, "client/turn/requested", {
    initiator: opts.initiator ?? "user",
    target: { kind: opts.kind ?? "new-turn" },
    input: [{ type: "text", text }],
    execution: { model },
  });
export const usageEvent = (threadId: string, total: Totals, last: Totals = total, session = "s1") =>
  event(threadId, "thread/tokenUsage/updated", { providerThreadId: session, tokenUsage: { total, last, modelContextWindow: null } });
export const costEvent = (threadId: string, amount: number, currency = "USD", session = "s1") =>
  event(threadId, "thread/contextWindowUsage/updated", {
    providerThreadId: session,
    contextWindowUsage: { cost: { amount, currency }, estimated: false, modelContextWindow: null, usedTokens: null },
  });
export const identityEvent = (threadId: string, providerThreadId: string) => event(threadId, "thread/identity", { providerThreadId });

type ListArgs = { threadId: string; types?: readonly string[]; afterSeq?: string; order?: "asc" | "desc"; limit?: string };

/** bb's `threads.events.list` over `rows()`: one thread's rows of the types asked for, after a seq, oldest first, one page of 100 unless asked for fewer. */
export const listEvents =
  (rows: () => readonly EventRow[]) =>
  async ({ threadId, types, afterSeq, limit = "100" }: ListArgs): Promise<EventRow[]> => {
    if (Number(limit) > 100) throw new Error("Thread event limit cannot exceed 100");
    return rows()
      .filter((r) => r.threadId === threadId && (types === undefined || types.includes(r.type)) && (afterSeq === undefined || r.seq > Number(afterSeq)))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, Number(limit));
  };

// One Codex session: two responses, with cached tokens inside inputTokens as Codex counts them.
export const CODEX_1 = totals({
  inputTokens: 10_000,
  cachedInputTokens: 6000,
  cacheReadInputTokens: 6000,
  outputTokens: 1000,
  reasoningOutputTokens: 400,
  totalTokens: 11_000,
});
export const CODEX_2 = totals({ inputTokens: 20_000, cachedInputTokens: 16_000, cacheReadInputTokens: 16_000, outputTokens: 2000, totalTokens: 22_000 });
export const CODEX_1_2 = totals({
  inputTokens: 30_000,
  cachedInputTokens: 22_000,
  cacheReadInputTokens: 22_000,
  outputTokens: 3000,
  reasoningOutputTokens: 400,
  totalTokens: 33_000,
});

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

/** Every rpc method, answering `usage` with `usage()` and recording the calls. */
export function backend(usage: () => UsageAnswer = () => answer(), over: Partial<Handlers> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const record =
    <I, O>(method: string, fn: (input: I) => O) =>
    (input: I): O => {
      calls.push({ method, input });
      return fn(input);
    };
  const rpc: Handlers = {
    usage: record("usage", over.usage ?? (() => usage())),
    setBudget: record("setBudget", over.setBudget ?? (() => ({ budget: null, policy: QUIET }))),
    costs: record("costs", over.costs ?? (({ threadIds }) => ({ threads: threadIds.map((threadId) => costRow({ threadId })) }))),
    overBudget: record("overBudget", over.overBudget ?? (() => ({ threads: [] }))),
    spend: record(
      "spend",
      over.spend ??
        (() => {
          throw new Error("the Spend page is not part of these tests");
        }),
    ),
    spendPanels: record("spendPanels", over.spendPanels ?? (() => ({ hidden: [] }))),
    setSpendPanels: record("setSpendPanels", over.setSpendPanels ?? ((input) => input)),
  };
  return { rpc, calls, callsTo: (method: string) => calls.filter((c) => c.method === method) };
}
