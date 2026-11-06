import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PriceOverrides } from "../../src/prices.js";
import type { UsageReport } from "../../src/report.js";
import type { ThreadDirectory } from "./directory.js";
import { createEventReader } from "./events.js";
import { type Harness, harnessOf } from "./harnesses.js";
import { HOST_BATCH, hostContract, hostSignals } from "./host/contract.js";
import { createHostWatch } from "./hosts.js";
import { sessionStem } from "./host/pi-sessions.js";
import { logKey } from "./keys.js";
import { usageReportSchema } from "./schema.js";

const FACTS_TTL_MS = 5 * 60_000;
/** A thread whose pi session id bb has not named yet is looked up again this soon, not after the full facts TTL. */
const FACTS_RETRY_MS = 5_000;
/** Consecutive retries before a thread with no session identity settles on the normal facts TTL. */
const FACTS_RETRY_MAX = 12;
/**
 * When a working thread that bb has not given a machine yet is looked up again, about three minutes in all.
 * Each look reads that thread, and its environment once it has one; only a look that finds the machine tells the UI.
 */
const HOST_WAIT_STEPS_MS = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000];
/** How many of those looks run at once, so many threads waiting together do not crowd bb. */
const HOST_WAIT_CONCURRENCY = 4;
/** How many may wait on bb at once, counting looks that gave up their slot to a bb that does not answer. */
const HOST_WAIT_PENDING_MAX = 2 * HOST_WAIT_CONCURRENCY;
const REPORT_TTL_MS = 60_000;
/** How many threads are looked up at once: enough to use a fast bb, few enough not to swamp it. */
const FACTS_CONCURRENCY = 32;
/** How long an unreachable host is left alone after its first failure; each failure in a row doubles it, up to HOST_RETRY_MAX_MS. */
const HOST_RETRY_MS = 60_000;
const HOST_RETRY_MAX_MS = 30 * 60_000;
const HOST_TIMEOUT_MS = 25_000;
const SESSIONS_MAX = 32;
/** bb's most thread events in one `threads.events.list` page, and its default. */
const EVENTS_PAGE = 100;
/** Lookups of one thread in a row before Burn keeps what it found, though the thread started again meanwhile. */
const LOOKUP_TRIES = 3;
// Room for every thread a month of use touches: a scan over more threads than a cache holds evicts each entry just before it is read again.
const CACHE_MAX = 5000;
/** A held report takes about 10 KB, so fewer are kept than the small per-thread facts. */
const REPORTS_MAX = 2000;

/**
 * A report Burn read itself: "log" from a pi thread's session logs, "events"
 * from the usage bb records for other harnesses. `at` is when it last changed.
 */
export interface LogReport {
  report: UsageReport;
  at: number;
  source: "log" | "events";
}

export interface ReportSource {
  /**
   * The latest report of each thread that has one: from its host or bb's events, else the last one kept.
   * With `deadlineMs` it answers by then with what it has; reads still under way finish later, and
   * `onChange` names the threads whose figures they changed.
   */
  reportsOf(threadIds: readonly string[], opts?: { deadlineMs?: number }): Promise<Map<string, LogReport>>;
  /** Whether bb says the thread is working right now. */
  running(threadId: string): Promise<boolean>;
  /** How many of these threads' figures are still being read right now, for a progress line. */
  reading(threadIds: readonly string[]): number;
  /** Reads these threads' details in the background, so a page over them does not start cold. */
  warm(threadIds: readonly string[]): Promise<void>;
  /** How Burn reads the thread, or null when bb could not say. */
  harnessOf(threadId: string): Promise<Harness | null>;
  /** Drop held reports after a price change, so the next read prices them again. */
  reprice(): void;
  forget(threadId: string): Promise<void>;
  /** Stop the retry timers when the plugin unloads. */
  dispose(): void;
}

/** What bb says about a thread: its provider, the machine that keeps its pi logs (null for none, or not pi) and its pi sessions. */
interface Facts {
  since?: number;
  parentSessionIds?: string[];
  at: number;
  hostId: string | null;
  /** null when the lookup failed. */
  providerId: string | null;
  sessionIds: string[];
  /** The file names the host reports changes by. */
  stems: Set<string>;
  /** The lookup found no session id of its own, only the thread-id fallback, so it is worth repeating soon. */
  retry?: boolean;
  /** bb says the thread is working, but has not given it a machine yet. */
  awaitingHost?: boolean;
  /** A thread event made these out of date: they still match log changes, but the next read looks the thread up again. */
  outdated?: boolean;
}

const logSchema = z.object({ report: usageReportSchema, at: z.number() });

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function remember<V>(map: Map<string, V>, key: string, value: V, max = CACHE_MAX): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Whether `work` settles by `until`, a Date.now() time; at Infinity it waits as long as `work` takes. */
function settlesBy(work: Promise<unknown>, until: number): Promise<boolean> {
  if (until === Number.POSITIVE_INFINITY) return work.then(() => true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, until - Date.now()));
  });
  return Promise.race([work.then(() => true), late]).finally(() => clearTimeout(timer));
}

/** Runs `fn` over `items`, `limit` at a time, so a page over a thousand threads does not fire them all at once. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Every thread's report. A pi thread's is read by the Burn host entry from its
 * session logs on the machine that runs it, and kept until the host signals
 * that one of the thread's logs changed, or a minute passes. Any other thread's
 * comes from the usage bb records (events.ts). `onChange` names the threads to
 * look at again.
 */
export function createReportSource(
  bb: BbPluginApi,
  opts: {
    onChange(threadIds: string[]): void;
    now?: () => number;
    threads?: ThreadDirectory;
    overrides?: () => PriceOverrides;
    retryMs?: number;
    retryMax?: number;
    hostWaitStepsMs?: readonly number[];
  },
): ReportSource {
  const now = opts.now ?? Date.now;
  const retryMs = opts.retryMs ?? FACTS_RETRY_MS;
  const retryMax = opts.retryMax ?? FACTS_RETRY_MAX;
  const hostWaitSteps = opts.hostWaitStepsMs ?? HOST_WAIT_STEPS_MS;
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const events = createEventReader(bb, { onChange: opts.onChange, now, overrides: opts.overrides });
  const facts = new Map<string, Facts>();
  const statuses = new Map<string, string>();
  // When a thread event last set each thread's status, so a lookup answered from before it does not undo it.
  const heardAt = new Map<string, number>();
  const reports = new Map<string, { got: LogReport | null; checkedAt: number }>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<string, number>();
  const hostTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const hostSteps = new Map<string, number>();
  // Looks for a machine that are due, run HOST_WAIT_CONCURRENCY at a time.
  const hostQueue = new Set<string>();
  let hostLooks = 0;
  let hostPending = 0;
  // The lookup each thread's details may come from. forget drops it, so a lookup under way then keeps nothing.
  const owners = new Map<string, object>();
  let disposed = false;
  // Bumped by every change, so a read that raced the change is not kept as current.
  const versions = new Map<string, number>();
  const saved = new Map<string, number>();
  // Bumped by reprice, so a host read that started before a price change does not persist or cache old-price figures.
  let priceGeneration = 0;
  // A host that failed, when it last did and how long it is left alone. Present from its first failure until
  // a read succeeds or bb says it connected, which is also how a failure is logged once, not on every attempt.
  const failures = new Map<string, { at: number; delay: number }>();
  // The host read under way per thread, which a second caller joins instead of asking the host again, and
  // when the caller that started it stopped waiting: a joiner waits no longer, since that caller's late read signals.
  const reading = new Map<string, { run: Promise<void>; until: number }>();

  /** What the thread row says, however Burn got it: one shared listing, or a call of its own. */
  interface Looked {
    since?: number;
    sourceThreadId?: string | null;
    status: string;
    providerId: string;
    environmentId: string | null;
    hostId: string | null;
    /** Whether `hostId` is already known, so the fallback path does not ask again. */
    hostKnown: boolean;
    /** When bb was asked: a shared listing can be up to a minute older than the lookup. */
    listedAt: number;
  }

  async function lookup(threadId: string): Promise<Looked | null> {
    if (opts.threads) {
      const row = await opts.threads.one(threadId);
      return row === null
        ? null
        : {
            status: row.status,
            providerId: row.providerId,
            environmentId: row.environmentId,
            hostId: row.hostId,
            hostKnown: true,
            listedAt: row.listedAt,
            sourceThreadId: row.sourceThreadId,
            since: row.sourceThreadId ? row.createdAt : undefined,
          };
    }
    return fetched(threadId);
  }

  /** The thread row from bb itself, never from the shared listing; null for a deleted thread. */
  async function fetched(threadId: string): Promise<Looked | null> {
    const listedAt = now();
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.deletedAt !== null) return null;
    return {
      listedAt,
      status: thread.status,
      providerId: thread.providerId,
      environmentId: thread.environmentId,
      hostId: null,
      hostKnown: false,
      sourceThreadId: thread.sourceThreadId,
      since: thread.sourceThreadId ? thread.createdAt : undefined,
    };
  }

  /**
   * `direct` reads the thread from bb rather than the shared listing, as a timed look for its machine does.
   * `live` says whether the lookup still counts; forget and dispose end it.
   */
  async function lookUp(threadId: string, direct: boolean, live: () => boolean): Promise<Facts> {
    const asked = now();
    const newer = (listedAt: number) => listedAt > (heardAt.get(threadId) ?? Number.NEGATIVE_INFINITY);
    // A forgotten thread's late answer must not bring its status back.
    const note = (listedAt: number, status: string): void => {
      if (live() && newer(listedAt)) remember(statuses, threadId, status);
    };
    // While looking for a working thread's machine, a failed read counts as no machine yet, so the wait keeps to its
    // schedule. Only these reads: a failure once the machine is known takes the session retry, which signals.
    const stillWaiting = (providerId: string | null, err: unknown): Facts => {
      bb.log.warn(`reading thread ${threadId} for its machine failed: ${message(err)}`);
      return { at: now(), hostId: null, providerId, sessionIds: [], stems: new Set(), awaitingHost: statuses.get(threadId) === "active" };
    };
    let row: Looked | null;
    try {
      row = direct ? await fetched(threadId) : await lookup(threadId);
    } catch (err) {
      if (!direct) throw err;
      return stillWaiting(facts.get(threadId)?.providerId ?? null, err);
    }
    if (row === null) {
      note(asked, "deleted");
      return { at: now(), hostId: null, providerId: null, sessionIds: [], stems: new Set() };
    }
    note(row.listedAt, row.status);
    const reader = harnessOf(row.providerId).reader;
    if (reader !== "pi-log" && reader !== "opencode-db" && reader !== "claude-log") {
      return { at: now(), hostId: null, providerId: row.providerId, sessionIds: [], stems: new Set() };
    }
    const providerId = row.providerId;
    // bb attaches an environment it creates for the thread only once it is ready, and the shared listing can be a
    // minute older than that. A working thread has its machine by now, so read its own row instead.
    const stale = row.hostKnown && (row.environmentId === null || row.hostId === null) && statuses.get(threadId) === "active";
    let hostId: string | null;
    try {
      if (stale) {
        const ownAsked = now();
        const own = await fetched(threadId);
        if (own === null) {
          note(ownAsked, "deleted");
          return { at: now(), hostId: null, providerId: null, sessionIds: [], stems: new Set() };
        }
        row = own;
        note(row.listedAt, row.status);
      }
      hostId = row.environmentId === null ? null : row.hostKnown ? row.hostId : (await bb.sdk.environments.get({ environmentId: row.environmentId })).hostId;
    } catch (err) {
      if (!direct && !stale) throw err;
      return stillWaiting(providerId, err);
    }
    if (hostId === null) {
      return { at: now(), hostId: null, providerId: row.providerId, sessionIds: [], stems: new Set(), awaitingHost: statuses.get(threadId) === "active" };
    }
    // The thread id too, for a session named after the thread rather than an identity.
    const sessionIds = [...new Set([...(await identitiesOf(threadId)), threadId])].slice(-SESSIONS_MAX);
    // Only pi's bridge names its session files after these ids.
    const stems = reader === "pi-log" ? new Set(sessionIds.map(sessionStem)) : new Set<string>();
    let parentSessionIds: string[] | undefined;
    if (reader === "claude-log" && row.sourceThreadId) {
      parentSessionIds = [...new Set(await identitiesOf(row.sourceThreadId))].slice(-SESSIONS_MAX);
    }
    return { at: now(), hostId, providerId: row.providerId, sessionIds, stems, since: row.since, parentSessionIds };
  }

  /**
   * Every session id bb recorded for the thread, oldest first. bb answers a page of 100 events from
   * the oldest, and a thread that has been resumed many times has more, its newest sessions last.
   */
  async function identitiesOf(threadId: string): Promise<string[]> {
    const ids: string[] = [];
    let after: number | null = null;
    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/identity"],
        order: "asc",
        limit: String(EVENTS_PAGE),
        ...(after !== null ? { afterSeq: String(after) } : {}),
      });
      for (const row of page) {
        const id = (row.data as { providerThreadId?: unknown } | null)?.providerThreadId;
        if (typeof id === "string" && id !== "") ids.push(id);
      }
      const last = page.at(-1);
      // A page that does not move forward would repeat forever.
      if (page.length < EVENTS_PAGE || last === undefined || (after !== null && last.seq <= after)) return ids;
      after = last.seq;
    }
  }

  /** The lookup under way per thread, so a caller joins it instead of asking bb again. */
  const looking = new Map<string, Promise<Facts>>();
  // Bumped each time a thread starts, so a lookup that began before then looks again for a session it may have missed.
  const starts = new Map<string, number>();

  /** Keeps the thread's details, so a change to a log it already has still matches, but makes the next read look it up again. */
  function outdate(threadId: string): void {
    const held = facts.get(threadId);
    if (held) remember(facts, threadId, { ...held, outdated: true });
  }

  /**
   * A new thread's pi session file is named after a session id bb may not have recorded yet.
   * Until it has, the host watch cannot match the file to the thread, so look again soon and tell the UI to reread.
   */
  function scheduleRetry(threadId: string): void {
    if (retryTimers.has(threadId)) return;
    // A thread whose session is legitimately named by its thread id never stops looking provisional;
    // a dozen signals is enough to let it settle until the thread next starts or the full TTL passes.
    const attempts = retryAttempts.get(threadId) ?? 0;
    if (attempts >= retryMax) return;
    retryAttempts.set(threadId, attempts + 1);
    const timer = setTimeout(() => {
      retryTimers.delete(threadId);
      // An idle thread will look up again when it next starts; only a working one needs the signal now.
      if (!facts.get(threadId)?.retry || statuses.get(threadId) !== "active") return;
      outdate(threadId);
      invalidate(threadId);
      opts.onChange([threadId]);
    }, retryMs);
    timer.unref?.();
    retryTimers.set(threadId, timer);
  }

  /**
   * A working thread with no machine yet is looked up again on HOST_WAIT_STEPS_MS. Unlike the session retry,
   * a look that still finds no machine tells no one, so the wait costs no reread of the thread.
   */
  function awaitHost(threadId: string): void {
    if (disposed || hostTimers.has(threadId) || hostQueue.has(threadId)) return;
    const step = hostSteps.get(threadId) ?? 0;
    const delay = hostWaitSteps[step];
    if (delay === undefined) return;
    hostSteps.set(threadId, step + 1);
    const timer = setTimeout(() => {
      hostTimers.delete(threadId);
      hostQueue.add(threadId);
      lookForHosts();
    }, delay);
    timer.unref?.();
    hostTimers.set(threadId, timer);
  }

  function lookForHosts(): void {
    while (!disposed && hostLooks < HOST_WAIT_CONCURRENCY && hostPending < HOST_WAIT_PENDING_MAX) {
      const threadId = hostQueue.values().next().value;
      if (threadId === undefined) return;
      hostQueue.delete(threadId);
      // Checked when the look starts rather than when it fell due, since it may have waited in the queue.
      if (!facts.get(threadId)?.awaitingHost || statuses.get(threadId) !== "active") continue;
      hostLooks++;
      hostPending++;
      outdate(threadId);
      // A look bb does not answer gives up its slot after HOST_TIMEOUT_MS and finishes in the background,
      // still counted in hostPending, since bb cannot cancel the read.
      let freed = false;
      const timer = setTimeout(() => free(), HOST_TIMEOUT_MS);
      timer.unref?.();
      const free = (): void => {
        if (freed) return;
        freed = true;
        clearTimeout(timer);
        hostLooks--;
        lookForHosts();
      };
      factsOf(threadId, true)
        .then(
          (found) => {
            if (found.hostId === null || disposed) return;
            invalidate(threadId);
            opts.onChange([threadId]);
          },
          (err: unknown) => bb.log.warn(`looking for the machine of ${threadId} failed: ${message(err)}`),
        )
        .finally(() => {
          hostPending--;
          if (freed) lookForHosts();
          else free();
        });
    }
  }

  async function factsOf(threadId: string, direct = false): Promise<Facts> {
    const held = facts.get(threadId);
    if (held && !held.outdated && now() - held.at < (held.retry ? retryMs : FACTS_TTL_MS)) return held;
    const under = looking.get(threadId);
    if (under) return under;
    const token = {};
    owners.set(threadId, token);
    const live = (): boolean => !disposed && owners.get(threadId) === token;
    const run = (async (): Promise<Facts> => {
      let found: Facts;
      let overtaken = false;
      let failed = false;
      for (let tries = 1; ; tries++) {
        const started = starts.get(threadId) ?? 0;
        try {
          found = await lookUp(threadId, direct, live);
          failed = false;
        } catch (err) {
          failed = true;
          bb.log.warn(`looking up thread ${threadId} failed, so Burn reads no session log for it: ${message(err)}`);
          found = { at: now(), hostId: null, providerId: null, sessionIds: [], stems: new Set(), retry: true };
        }
        overtaken = (starts.get(threadId) ?? 0) !== started;
        if (!overtaken || tries >= LOOKUP_TRIES || !live()) break;
      }
      // Ended by forget or dispose: keep nothing, schedule nothing, and give the callers no machine to ask.
      if (!live()) return { at: now(), hostId: null, providerId: found.providerId, sessionIds: [], stems: new Set() };
      const provisional =
        found.providerId !== null &&
        harnessOf(found.providerId).reader === "pi-log" &&
        found.sessionIds.length === 1 &&
        found.sessionIds[0] === threadId;
      // A thread that started again during the last try may have a session this lookup missed; the next read looks again.
      found = { ...found, retry: found.retry === true || provisional, ...(overtaken ? { outdated: true } : {}) };
      // A failed lookup keeps its count, so a thread whose lookups keep failing stops at the retry limit.
      if (!provisional && !failed) retryAttempts.delete(threadId);
      remember(facts, threadId, found);
      if (found.retry && statuses.get(threadId) === "active") scheduleRetry(threadId);
      if (found.awaitingHost) awaitHost(threadId);
      else if (found.hostId !== null) hostSteps.delete(threadId);
      return found;
    })();
    looking.set(threadId, run);
    try {
      return await run;
    } finally {
      if (looking.get(threadId) === run) looking.delete(threadId);
      if (owners.get(threadId) === token) owners.delete(threadId);
    }
  }

  function invalidate(threadId: string): void {
    reports.delete(threadId);
    reading.delete(threadId);
    remember(versions, threadId, (versions.get(threadId) ?? 0) + 1);
  }

  const fresh = (threadId: string): boolean => {
    const held = reports.get(threadId);
    return held !== undefined && now() - held.checkedAt < REPORT_TTL_MS;
  };
  const hostDown = (hostId: string): boolean => {
    const failure = failures.get(hostId);
    return failure !== undefined && now() - failure.at < failure.delay;
  };

  /** A host that was not connected is again: forget its failures and read its threads again, since their logs may have changed meanwhile. */
  function hostConnected(hostId: string): void {
    failures.delete(hostId);
    const hit: string[] = [];
    for (const [threadId, f] of facts) if (f.hostId === hostId) hit.push(threadId);
    for (const threadId of hit) invalidate(threadId);
    if (hit.length > 0 && !disposed) opts.onChange(hit);
  }
  const hosts = createHostWatch(bb, { onConnect: hostConnected, now });

  async function save(threadId: string, got: LogReport, gen: number): Promise<void> {
    if (gen !== priceGeneration || saved.get(threadId) === got.at) return;
    try {
      await bb.storage.kv.set(logKey(threadId), { report: got.report, at: got.at });
      remember(saved, threadId, got.at);
    } catch (err) {
      bb.log.warn(`saving the log report of ${threadId} failed: ${message(err)}`);
    }
  }

  async function lastKept(threadId: string): Promise<LogReport | null> {
    const raw = await bb.storage.kv.get<unknown>(logKey(threadId));
    if (raw === undefined) return null;
    const parsed = logSchema.safeParse(raw);
    if (parsed.success) return { ...parsed.data, source: "log" };
    await bb.storage.kv.delete(logKey(threadId));
    return null;
  }

  async function ask(
    hostId: string,
    harness: "pi" | "opencode" | "claude",
    threadIds: string[],
    answers: Map<string, LogReport | null>,
  ): Promise<void> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Only the Claude reader prices tokens from this table; pi and opencode record their own cost.
    const prices = harness === "claude" ? (opts.overrides?.() ?? {}) : {};
    for (let start = 0; start < threadIds.length; start += HOST_BATCH) {
      const batch = threadIds.slice(start, start + HOST_BATCH);
      const seen = new Map(batch.map((id) => [id, versions.get(id) ?? 0]));
      const checkedAt = now();
      const gen = priceGeneration;
      let answer: Awaited<ReturnType<typeof host.call<"reports">>>;
      try {
        answer = await host.call(
          "reports",
          {
            harness,
            timeZone,
            threads: batch.map((threadId) => ({
              threadId,
              sessionIds: facts.get(threadId)?.sessionIds ?? [threadId],
              ...(harness === "claude" && facts.get(threadId)?.since !== undefined ? { since: facts.get(threadId)!.since! } : {}),
              ...(harness === "claude" && facts.get(threadId)?.parentSessionIds !== undefined ? { parentSessionIds: facts.get(threadId)!.parentSessionIds! } : {}),
            })),
            ...(harness === "claude" && Object.keys(prices).length > 0 ? { prices } : {}),
          },
          { hostId, timeoutMs: HOST_TIMEOUT_MS },
        );
      } catch (err) {
        const failure = failures.get(hostId);
        const at = now();
        // Reads that were already under way when the host first failed also fail; they must not double the wait.
        if (failure === undefined) failures.set(hostId, { at, delay: HOST_RETRY_MS });
        else if (at - failure.at >= failure.delay) failures.set(hostId, { at, delay: Math.min(failure.delay * 2, HOST_RETRY_MAX_MS) });
        if (failure === undefined) {
          const what = harness === "claude" ? "Claude transcripts" : harness === "pi" ? "pi session logs" : "opencode's database";
          bb.log.warn(`reading ${what} on ${hostId} failed, so Burn shows the last figures it read there and asks again after a growing wait: ${message(err)}`);
        }
        return;
      }
      failures.delete(hostId);
      for (const { threadId, report, at } of answer.reports) {
        let got: LogReport | null = report !== null && at !== null ? { report, at, source: "log" } : null;
        if (gen === priceGeneration && harness === "claude" && got?.report.coverage === "partial") {
          const kept = await lastKept(threadId);
          if (kept && kept.report.coverage !== "partial") {
            got = {
              ...kept,
              report: {
                ...kept.report,
                coverage: "partial",
                coverageNote: "Partial latest Claude history: showing the last saved transcript report.",
              },
            };
          }
        }
        answers.set(threadId, got);
        if (gen === priceGeneration && (versions.get(threadId) ?? 0) === seen.get(threadId)) remember(reports, threadId, { got, checkedAt }, REPORTS_MAX);
        if (got) await save(threadId, got, gen);
      }
    }
  }

  host.experimental_onSignal("changed", ({ hostId, payload }) => {
    const changed = new Set(payload.sessionIds);
    const hit: string[] = [];
    for (const [threadId, f] of facts) {
      if (f.hostId === hostId && (payload.all || [...f.stems].some((stem) => changed.has(stem)))) hit.push(threadId);
    }
    for (const threadId of hit) invalidate(threadId);
    if (hit.length > 0) opts.onChange(hit);
  });

  host.experimental_onWorkerExit(({ hostId }) => {
    for (const [threadId, f] of facts) if (f.hostId === hostId) invalidate(threadId);
  });

  function hear(thread: { id: string; status: string }): void {
    remember(heardAt, thread.id, now());
    remember(statuses, thread.id, thread.status);
  }

  /** bb stores a turn's usage just before the thread goes idle, so a status change reads the thread's events again. */
  function heardStatus(thread: { id: string; status: string; providerId: string }): void {
    hear(thread);
    const reader = harnessOf(thread.providerId).reader;
    if (reader === "events") events.invalidate(thread.id);
    // opencode records a call when it finishes, and Burn has no watch on its database.
    else if (reader === "opencode-db" || reader === "claude-log") {
      invalidate(thread.id);
      if (reader === "claude-log") events.invalidate(thread.id);
    }
    opts.onChange([thread.id]);
  }

  bb.events.on("thread.active", ({ thread }) => {
    // A thread that just started may have a session bb had not named yet.
    if (harnessOf(thread.providerId).reader !== "events") {
      outdate(thread.id);
      remember(starts, thread.id, (starts.get(thread.id) ?? 0) + 1);
      retryAttempts.delete(thread.id);
      hostSteps.delete(thread.id);
      // A report held from before the start would hide the new session until it expired.
      invalidate(thread.id);
    }
    heardStatus(thread);
  });
  for (const name of ["thread.idle", "thread.failed"] as const) bb.events.on(name, ({ thread }) => heardStatus(thread));
  // Burn has no watch on opencode's database; bb records the thread's events, at most once a second, while opencode works.
  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (!["opencode-db", "claude-log"].includes(harnessOf(thread.providerId).reader)) return;
    invalidate(thread.id);
    opts.onChange([thread.id]);
  });

  return {
    async reportsOf(threadIds, { deadlineMs } = {}) {
      const ids = [...new Set(threadIds)];
      const answers = new Map<string, LogReport | null>();
      const fromEvents = new Map<string, LogReport | null>();
      const own: Promise<void>[] = [];
      const joined = new Map<Promise<void>, number>();
      const until = deadlineMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + deadlineMs;
      // Facts are looked up a few threads at a time and only until the deadline, so a page over a
      // thousand threads answers with what is ready rather than waiting for every thread.
      const stale = ids.filter((threadId) => !fresh(threadId));
      const looked: Array<{ threadId: string } & Facts> = [];
      const factsRun = eachLimit(stale, FACTS_CONCURRENCY, async (threadId) => {
        looked.push({ threadId, ...(await factsOf(threadId)) });
      });
      const factsInTime = await settlesBy(factsRun, until);
      // Nothing below awaits until every read is registered, so two callers never ask a host for the same thread.
      const wanted = new Map<string, { hostId: string; harness: "pi" | "opencode" | "claude"; threadIds: string[] }>();
      for (const { threadId, hostId, providerId } of looked) {
        if (fresh(threadId)) continue;
        const reader = providerId === null ? null : harnessOf(providerId).reader;
        if (providerId !== null && reader === "events") {
          own.push(events.reportOf(threadId, providerId).then((got) => void fromEvents.set(threadId, got && { ...got, source: "events" })));
          continue;
        }
        const under = reading.get(threadId);
        if (under) {
          joined.set(under.run, Math.min(until, under.until));
          continue;
        }
        if (hostId === null || !hosts.connected(hostId) || hostDown(hostId)) continue;
        const harness = reader === "claude-log" ? "claude" : reader === "opencode-db" ? "opencode" : "pi";
        const key = `${hostId}:${harness}`;
        const group = wanted.get(key) ?? { hostId, harness, threadIds: [] };
        group.threadIds.push(threadId);
        wanted.set(key, group);
      }
      // Snapshot before any await below: only the threads already in `wanted` are accounted for here,
      // so the rest are exactly the ones a late fact lookup still has to signal.
      const ready = new Set(looked.map((l) => l.threadId));
      for (const { hostId, harness, threadIds: asked } of wanted.values()) {
        const run = ask(hostId, harness, asked, answers);
        for (const threadId of asked) reading.set(threadId, { run, until });
        const done = () => {
          for (const threadId of asked) if (reading.get(threadId)?.run === run) reading.delete(threadId);
        };
        run.then(done, done);
        own.push(run);
      }
      const waits = [settlesBy(Promise.all(own), until), ...[...joined].map(([run, by]) => settlesBy(run, by))];
      const inTime = (await Promise.all(waits)).every(Boolean);

      /** What the reads said, once done; undefined for a thread they left as it was. */
      const latest = (threadId: string): LogReport | null | undefined => {
        if (fromEvents.has(threadId)) return fromEvents.get(threadId) ?? null;
        if (answers.has(threadId)) return answers.get(threadId) ?? null;
        return fresh(threadId) ? (reports.get(threadId)?.got ?? null) : undefined;
      };
      const out = new Map<string, LogReport>();
      await eachLimit(ids, FACTS_CONCURRENCY, async (threadId) => {
        const got = latest(threadId);
        if (fromEvents.has(threadId)) {
          if (got) out.set(threadId, got);
          return;
        }
        const best = got ?? (await lastKept(threadId));
        if (best) out.set(threadId, best);
        else if (facts.get(threadId)?.providerId === "claude-code") {
          const fallback = await events.reportOf(threadId, "claude-code");
          if (fallback)
            out.set(threadId, {
              ...fallback,
              source: "events",
              report: {
                ...fallback.report,
                coverage: "partial",
                coverageNote: "Limited coverage: saved history is unavailable; some subagent usage and earlier turns may be missing.",
              },
            });
        }
      });
      if (!factsInTime) {
        factsRun.then(
          () => {
            if (disposed) return;
            // A thread forgotten meanwhile has no details left, and nothing to fill in.
            const late = stale.filter((threadId) => !ready.has(threadId) && facts.has(threadId));
            if (late.length > 0) opts.onChange(late);
          },
          (err: unknown) => bb.log.warn(`looking up the threads of ${ids.length} thread(s) failed: ${message(err)}`),
        );
      }
      if (!inTime) {
        Promise.all([...own, ...joined.keys()]).then(
          () => {
            if (disposed) return;
            const late = ids.filter((threadId) => {
              const got = latest(threadId);
              return got != null && got.at !== out.get(threadId)?.at && facts.has(threadId);
            });
            if (late.length > 0) opts.onChange(late);
          },
          (err: unknown) => bb.log.warn(`reading the reports of ${ids.length} thread(s) failed: ${message(err)}`),
        );
      }
      return out;
    },
    async running(threadId) {
      // Reads only what is known. A lookup of its own would fire one per thread the moment
      // `resolveMany` runs, undoing the bound `reportsOf` puts on the same work; `reportsOf`
      // and `warm` populate the status, and a thread event keeps it current.
      return statuses.get(threadId) === "active";
    },
    reading(threadIds) {
      // Host reads only: each is followed by a signal when it settles, so the count cannot latch.
      // Facts lookups are not counted, since a background `warm` starts ones no answer will signal.
      let count = 0;
      for (const threadId of threadIds) if (reading.has(threadId)) count++;
      return count;
    },
    async warm(threadIds) {
      await eachLimit([...new Set(threadIds)], FACTS_CONCURRENCY, async (threadId) => {
        await factsOf(threadId);
      });
    },
    harnessOf: async (threadId) => {
      const { providerId } = await factsOf(threadId);
      return providerId === null ? null : harnessOf(providerId);
    },
    reprice() {
      priceGeneration++;
      events.invalidateAll();
      reports.clear();
      // The KV log copy keeps the prices it was read with; a repriced host read has the same `at`, so save would skip it.
      saved.clear();
    },
    async forget(threadId) {
      for (const timers of [retryTimers, hostTimers]) {
        const timer = timers.get(threadId);
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.delete(threadId);
        }
      }
      retryAttempts.delete(threadId);
      hostSteps.delete(threadId);
      hostQueue.delete(threadId);
      for (const map of [facts, statuses, heardAt, reports, versions, saved, reading, looking, starts, owners]) map.delete(threadId);
      await events.forget(threadId);
    },
    dispose() {
      disposed = true;
      hosts.dispose();
      hostQueue.clear();
      for (const timers of [retryTimers, hostTimers]) {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
      }
    },
  };
}
