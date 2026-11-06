import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentalHostWatchListener } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type ExperimentalFakeHostRpcCall, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_BATCH } from "../../extensions/bb/host/contract.js";
import { createHostEntry } from "../../extensions/bb/host/entry.js";
import { sessionFile } from "../../extensions/bb/host/pi-sessions.js";
import type { EventRow } from "../../extensions/bb/ledger.js";
import { createThreadDirectory } from "../../extensions/bb/directory.js";
import { createReportSource } from "../../extensions/bb/sources.js";
import { assistant, sampleReport, user } from "../helpers.js";
import { CODEX_1, CODEX_1_2, CODEX_2, listEvents, requestEvent, usageEvent } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const id = (n: number) => `thr_${String(n).padStart(8, "0")}`;
const A = "host_a";
const B = "host_b";
const costOf = (total: number) => sampleReport({ cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });

/** `host: null` is a thread with no environment, as a new one is until bb has created its machine. */
type Thread = { host: string | null; provider?: string; status?: "active" | "idle" | "error" | "starting"; sessions?: string[]; source?: string; deleted?: boolean };

/** A source over fake threads; each host answers with `costs[threadId]`, or throws when listed in `offline`. */
function setup(
  threads: Record<string, Thread>,
  opts: { offline?: string[]; disconnected?: string[]; listFails?: boolean; directory?: boolean; coverageNote?: string; retryMs?: number; retryMax?: number; hostWaitStepsMs?: number[] } = {},
) {
  const costs: Record<string, number> = {};
  const rows: EventRow[] = [];
  const calls: ExperimentalFakeHostRpcCall[] = [];
  const offline = new Set(opts.offline ?? []);
  // The hosts bb lists, and which of them it says are connected, as bb's host list and `host:changed` events report them.
  const listed = new Map<string, boolean>([[A, true], [B, true]]);
  for (const t of Object.values(threads)) if (t.host) listed.set(t.host, true);
  for (const hostId of opts.disconnected ?? []) listed.set(hostId, false);
  const watchers: Array<(event: { id?: string; changes: string[] }) => void> = [];
  let hostLists = 0;
  let gate: Promise<void> | null = null;
  let getGate: Promise<void> | null = null;
  let getFails = false;
  // Runs after bb has worked out a page of identities and before it answers, as a slow connection would.
  let identityHook: (() => Promise<void>) | null = null;
  let now = 1_000_000;
  const { bb, harness } = createFakePluginHost({
    pluginId: "burn",
    sdk: {
      threads: {
        list: async ({ limit, offset = 0 }: { limit?: number; offset?: number } = {}) =>
          Object.entries(threads)
            .map(([threadId, t]) => ({
              id: threadId,
              title: null,
              titleFallback: null,
              projectId: "proj_1",
              providerId: t.provider ?? "pi",
              environmentId: t.host ? `env_${t.host}` : null,
              environmentHostId: t.host,
              status: t.status ?? "idle",
              updatedAt: 1,
              archivedAt: null,
              deletedAt: null,
              visibility: "visible" as const,
            }))
            .slice(offset, limit === undefined ? undefined : offset + limit),
        get: async ({ threadId }: { threadId: string }) => {
          if (getGate) await getGate;
          // Read once bb answers, so a test can change the thread while a read is held.
          const t = threads[threadId];
          if (getFails) throw new Error("bb is unreachable");
          if (!t) throw new Error(`no thread ${threadId}`);
          return makeThreadResponse({
            ...(t.deleted ? { deletedAt: 1 } : {}),
            id: threadId,
            providerId: t.provider ?? "pi",
            environmentId: t.host ? `env_${t.host}` : null,
            status: t.status ?? "idle",
            ...(t.source ? { sourceThreadId: t.source } : {}),
          });
        },
        events: {
          list: async (args: Parameters<ReturnType<typeof listEvents>>[0]) => {
            if (!args.types?.includes("thread/identity")) return listEvents(() => rows)(args);
            // One identity event per entry of `sessions`, paged as bb pages them.
            const identities = (threads[args.threadId]?.sessions ?? [`pi_${args.threadId}`]).map(
              (providerThreadId, n) => ({ type: "thread/identity", threadId: args.threadId, seq: n + 1, data: { providerThreadId } }) as unknown as EventRow,
            );
            const page = await listEvents(() => identities)(args);
            if (identityHook) await identityHook();
            return page;
          },
        },
      },
      environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: environmentId.slice(4) }) },
      hosts: {
        list: async () => {
          hostLists++;
          if (opts.listFails) throw new Error("bb is busy");
          return [...listed].map(([hostId, connected]) => ({ id: hostId, status: connected ? "connected" : "disconnected" }));
        },
      },
      subscribe: ((args: { callback: (event: { id?: string; changes: string[] }) => void }) => {
        watchers.push(args.callback);
        return () => void watchers.splice(watchers.indexOf(args.callback), 1);
      }) as never,
    },
    experimental_callHostRpc: async (call) => {
      calls.push(call);
      if (gate) await gate;
      if (offline.has(call.hostId)) throw new Error(`host ${call.hostId} is not connected`);
      const input = call.input as { threads: { threadId: string }[] };
      return {
        dir: "/home/me/.bb/pi-bridge-sessions",
        reports: input.threads.map(({ threadId }) =>
          threadId in costs
            ? {
                threadId,
                report: { ...costOf(costs[threadId]!), ...(opts.coverageNote ? { coverageNote: opts.coverageNote, coverage: "partial" } : {}) },
                at: 1000 * costs[threadId]!,
              }
            : { threadId, report: null, at: null },
        ),
      };
    },
  });
  const changed: string[][] = [];
  const source = createReportSource(bb, {
    onChange: (ids) => void changed.push(ids),
    now: () => now,
    ...(opts.directory ? { threads: createThreadDirectory(bb, { now: () => now }) } : {}),
    ...(opts.retryMs === undefined ? {} : { retryMs: opts.retryMs }),
    ...(opts.retryMax === undefined ? {} : { retryMax: opts.retryMax }),
    ...(opts.hostWaitStepsMs === undefined ? {} : { hostWaitStepsMs: opts.hostWaitStepsMs }),
  });
  const asked = (hostId?: string) =>
    calls
      .filter((c) => hostId === undefined || c.hostId === hostId)
      .map((c) => (c.input as { threads: { threadId: string }[] }).threads.map((t) => t.threadId));
  const cost = async (...ids: string[]) => {
    const got = await source.reportsOf(ids);
    return ids.map((i) => got.get(i)?.report.cost.total ?? null);
  };
  const hold = (): (() => void) => {
    let release = (): void => undefined;
    gate = new Promise((resolve) => {
      release = () => {
        gate = null;
        resolve();
      };
    });
    return release;
  };
  /** Holds the identity answers bb has already worked out, as a slow connection would. */
  const holdIdentities = (): (() => void) => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        identityHook = null;
        resolve();
      };
    });
    identityHook = () => gate;
    return release;
  };
  const onIdentities = (hook: (() => Promise<void>) | null): void => {
    identityHook = hook;
  };
  const holdLookups = (): (() => void) => {
    let release = (): void => undefined;
    getGate = new Promise((resolve) => {
      release = () => {
        getGate = null;
        resolve();
      };
    });
    return release;
  };
  const failLookups = (on: boolean): void => {
    getFails = on;
  };
  /** Lets the host list the source asks for when it is created come back. */
  const hostsKnown = async (): Promise<void> => {
    for (let n = 0; n < 5; n++) await Promise.resolve();
  };
  /** bb says the host connected or disconnected: a `host:changed` event, with the list following it. */
  const hostChanged = (hostId: string, change: "host-connected" | "host-disconnected"): void => {
    listed.set(hostId, change === "host-connected");
    for (const watcher of [...watchers]) watcher({ id: hostId, changes: [change] });
  };
  /** A host that changed with no event reaching Burn: only the list shows it. */
  const hostListed = (hostId: string, connected: boolean): void => void listed.set(hostId, connected);
  const warnings = (): string[] => harness.inspection.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
  return { bb, harness, source, costs, rows, calls, hostsKnown, hostChanged, hostListed, hostLists: () => hostLists, warnings, watchers, asked, cost, changed, offline, hold, holdLookups, failLookups, holdIdentities, onIdentities, tick: (ms: number) => (now += ms) };
}

describe("createReportSource", () => {
  it(`asks each thread's host for its report, in batches of ${HOST_BATCH}, with its session ids and the server's zone`, async () => {
    const threads: Record<string, Thread> = { [id(100)]: { host: B, sessions: ["pi_old", "pi_new"] } };
    for (let n = 0; n < 45; n++) threads[id(n)] = { host: A };
    const s = setup(threads);
    for (const t of Object.keys(threads)) s.costs[t] = 1;
    const got = await s.source.reportsOf(Object.keys(threads));
    expect(got.size).toBe(46);
    expect([...got.values()].every((r) => r.source === "log")).toBe(true);
    expect(s.asked(A).map((batch) => batch.length)).toEqual([HOST_BATCH, 45 - HOST_BATCH]);
    expect(s.asked(B)).toEqual([[id(100)]]);
    const input = s.calls.find((c) => c.hostId === B)?.input;
    expect(input).toEqual({
      harness: "pi",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      threads: [{ threadId: id(100), sessionIds: ["pi_old", "pi_new", id(100)] }],
    });
  });

  it("does not persist a host read that a reprice overtook", async () => {
    const t = id(1);
    const s = setup({ [t]: { host: A } });
    s.costs[t] = 1;
    const release = s.hold();
    const run = s.source.reportsOf([t]);
    await vi.waitFor(() => expect(s.calls).toHaveLength(1));
    s.source.reprice();
    release();
    await run;
    expect(await s.bb.storage.kv.get(`log:${t}`)).toBeUndefined();
    await s.source.reportsOf([t]);
    expect(await s.bb.storage.kv.get(`log:${t}`)).toMatchObject({ report: { cost: { total: 1 } } });
  });

  it("looks a working thread up again soon when bb has not named its pi session yet", async () => {
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: A, status: "active", sessions: [] } };
    const s = setup(threads, { retryMs: 10 });
    s.costs[t] = 1;
    await s.source.reportsOf([t]);
    const first = s.calls.at(-1)?.input as { threads: { sessionIds: string[] }[] };
    expect(first.threads[0]?.sessionIds).toEqual([t]);
    threads[t] = { host: A, status: "active", sessions: [`pi_${t}`] };
    await vi.waitFor(() => expect(s.changed.flat()).toContain(t));
    await s.source.reportsOf([t]);
    const next = s.calls.at(-1)?.input as { threads: { sessionIds: string[] }[] };
    expect(next.threads[0]?.sessionIds).toContain(`pi_${t}`);
  });

  it("stops retrying a working thread that never gets a session identity", async () => {
    const t = id(1);
    const s = setup({ [t]: { host: A, status: "active", sessions: [] } }, { retryMs: 5, retryMax: 2 });
    s.costs[t] = 1;
    for (let i = 0; i < 4; i++) {
      await s.source.reportsOf([t]);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(s.changed.flat().filter((changed) => changed === t)).toHaveLength(2);
  });

  it("keeps a report for a minute, then asks again", async () => {
    const s = setup({ [id(1)]: { host: A } });
    s.costs[id(1)] = 2;
    expect(await s.cost(id(1))).toEqual([2]);
    s.costs[id(1)] = 3;
    expect(await s.cost(id(1))).toEqual([2]);
    s.tick(60_000);
    expect(await s.cost(id(1))).toEqual([3]);
    expect(s.calls).toHaveLength(2);
  });

  it("rereads exactly the threads whose sessions changed, or every thread on the host for all", async () => {
    const s = setup({ [id(1)]: { host: A }, [id(2)]: { host: A, sessions: ["pi_shared"] }, [id(3)]: { host: B, sessions: ["pi_shared"] } });
    for (const t of [id(1), id(2), id(3)]) s.costs[t] = 1;
    await s.source.reportsOf([id(1), id(2), id(3)]);
    await s.harness.behavior.experimental_emitHostSignal(A, "changed", { sessionIds: ["pi_shared", "pi_unknown"], all: false });
    expect(s.changed).toEqual([[id(2)]]);
    s.costs[id(2)] = 5;
    expect(await s.cost(id(1), id(2), id(3))).toEqual([1, 5, 1]);
    expect(s.asked().at(-1)).toEqual([id(2)]);
    await s.harness.behavior.experimental_emitHostSignal(A, "changed", { sessionIds: [], all: true });
    expect(s.changed.at(-1)?.sort()).toEqual([id(1), id(2)]);
    await s.harness.behavior.experimental_emitHostSignal(B, "changed", { sessionIds: ["pi_nobody"], all: false });
    expect(s.changed).toHaveLength(2);
  });

  it("does not keep a read that a change overtook", async () => {
    const s = setup({ [id(1)]: { host: A } });
    s.costs[id(1)] = 1;
    await s.source.reportsOf([id(1)]);
    await s.harness.behavior.experimental_emitHostSignal(A, "changed", { sessionIds: [`pi_${id(1)}`], all: false });
    const release = s.hold();
    const racing = s.cost(id(1));
    await vi.waitFor(() => expect(s.calls).toHaveLength(2));
    await s.harness.behavior.experimental_emitHostSignal(A, "changed", { sessionIds: [`pi_${id(1)}`], all: false });
    s.costs[id(1)] = 2;
    release();
    expect(await racing).toEqual([2]);
    await s.source.reportsOf([id(1)]);
    expect(s.calls).toHaveLength(3);
  });

  it("drops a host's reports when its worker exits", async () => {
    const s = setup({ [id(1)]: { host: A }, [id(2)]: { host: B } });
    s.costs[id(1)] = 1;
    s.costs[id(2)] = 1;
    await s.source.reportsOf([id(1), id(2)]);
    await s.harness.behavior.experimental_emitHostWorkerExit(A);
    await s.source.reportsOf([id(1), id(2)]);
    expect(s.asked()).toEqual([[id(1)], [id(2)], [id(1)]]);
  });

  it("serves the last report a host gave when that host is unreachable, and logs it once a minute", async () => {
    const s = setup({ [id(1)]: { host: A }, [id(2)]: { host: A } });
    s.costs[id(1)] = 4;
    const set = vi.spyOn(s.bb.storage.kv, "set");
    await s.source.reportsOf([id(1), id(2)]);
    expect(await s.bb.storage.kv.get(`log:${id(1)}`)).toMatchObject({ report: { cost: { total: 4 } }, at: 4000 });
    expect(await s.bb.storage.kv.get(`log:${id(2)}`)).toBeUndefined();
    s.tick(60_000);
    await s.source.reportsOf([id(1)]);
    expect(s.calls).toHaveLength(2);
    expect(set).toHaveBeenCalledTimes(1);
    s.tick(60_000);
    s.offline.add(A);
    expect(await s.cost(id(1), id(2))).toEqual([4, null]);
    s.tick(1000);
    await s.harness.behavior.experimental_emitHostSignal(A, "changed", { sessionIds: [], all: true });
    expect(await s.cost(id(1))).toEqual([4]);
    const warnings = s.harness.inspection.logEntries.filter((e) => e.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(`host ${A} is not connected`);
    s.offline.delete(A);
    s.costs[id(1)] = 6;
    s.tick(60_000);
    expect(await s.cost(id(1))).toEqual([6]);
  });

  it("joins a read already under way rather than asking the host again", async () => {
    const s = setup({ [id(1)]: { host: A } });
    s.costs[id(1)] = 2;
    const release = s.hold();
    const first = s.cost(id(1));
    await vi.waitFor(() => expect(s.calls).toHaveLength(1));
    const second = s.cost(id(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.calls).toHaveLength(1);
    release();
    expect(await Promise.all([first, second])).toEqual([[2], [2]]);
  });

  it("answers by the deadline with the last report kept, then names the threads a late read changed", async () => {
    const s = setup({ [id(1)]: { host: A }, [id(2)]: { host: A } });
    s.costs[id(1)] = 2;
    s.costs[id(2)] = 4;
    await s.source.reportsOf([id(1), id(2)]);
    s.tick(60_000);
    s.costs[id(1)] = 3;
    const release = s.hold();
    let got: Map<string, { report: { cost: { total: number } } }> | null = null;
    try {
      got = await Promise.race([
        s.source.reportsOf([id(1), id(2)], { deadlineMs: 20 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
    } finally {
      release();
    }
    expect([got?.get(id(1))?.report.cost.total, got?.get(id(2))?.report.cost.total]).toEqual([2, 4]);
    await vi.waitFor(() => expect(s.changed).toEqual([[id(1)]]));
    expect(await s.cost(id(1), id(2))).toEqual([3, 4]);
    expect(s.calls).toHaveLength(2);
  });

  it("waits for a read already under way no longer than the caller that started it waited", async () => {
    const s = setup({ [id(1)]: { host: A } });
    s.costs[id(1)] = 2;
    await s.source.reportsOf([id(1)]);
    s.tick(60_000);
    const release = s.hold();
    try {
      await s.source.reportsOf([id(1)], { deadlineMs: 20 });
      const started = performance.now();
      const joined = await Promise.race([
        s.source.reportsOf([id(1)], { deadlineMs: 2_000 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      expect(joined?.get(id(1))?.report.cost.total).toBe(2);
      expect(performance.now() - started).toBeLessThan(200);
    } finally {
      release();
    }
    expect(s.calls).toHaveLength(2);
  });

  it("keeps what it knows of more than a thousand threads, so a second read within a minute asks nothing", async () => {
    const threads: Record<string, Thread> = {};
    for (let n = 0; n < 1100; n++) threads[id(n)] = { host: A };
    const s = setup(threads);
    for (const t of Object.keys(threads)) s.costs[t] = 1;
    await s.source.reportsOf(Object.keys(threads));
    const lookups = s.harness.inspection.sdk.callsTo("threads.get").length;
    const asked = s.calls.length;
    await s.source.reportsOf(Object.keys(threads));
    expect(s.harness.inspection.sdk.callsTo("threads.get").length).toBe(lookups);
    expect(s.calls.length).toBe(asked);
  });

  it("reads every thread's row from one shared listing instead of a call per thread", async () => {
    const threads: Record<string, Thread> = {};
    for (let n = 0; n < 50; n++) threads[id(n)] = { host: A };
    const s = setup(threads, { directory: true });
    for (const t of Object.keys(threads)) s.costs[t] = 1;
    const got = await s.source.reportsOf(Object.keys(threads));
    expect(got.size).toBe(50);
    expect(s.harness.inspection.sdk.callsTo("threads.list")).toHaveLength(1);
    expect(s.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
    expect(s.harness.inspection.sdk.callsTo("environments.get")).toHaveLength(0);
  });

  it("names how many threads it is still reading while a host holds them", async () => {
    const threads: Record<string, Thread> = {};
    for (let n = 0; n < 5; n++) threads[id(n)] = { host: A };
    const s = setup(threads, { directory: true });
    for (const t of Object.keys(threads)) s.costs[t] = 1;
    const release = s.hold();
    const asking = s.source.reportsOf(Object.keys(threads), { deadlineMs: 20 });
    await vi.waitFor(() => expect(s.calls.length).toBeGreaterThan(0));
    expect(s.source.reading(Object.keys(threads))).toBe(5);
    release();
    await asking;
    await vi.waitFor(() => expect(s.source.reading(Object.keys(threads))).toBe(0));
  });

  it("warms the threads' details without asking a host, and reads each thread only once", async () => {
    const threads: Record<string, Thread> = {};
    for (let n = 0; n < 50; n++) threads[id(n)] = { host: A };
    const s = setup(threads, { directory: true });
    await s.source.warm(Object.keys(threads));
    expect(s.calls).toHaveLength(0);
    const read = s.harness.inspection.sdk.callsTo("threads.events.list").length;
    await s.source.warm(Object.keys(threads));
    expect(s.harness.inspection.sdk.callsTo("threads.events.list").length).toBe(read);
  });

  it("reads a thread of another provider from the usage bb records and asks no host, nor for a thread without a machine", async () => {
    const s = setup({ [id(1)]: { host: A, provider: "codex" }, [id(2)]: { host: null } });
    s.rows.push(requestEvent(id(1), "go", "gpt-5.5"), usageEvent(id(1), CODEX_1));
    const got = await s.source.reportsOf([id(1), id(2), id(3)]);
    expect([...got.keys()]).toEqual([id(1)]);
    expect(got.get(id(1))).toMatchObject({ source: "events", report: { estimated: true } });
    expect(got.get(id(1))?.report.cost.total).toBeCloseTo(0.053, 9);
    expect(s.calls).toEqual([]);
    expect(s.harness.inspection.logEntries.some((e) => e.level === "warn" && e.message.includes(id(3)))).toBe(true);
    expect(await s.source.harnessOf(id(1))).toMatchObject({ reader: "events", perCall: true });
    expect(await s.source.harnessOf(id(2))).toMatchObject({ reader: "pi-log" });
    expect(await s.source.harnessOf(id(3))).toBeNull();
  });

  it("asks the host for an opencode thread's database, and again when bb says it went idle", async () => {
    const s = setup({ [id(1)]: { host: A, provider: "acp-opencode", sessions: ["ses_one"] } });
    s.costs[id(1)] = 7;
    expect(await s.cost(id(1))).toEqual([7]);
    expect(s.calls[0]?.input).toMatchObject({
      harness: "opencode",
      threads: [{ threadId: id(1), sessionIds: ["ses_one", id(1)] }],
    });
    expect(await s.source.harnessOf(id(1))).toMatchObject({ reader: "opencode-db" });
    s.costs[id(1)] = 9;
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: id(1), providerId: "acp-opencode", status: "idle" }),
      lastAssistantText: null,
    });
    expect(await s.cost(id(1))).toEqual([9]);
    expect(s.asked().at(-1)).toEqual([id(1)]);
  });

  it("reads an opencode thread again when bb records new events for it, and leaves pi threads alone", async () => {
    const s = setup({ [id(1)]: { host: A, provider: "acp-opencode", sessions: ["ses_one"] }, [id(2)]: { host: A } });
    s.costs[id(1)] = 7;
    s.costs[id(2)] = 1;
    expect(await s.cost(id(1), id(2))).toEqual([7, 1]);
    s.costs[id(1)] = 9;
    s.costs[id(2)] = 2;
    const before = s.calls.length;
    for (const [threadId, providerId] of [
      [id(1), "acp-opencode"],
      [id(2), "pi"],
    ]) {
      await s.harness.behavior.emitThreadEvent("experimental_thread.events", {
        thread: makeThreadResponse({ id: threadId, providerId }),
        sequence: 1,
      });
    }
    expect(s.changed).toEqual([[id(1)]]);
    expect(await s.cost(id(1))).toEqual([9]);
    expect(s.asked().at(-1)).toEqual([id(1)]);
    expect(await s.cost(id(2))).toEqual([1]);
    expect(s.calls).toHaveLength(before + 1);
  });

  it("reads a thread of another provider again when bb says it went idle", async () => {
    const s = setup({ [id(1)]: { host: A, provider: "codex" } });
    s.rows.push(requestEvent(id(1), "go", "gpt-5.5"), usageEvent(id(1), CODEX_1));
    expect(await s.cost(id(1))).toEqual([expect.closeTo(0.053, 9)]);
    s.rows.push(usageEvent(id(1), CODEX_1_2, CODEX_2));
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: id(1), providerId: "codex", status: "idle" }),
      lastAssistantText: null,
    });
    expect(s.changed).toEqual([[id(1)]]);
    expect(await s.cost(id(1))).toEqual([expect.closeTo(0.141, 9)]);
  });

  it("says a thread is running while bb says it is active, following thread events", async () => {
    const threads: Record<string, Thread> = { [id(1)]: { host: A, status: "active" }, [id(2)]: { host: A } };
    const s = setup(threads);
    // The status comes from the details a read gathers, and from thread events; `running` reads it, never a lookup of its own.
    await s.source.reportsOf([id(1), id(2)]);
    expect(await s.source.running(id(1))).toBe(true);
    expect(await s.source.running(id(2))).toBe(false);
    threads[id(2)] = { host: A, status: "active" };
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: id(2), providerId: "pi", status: "active" }) });
    expect(await s.source.running(id(2))).toBe(true);
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: id(2), providerId: "pi", status: "idle" }),
      lastAssistantText: null,
    });
    expect(await s.source.running(id(2))).toBe(false);
    await s.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: id(1), providerId: "pi", status: "error" }),
      error: "boom",
    });
    expect(await s.source.running(id(1))).toBe(false);
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: id(3), providerId: "codex", status: "active" }) });
    expect(s.changed).toEqual([[id(2)], [id(2)], [id(1)], [id(3)]]);
  });

  it("keeps the status a thread event set while a lookup of that thread was under way", async () => {
    const s = setup({ [id(1)]: { host: A, status: "active" } });
    const release = s.holdLookups();
    const asking = s.source.reportsOf([id(1)]);
    await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1));
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: id(1), providerId: "pi", status: "idle" }),
      lastAssistantText: null,
    });
    release();
    await asking;
    expect(await s.source.running(id(1))).toBe(false);
  });

  it("keeps the status a thread event set over a thread listing taken before it", async () => {
    const threads: Record<string, Thread> = { [id(1)]: { host: A }, [id(2)]: { host: A, status: "active" }, [id(3)]: { host: A } };
    const s = setup(threads, { directory: true });
    await s.source.reportsOf([id(1), id(2)]);
    // Another read lists every thread again just before id(1) starts, and id(1)'s own report has expired.
    s.tick(61_000);
    await s.source.reportsOf([id(3)]);
    threads[id(1)] = { host: A, status: "active" };
    s.tick(1000);
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: id(1), providerId: "pi", status: "active" }) });
    await s.source.reportsOf([id(1)]);
    expect(await s.source.running(id(1))).toBe(true);

    // Another read lists every thread again while id(2) still works; its own details expire just after it stops.
    s.tick(4.5 * 60_000);
    await s.source.reportsOf([id(3)]);
    threads[id(2)] = { host: A, status: "idle" };
    s.tick(10_000);
    await s.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: id(2), providerId: "pi", status: "idle" }),
      lastAssistantText: null,
    });
    s.tick(30_000);
    await s.source.reportsOf([id(2)]);
    expect(await s.source.running(id(2))).toBe(false);
  });

  it("takes a thread's status from a listing taken after the last thread event", async () => {
    const threads: Record<string, Thread> = { [id(1)]: { host: A } };
    const s = setup(threads, { directory: true });
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: id(1), providerId: "pi", status: "active" }) });
    s.tick(10 * 60_000);
    await s.source.reportsOf([id(1)]);
    expect(await s.source.running(id(1))).toBe(false);
  });

  it("names the threads whose details arrived after the deadline, so the page can fill them in", async () => {
    const s = setup({ [id(1)]: { host: A }, [id(2)]: { host: A } });
    const release = s.holdLookups();
    const got = await s.source.reportsOf([id(1), id(2)], { deadlineMs: 20 });
    expect(got.size).toBe(0);
    release();
    await vi.waitFor(() => expect(s.changed).toEqual([[id(1), id(2)]]));
  });

  it("looks a thread up again after it becomes active, and after it is forgotten", async () => {
    const threads: Record<string, Thread> = { [id(1)]: { host: A, sessions: [] } };
    const s = setup(threads);
    await s.source.reportsOf([id(1)]);
    threads[id(1)] = { host: A, sessions: ["pi_started"] };
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: id(1), providerId: "pi", status: "active" }) });
    s.tick(60_000);
    await s.source.reportsOf([id(1)]);
    const sent = s.calls.map((c) => (c.input as { threads: { sessionIds: string[] }[] }).threads[0]?.sessionIds);
    expect(sent).toEqual([[id(1)], ["pi_started", id(1)]]);
    await s.source.forget(id(1));
    await s.source.reportsOf([id(1)]);
    expect(s.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(3);
  });

  it("reads every page of a thread's session identities, so a thread resumed many times still finds its newest session", async () => {
    const t = id(1);
    const s = setup({ [t]: { host: A, sessions: [...Array(110).fill("pi_old"), ...Array(10).fill("pi_new")] } });
    s.costs[t] = 1;
    await s.source.reportsOf([t]);
    expect((s.calls[0]?.input as { threads: { sessionIds: string[] }[] }).threads[0]?.sessionIds).toEqual(["pi_old", "pi_new", t]);
    expect(s.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(2);
  });

  it("reads a thread again as soon as it starts, instead of serving the report it held from before", async () => {
    const t = id(1);
    const s = setup({ [t]: { host: A } });
    s.costs[t] = 1;
    expect(await s.cost(t)).toEqual([1]);
    s.costs[t] = 2;
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: t, providerId: "pi", status: "active" }) });
    expect(await s.cost(t)).toEqual([2]);
  });

  it("still matches a thread's log changes after it starts, before it is looked up again", async () => {
    const t = id(1);
    const s = setup({ [t]: { host: A } });
    s.costs[t] = 1;
    await s.source.reportsOf([t]);
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: t, providerId: "pi", status: "active" }) });
    expect(s.changed).toEqual([[t]]);
    await s.harness.behavior.experimental_emitHostSignal(A, "changed", { sessionIds: [`pi_${t}`], all: false });
    expect(s.changed).toEqual([[t], [t]]);
  });

  it("looks again when a thread starts while its lookup is under way, so the new session is not missed", async () => {
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: A, sessions: ["pi_one"] } };
    const s = setup(threads);
    s.costs[t] = 1;
    const release = s.holdIdentities();
    const asking = s.source.reportsOf([t]);
    await vi.waitFor(() => expect(s.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(1));
    threads[t] = { host: A, sessions: ["pi_one", "pi_two"] };
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: t, providerId: "pi", status: "active" }) });
    release();
    await asking;
    const sent = s.calls.map((c) => (c.input as { threads: { sessionIds: string[] }[] }).threads[0]?.sessionIds);
    expect(sent).toEqual([["pi_one", "pi_two", t]]);
    await s.harness.behavior.experimental_emitHostSignal(A, "changed", { sessionIds: ["pi_two"], all: false });
    expect(s.changed.at(-1)).toEqual([t]);
  });

  it("looks a thread up again on its next read when it started again during every try of a lookup", async () => {
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: A, sessions: ["pi_0"] } };
    const s = setup(threads);
    s.costs[t] = 1;
    let started = 0;
    // Each time bb answers, the thread starts again with a session that answer did not have.
    s.onIdentities(async () => {
      if (started >= 3) return;
      started++;
      threads[t] = { host: A, sessions: [...threads[t]!.sessions!, `pi_${started}`] };
      await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: t, providerId: "pi", status: "active" }) });
    });
    await s.source.reportsOf([t]);
    expect(s.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(3);
    s.tick(60_000);
    await s.source.reportsOf([t]);
    const sent = s.calls.map((c) => (c.input as { threads: { sessionIds: string[] }[] }).threads[0]?.sessionIds);
    expect(sent.at(-1)).toEqual(["pi_0", "pi_1", "pi_2", "pi_3", t]);
  });

  it("still matches a working thread's log changes once its provisional lookup is due again", async () => {
    const t = id(1);
    const s = setup({ [t]: { host: A, status: "active", sessions: [] } }, { retryMs: 10 });
    s.costs[t] = 1;
    await s.source.reportsOf([t]);
    await vi.waitFor(() => expect(s.changed.flat()).toContain(t));
    const before = s.changed.length;
    await s.harness.behavior.experimental_emitHostSignal(A, "changed", { sessionIds: [t], all: false });
    expect(s.changed).toHaveLength(before + 1);
    expect(s.changed.at(-1)).toEqual([t]);
  });

  it("finds the machine of a thread that starts once bb attaches its new environment, though the shared listing is from before", async () => {
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: null, status: "starting" } };
    const s = setup(threads, { directory: true });
    s.costs[t] = 1;
    const lookups = () => s.harness.inspection.sdk.callsTo("threads.get").length + s.harness.inspection.sdk.callsTo("environments.get").length;
    // While bb is still creating the machine there is nothing to ask, and Burn makes no call of its own to find it.
    expect(await s.cost(t)).toEqual([null]);
    expect(lookups()).toBe(0);
    threads[t] = { host: A, status: "active" };
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: t, providerId: "pi", status: "active" }) });
    expect(await s.cost(t)).toEqual([1]);
    expect(s.asked(A)).toEqual([[t]]);
    // One read of this thread and its environment, not a new listing of every thread.
    expect(s.harness.inspection.sdk.callsTo("threads.list")).toHaveLength(1);
    expect(lookups()).toBe(2);
  });

  it("looks again for a working thread's machine on a growing schedule, and tells the UI only once it appears", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: null, status: "active" } };
    const s = setup(threads, { directory: true, hostWaitStepsMs: [5, 10, 20] });
    s.costs[t] = 1;
    const reads = () => s.harness.inspection.sdk.callsTo("threads.get").length;
    expect(await s.cost(t)).toEqual([null]);
    expect(reads()).toBe(1);
    // The shared listing has expired; a timed look reads only this thread, never every thread again.
    s.tick(61_000);
    await vi.advanceTimersByTimeAsync(4);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(9);
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(3);
    // A look that finds no machine is one read of the thread: nothing signalled, no host asked, no new listing.
    expect(s.changed).toEqual([]);
    expect(s.calls).toHaveLength(0);
    expect(s.harness.inspection.sdk.callsTo("threads.list")).toHaveLength(1);
    threads[t] = { host: A, status: "active" };
    await vi.advanceTimersByTimeAsync(20);
    expect(reads()).toBe(4);
    expect(s.changed).toEqual([[t]]);
    expect(await s.cost(t)).toEqual([1]);
    expect(s.asked(A)).toEqual([[t]]);
  });

  it("stops looking for a machine at the end of its schedule, and never looks for an idle thread's", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const working = id(1);
    const idle = id(2);
    const s = setup({ [working]: { host: null, status: "active" }, [idle]: { host: null, status: "idle" } }, { directory: true, hostWaitStepsMs: [5, 10] });
    await s.source.reportsOf([working, idle]);
    await vi.advanceTimersByTimeAsync(60_000);
    const looked = s.harness.inspection.sdk.callsTo("threads.get").map(([args]) => (args as { threadId: string }).threadId);
    expect(looked).toEqual([working, working, working]);
    expect(s.changed).toEqual([]);
  });

  it("stops looking for a machine once the thread stops working", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = id(1);
    const s = setup({ [t]: { host: null, status: "active" } }, { directory: true, hostWaitStepsMs: [5, 10, 20] });
    await s.source.reportsOf([t]);
    await vi.advanceTimersByTimeAsync(5);
    expect(s.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
    await s.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: t, providerId: "pi", status: "idle" }), lastAssistantText: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
  });

  it("counts a failed first read of a working thread's own row as no machine yet, so the wait stays quiet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = id(1);
    const s = setup({ [t]: { host: null, status: "active" } }, { directory: true, hostWaitStepsMs: [5, 10, 20] });
    s.failLookups(true);
    await s.source.reportsOf([t]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(4);
    expect(s.changed).toEqual([]);
  });

  it("keeps the schedule's budget when looks for a machine fail, rather than starting it again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = id(1);
    const s = setup({ [t]: { host: null, status: "active" } }, { directory: true, hostWaitStepsMs: [5, 10, 20] });
    await s.source.reportsOf([t]);
    s.failLookups(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(4);
    expect(s.changed).toEqual([]);
  });

  it("stops signalling a working thread whose lookups keep failing after the retry limit", async () => {
    const t = id(1);
    const s = setup({ [t]: { host: A, status: "active" } }, { retryMs: 5, retryMax: 2 });
    s.failLookups(true);
    await s.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: t, providerId: "pi", status: "active" }) });
    for (let i = 0; i < 5; i++) {
      await s.source.reportsOf([t]);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    // One signal for the start, then one per retry up to the limit.
    expect(s.changed.flat().filter((changed) => changed === t)).toHaveLength(3);
  });

  it("looks for at most four threads' machines at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const threads: Record<string, Thread> = {};
    for (let n = 0; n < 10; n++) threads[id(n)] = { host: null, status: "active" };
    const s = setup(threads, { directory: true, hostWaitStepsMs: [5] });
    const reads = () => s.harness.inspection.sdk.callsTo("threads.get").length;
    await s.source.reportsOf(Object.keys(threads));
    expect(reads()).toBe(10);
    const release = s.holdLookups();
    await vi.advanceTimersByTimeAsync(5);
    expect(reads()).toBe(14);
    release();
    await vi.waitFor(() => expect(reads()).toBe(20));
  });

  it("keeps nothing from a look that finishes after its thread is forgotten", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gone = id(1);
    const kept = id(2);
    const threads: Record<string, Thread> = { [gone]: { host: null, status: "active" }, [kept]: { host: null, status: "active" } };
    const s = setup(threads, { directory: true, hostWaitStepsMs: [5, 10, 20] });
    const readsOf = (threadId: string) =>
      s.harness.inspection.sdk.callsTo("threads.get").filter(([args]) => (args as { threadId: string }).threadId === threadId).length;
    await s.source.reportsOf([gone, kept]);
    const release = s.holdLookups();
    await vi.advanceTimersByTimeAsync(5);
    await s.source.forget(gone);
    // bb still answers "active", and with a machine: the forgotten thread's late answer is dropped all the same.
    threads[gone] = { host: A, status: "active" };
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readsOf(gone)).toBe(2);
    expect(readsOf(kept)).toBe(4);
    expect(s.changed).toEqual([]);
    expect(s.calls).toHaveLength(0);
    expect(await s.source.running(gone)).toBe(false);
  });

  it("neither asks a host nor signals for a reader that joined a look whose thread was then forgotten", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: null, status: "active" } };
    const s = setup(threads, { directory: true, hostWaitStepsMs: [5, 10, 20] });
    s.costs[t] = 1;
    await s.source.reportsOf([t]);
    const release = s.holdLookups();
    await vi.advanceTimersByTimeAsync(5);
    const waiting = s.source.reportsOf([t]);
    const hurried = s.source.reportsOf([t], { deadlineMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await hurried;
    await s.source.forget(t);
    threads[t] = { host: A, status: "active" };
    release();
    expect((await waiting).size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls).toHaveLength(0);
    expect(s.changed).toEqual([]);
  });

  it("frees a timed look's slot when bb does not answer, but never has more than eight reads waiting on bb", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const threads: Record<string, Thread> = {};
    for (let n = 0; n < 20; n++) threads[id(n)] = { host: null, status: "active" };
    const s = setup(threads, { directory: true, hostWaitStepsMs: [5] });
    const reads = () => s.harness.inspection.sdk.callsTo("threads.get").length;
    await s.source.reportsOf(Object.keys(threads));
    expect(reads()).toBe(20);
    const release = s.holdLookups();
    await vi.advanceTimersByTimeAsync(5);
    expect(reads()).toBe(24);
    // Four reads bb has not answered give up their slots, so four other threads' looks still run.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(reads()).toBe(28);
    // With eight unanswered, nothing more starts however long bb takes.
    await vi.advanceTimersByTimeAsync(10 * 25_000);
    expect(reads()).toBe(28);
    release();
    await vi.waitFor(() => expect(reads()).toBe(40));
  });

  it("shows a thread's cost again soon when reading its sessions fails once after its machine is found", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: null, status: "active" } };
    const s = setup(threads, { directory: true, hostWaitStepsMs: [5] });
    s.costs[t] = 1;
    await s.source.reportsOf([t]);
    await vi.advanceTimersByTimeAsync(5);
    // The wait has used its one look; the machine arrives later and the details expire.
    threads[t] = { host: A, status: "active" };
    s.tick(5 * 60_000);
    let failOnce = true;
    s.onIdentities(async () => {
      if (!failOnce) return;
      failOnce = false;
      throw new Error("bb is unreachable");
    });
    expect(await s.cost(t)).toEqual([null]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.changed).toEqual([[t]]);
    expect(await s.cost(t)).toEqual([1]);
  });

  it("schedules and signals nothing after it is disposed, though a look was under way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: null, status: "active" } };
    const s = setup(threads, { directory: true, hostWaitStepsMs: [5, 10, 20] });
    await s.source.reportsOf([t]);
    const release = s.holdLookups();
    await vi.advanceTimersByTimeAsync(5);
    s.source.dispose();
    threads[t] = { host: A, status: "active" };
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
    expect(s.changed).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });

  it("stops looking for the machine of a thread bb has deleted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = id(1);
    const threads: Record<string, Thread> = { [t]: { host: null, status: "active" } };
    const s = setup(threads, { directory: true, hostWaitStepsMs: [5, 10, 20] });
    await s.source.reportsOf([t]);
    threads[t] = { host: null, status: "active", deleted: true };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
    expect(await s.source.running(t)).toBe(false);
  });

  it("reads every page of a Claude Code fork's parent sessions", async () => {
    const fork = id(1);
    const parent = id(2);
    const s = setup({
      [fork]: { host: A, provider: "claude-code", sessions: ["c_fork"], source: parent },
      [parent]: { host: A, provider: "claude-code", sessions: [...Array(110).fill("c_old"), "c_new"] },
    });
    s.costs[fork] = 1;
    await s.source.reportsOf([fork]);
    expect(s.calls[0]?.input).toMatchObject({ harness: "claude", threads: [{ threadId: fork, parentSessionIds: ["c_old", "c_new"] }] });
    await s.harness.lifecycle.dispose();
  });
});

describe("createReportSource and hosts that are not connected", () => {
  it("asks no host that bb lists as not connected, and shows the last figures it kept", async () => {
    const s = setup({ [id(1)]: { host: A }, [id(2)]: { host: B } }, { disconnected: [A] });
    s.costs[id(1)] = 4;
    s.costs[id(2)] = 5;
    await s.bb.storage.kv.set(`log:${id(1)}`, { report: costOf(3), at: 3000 });
    await s.hostsKnown();
    expect(await s.cost(id(1), id(2))).toEqual([3, 5]);
    expect(s.asked(A)).toEqual([]);
    expect(s.asked(B)).toEqual([[id(2)]]);
    expect(s.warnings()).toEqual([]);
  });

  it("stops asking a host once bb says it disconnected, though its report has expired", async () => {
    const s = setup({ [id(1)]: { host: A } });
    s.costs[id(1)] = 4;
    await s.hostsKnown();
    expect(await s.cost(id(1))).toEqual([4]);
    s.hostChanged(A, "host-disconnected");
    s.tick(60_000);
    expect(await s.cost(id(1))).toEqual([4]);
    expect(s.calls).toHaveLength(1);
    expect(s.warnings()).toEqual([]);
  });

  it("reads a host's threads again as soon as it connects, instead of serving what it held", async () => {
    const s = setup({ [id(1)]: { host: A }, [id(2)]: { host: B } });
    s.costs[id(1)] = 4;
    s.costs[id(2)] = 5;
    await s.hostsKnown();
    expect(await s.cost(id(1), id(2))).toEqual([4, 5]);
    s.hostChanged(A, "host-disconnected");
    s.costs[id(1)] = 6;
    s.costs[id(2)] = 7;
    expect(await s.cost(id(1), id(2))).toEqual([4, 5]);
    expect(s.calls).toHaveLength(2);
    s.hostChanged(A, "host-connected");
    expect(s.changed.at(-1)).toEqual([id(1)]);
    expect(await s.cost(id(1), id(2))).toEqual([6, 5]);
    expect(s.asked().at(-1)).toEqual([id(1)]);
  });

  it("reads a host again that only the host list shows as connected again, when a read finds it missing", async () => {
    const s = setup({ [id(1)]: { host: A } }, { disconnected: [A] });
    s.costs[id(1)] = 4;
    await s.hostsKnown();
    expect(await s.cost(id(1))).toEqual([null]);
    expect(s.hostLists()).toBe(1);
    s.hostListed(A, true);
    s.tick(60_000);
    expect(await s.cost(id(1))).toEqual([null]);
    await s.hostsKnown();
    expect(s.hostLists()).toBe(2);
    expect(s.changed.at(-1)).toEqual([id(1)]);
    expect(await s.cost(id(1))).toEqual([4]);
  });

  it("asks every host while bb cannot list them", async () => {
    const s = setup({ [id(1)]: { host: A } }, { listFails: true });
    s.costs[id(1)] = 4;
    await s.hostsKnown();
    expect(await s.cost(id(1))).toEqual([4]);
    expect(s.asked(A)).toEqual([[id(1)]]);
    s.tick(60_000);
    s.costs[id(1)] = 5;
    expect(await s.cost(id(1))).toEqual([5]);
    expect(s.hostLists()).toBe(2);
    expect(s.warnings()).toEqual([expect.stringContaining("listing bb's hosts failed")]);
  });

  it("stops watching hosts when it is disposed", async () => {
    const s = setup({ [id(1)]: { host: A } });
    expect(s.watchers).toHaveLength(1);
    s.source.dispose();
    expect(s.watchers).toHaveLength(0);
  });
});

describe("createReportSource and a host that fails", () => {
  it("logs the failure once, not on every attempt, and again after a read succeeds and fails later", async () => {
    const s = setup({ [id(1)]: { host: A } }, { offline: [A] });
    await s.hostsKnown();
    for (let n = 0; n < 4; n++) {
      await s.cost(id(1));
      s.tick(30 * 60_000);
    }
    expect(s.calls).toHaveLength(4);
    expect(s.warnings()).toHaveLength(1);
    expect(s.warnings()[0]).toContain(`reading pi session logs on ${A} failed`);
    s.offline.delete(A);
    s.costs[id(1)] = 2;
    expect(await s.cost(id(1))).toEqual([2]);
    s.offline.add(A);
    s.tick(60_000);
    await s.cost(id(1));
    expect(s.warnings()).toHaveLength(2);
  });

  it("waits a minute after the first failure, then twice as long each time, up to 30 minutes", async () => {
    const s = setup({ [id(1)]: { host: A } }, { offline: [A] });
    await s.hostsKnown();
    await s.cost(id(1));
    let calls = 1;
    for (const wait of [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]) {
      s.tick(wait - 1);
      await s.cost(id(1));
      expect(s.calls).toHaveLength(calls);
      s.tick(1);
      await s.cost(id(1));
      expect(s.calls).toHaveLength(++calls);
    }
  });

  it("starts again at a minute once a read succeeds", async () => {
    const s = setup({ [id(1)]: { host: A } }, { offline: [A] });
    await s.hostsKnown();
    await s.cost(id(1));
    for (const wait of [60_000, 120_000]) {
      s.tick(wait);
      await s.cost(id(1));
    }
    s.tick(240_000);
    s.offline.delete(A);
    s.costs[id(1)] = 2;
    expect(await s.cost(id(1))).toEqual([2]);
    s.tick(60_000);
    s.offline.add(A);
    await s.cost(id(1));
    expect(s.calls).toHaveLength(5);
    s.tick(59_999);
    await s.cost(id(1));
    expect(s.calls).toHaveLength(5);
    s.tick(1);
    await s.cost(id(1));
    expect(s.calls).toHaveLength(6);
  });

  it("starts again at a minute, and logs again, when the host reconnects", async () => {
    const s = setup({ [id(1)]: { host: A } }, { offline: [A] });
    await s.hostsKnown();
    await s.cost(id(1));
    s.tick(60_000);
    await s.cost(id(1));
    expect(s.calls).toHaveLength(2);
    s.hostChanged(A, "host-disconnected");
    s.hostChanged(A, "host-connected");
    await s.cost(id(1));
    expect(s.calls).toHaveLength(3);
    expect(s.warnings()).toHaveLength(2);
    s.tick(60_000);
    await s.cost(id(1));
    expect(s.calls).toHaveLength(4);
  });

  it("counts reads that failed together as one failure", async () => {
    const s = setup({ [id(1)]: { host: A }, [id(2)]: { host: A, provider: "acp-opencode" } }, { offline: [A] });
    await s.hostsKnown();
    await s.cost(id(1), id(2));
    expect(s.calls).toHaveLength(2);
    expect(s.warnings()).toHaveLength(1);
    s.tick(60_000);
    await s.cost(id(1), id(2));
    expect(s.calls).toHaveLength(4);
    s.tick(60_000);
    await s.cost(id(1), id(2));
    expect(s.calls).toHaveLength(4);
    s.tick(60_000);
    await s.cost(id(1), id(2));
    expect(s.calls).toHaveLength(6);
  });
});

describe("createReportSource with the real host entry", () => {
  it("reads a pi session log on the host and updates as soon as the host signals a change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "burn-sources-"));
    dirs.push(dir);
    const thread = id(7);
    const file = sessionFile(dir, "pi_seven");
    const header = { type: "session", version: 3, id: "s", timestamp: "2026-10-18T12:00:00.000Z", cwd: "/tmp" };
    writeFileSync(file, [header, user(), assistant(1.5)].map((e) => `${JSON.stringify(e)}\n`).join(""));
    let listener: ExperimentalHostWatchListener | null = null;
    const host = experimental_createHostEntryHarness(createHostEntry({ dir }), {
      experimental_watch: (_options, l) => {
        listener = l;
        return { dispose: async () => undefined };
      },
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "burn",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId, providerId: "pi", environmentId: "env_1", status: "active" }),
          events: {
            list: async ({ threadId }: { threadId: string }) => [
              { type: "thread/identity", threadId, seq: 1, data: { providerThreadId: "pi_seven" } },
            ],
          },
        },
        environments: { get: async () => ({ id: "env_1", hostId: "host_1" }) },
      },
      experimental_callHostRpc: ({ method, input }) => host.experimental_call(method as "reports", input as never),
    });
    const changed: string[][] = [];
    const source = createReportSource(bb, { onChange: (ids) => void changed.push(ids) });
    expect((await source.reportsOf([thread])).get(thread)?.report.cost.total).toBeCloseTo(1.5);

    appendFileSync(file, `${JSON.stringify(assistant(2))}\n`);
    await listener!({ kind: "changed", changes: [{ path: file, type: "update" }] });
    for (const { signal, payload } of host.experimental_getSignals()) await harness.behavior.experimental_emitHostSignal("host_1", signal, payload);
    expect(changed).toEqual([[thread]]);
    expect((await source.reportsOf([thread])).get(thread)?.report.cost.total).toBeCloseTo(3.5);
    await host.experimental_dispose();
    await harness.lifecycle.dispose();
  });
});

describe("Claude transcript source selection", () => {
  it("uses transcripts instead of adding their tokens to BB events", async () => {
    const s = setup({ [id(1)]: { host: A, provider: "claude-code", sessions: ["session-a"] } });
    s.costs[id(1)] = 7;
    s.rows.push(requestEvent(id(1), "go", "claude-opus-5-5"), usageEvent(id(1), CODEX_1));
    const got = (await s.source.reportsOf([id(1)])).get(id(1));
    expect(got?.source).toBe("log");
    expect(got?.report.cost.total).toBe(7);
    expect(s.calls[0]?.input).toMatchObject({ harness: "claude", threads: [{ sessionIds: ["session-a", id(1)] }] });
    await s.harness.lifecycle.dispose();
  });
  it("falls back to limited BB events when logs or host are unavailable", async () => {
    const s = setup({ [id(1)]: { host: A, provider: "claude-code" } }, { offline: [A] });
    s.rows.push(requestEvent(id(1), "go", "claude-opus-5-5"), usageEvent(id(1), CODEX_1));
    const got = (await s.source.reportsOf([id(1)])).get(id(1));
    expect(got?.source).toBe("events");
    expect(got?.report.coverageNote).toContain("Limited coverage");
    expect(got?.report.calls).toBe(1);
    await s.harness.lifecycle.dispose();
  });
});

it("preserves a saved Claude report when a later read has missing session identities", async () => {
  const opts: { coverageNote?: string } = {};
  const s = setup({ [id(1)]: { host: A, provider: "claude-code" } }, opts);
  s.costs[id(1)] = 4;
  expect(await s.cost(id(1))).toEqual([4]);
  opts.coverageNote = "Partial Claude transcript history: missing session";
  s.costs[id(1)] = 2;
  s.tick(60_000);
  const got = (await s.source.reportsOf([id(1)])).get(id(1));
  expect(got?.report.cost.total).toBe(4);
  expect(got?.report.coverageNote).toContain("last saved");
  await s.harness.lifecycle.dispose();
});
