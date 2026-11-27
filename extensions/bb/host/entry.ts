import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExperimentalHostRpcContext, ExperimentalHostWatchEvent, ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { CHANGED_MAX, hostContract, hostSignals } from "./contract.js";
import { antigravityBrainDir, createAntigravitySessions } from "./antigravity-sessions.js";
import { createClaudeSessions, claudeProjectsDir } from "./claude-sessions.js";
import { createOpencodeDb, opencodeDbPath } from "./opencode-db.js";
import { createPiSessions, hintedDir, isAccessDenied, ompSessionDir, piSessionDirs, type PiSessions } from "./pi-sessions.js";
import { usageReportSchema } from "../schema.js";

type Context = ExperimentalHostRpcContext<typeof hostSignals>;

/** How long a call waits for its watch to be ready, about ten times what a watch takes. */
const WATCH_WAIT_MS = 1000;

/**
 * The folder's path with every symlink resolved, a part that does not exist yet
 * joined on as it is. Some machines link `~/.bb` elsewhere, and a file watcher
 * can refuse a root reached through a link.
 */
export async function realDir(dir: string): Promise<string> {
  const rest: string[] = [];
  for (let at = dir; ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...rest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw err;
      rest.unshift(basename(at));
    }
  }
}

interface Watch {
  run: Promise<ExperimentalHostWatchSubscription | null>;
  live: ExperimentalHostWatchSubscription | null;
}

/**
 * The Burn host entry: reads pi's session logs and opencode's database on the
 * machine bb runs it on, and signals the server as soon as a pi log changes so
 * the chip updates live. `piDirs` names the pi session folders from the data
 * folder bb gives this worker, which only a call can see.
 */
export function createHostEntry(opts: {
  piDirs?: (hostDataDir: string | undefined) => readonly string[];
  ompDir?: string;
  opencodeDb?: string;
  opencodeModels?: string;
  watchWaitMs?: number;
  claudeDir?: string;
  antigravityDir?: string;
} = {}) {
  const agyDir = opts.antigravityDir ?? antigravityBrainDir();
  const antigravity = createAntigravitySessions(agyDir);
  const claude = createClaudeSessions({ dir: opts.claudeDir ?? claudeProjectsDir() });
  const locate = opts.piDirs ?? ((hostDataDir) => piSessionDirs({ hostDataDir }));
  let pi: { dirs: readonly string[]; sessions: PiSessions } | null = null;
  const ompDir = opts.ompDir ?? ompSessionDir();
  const omp = createPiSessions({ dir: ompDir, layout: "omp" });
  const opencode = createOpencodeDb({ path: opts.opencodeDb ?? opencodeDbPath(), modelsPath: opts.opencodeModels });
  const watchWaitMs = opts.watchWaitMs ?? WATCH_WAIT_MS;
  const watches = new Map<string, Watch>();
  // One bad log should cost its own thread's figures, not the batch's; the warning is once per thread so a live read does not flood the log.
  const warned = new Set<string>();

  /** The pi folders, found from the data folder bb sends with each call; without one they sit under ~/.bb. */
  function piOf(context: Context): { dirs: readonly string[]; sessions: PiSessions } {
    if (pi === null) {
      const dirs = [...new Set(locate((context.experimental_paths as { dataDir?: string } | undefined)?.dataDir))];
      pi = { dirs, sessions: createPiSessions({ dirs }) };
    }
    return pi;
  }

  async function onEvent(dir: string, watch: Watch, event: ExperimentalHostWatchEvent, context: Context): Promise<void> {
    if (event.kind === "watch-error") {
      // bb retries a watch that is not ready yet on its own; one that was ready has ended, so the next call starts another.
      const broken = watch.live;
      if (broken === null) return;
      watch.live = null;
      if (watches.get(dir) === watch) watches.delete(dir);
      await broken.dispose().catch(() => undefined);
      return;
    }
    if (event.kind === "rescan-required") return context.experimental_emitSignal("changed", { sessionIds: [], all: true });
    const { sessions } = piOf(context);
    const ids = [...new Set(event.changes.map((c) => sessions.sessionIdOf(c.path)).filter((id) => id !== null))];
    if (ids.length === 0) return;
    await context.experimental_emitSignal("changed", ids.length > CHANGED_MAX ? { sessionIds: [], all: true } : { sessionIds: ids, all: false });
  }

  /** `late` is a watch on a folder that did not exist yet: pi may write there before bb is watching, so its start rereads everything. */
  function startWatch(dir: string, context: Context, late: boolean): Watch {
    const watch: Watch = { run: Promise.resolve(null), live: null };
    const current = () => watches.get(dir) === watch;
    watch.run = realDir(dir)
      .then((rootPath) => context.experimental_watch({ rootPath, debounceMs: 150, maxWaitMs: 1000 }, (event) => onEvent(dir, watch, event, context)))
      .then(
        async (subscription) => {
          if (current() && !context.signal.aborted) {
            watch.live = subscription;
            if (late) await context.experimental_emitSignal("changed", { sessionIds: [], all: true }).catch(() => undefined);
            return subscription;
          }
          // bb disposes a watch whose call was cancelled before the watch was ready.
          if (current()) watches.delete(dir);
          await subscription.dispose().catch(() => undefined);
          return null;
        },
        () => {
          if (current()) watches.delete(dir);
          return null;
        },
      );
    return watch;
  }

  /**
   * Watches every session folder from the first call on. A call waits a moment for the watches on
   * folders that exist and no longer. bb answers a watch only once its root is watched, which for a
   * missing folder can take until pi first writes there, and such a folder has nothing to read yet.
   */
  async function ensureWatches(context: Context): Promise<void> {
    const runs = [];
    for (const dir of piOf(context).dirs) {
      if (watches.has(dir)) continue;
      const exists = await stat(dir).then(() => true, () => false);
      if (watches.has(dir)) continue;
      const watch = startWatch(dir, context, !exists);
      watches.set(dir, watch);
      if (exists) runs.push(watch.run);
    }
    if (runs.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(runs), new Promise((resolve) => (timer = setTimeout(resolve, watchWaitMs)))]).finally(() => clearTimeout(timer));
  }

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      reports: async ({ harness, threads, timeZone, prices }, context) => {
        // The folder a thread's pi named is read for that thread's sessions only, and never watched: the thread is
        // `unwatched`, so each report from its pi reads it again, including before pi has written its log there.
        const hints = new Map<string, string>();
        if (harness === "pi") {
          await ensureWatches(context);
          const { dirs } = piOf(context);
          for (const { threadId, sessionIds, sessionFile } of threads) {
            const dir = hintedDir(sessionFile, sessionIds);
            if (dir !== null && !dirs.includes(dir)) hints.set(threadId, dir);
          }
        }
        const reports = [];
        for (const { threadId, sessionIds, since, parentSessionIds } of threads) {
          context.signal.throwIfAborted();
          const elsewhere = hints.get(threadId);
          const unwatched = elsewhere === undefined ? {} : { unwatched: true };
          let got;
          try {
            got = harness === "antigravity" || harness === "claude"
                ? await (harness === "antigravity" ? antigravity : claude).reportOf(sessionIds, timeZone, { since, parentSessionIds, prices })
                : harness === "opencode" ? await opencode.reportOf(sessionIds, timeZone)
                : harness === "omp" ? await omp.reportOf(sessionIds, timeZone) : await piOf(context).sessions.reportOf(sessionIds, timeZone, elsewhere);
          } catch (err) {
            // A log this worker may not read costs only its own thread, which keeps its last figures.
            if (harness !== "antigravity" && (harness !== "pi" || !isAccessDenied(err))) throw err;
            reports.push({ threadId, report: null, at: null, error: String((err as Error).message ?? err).slice(0, 500), ...unwatched });
            continue;
          }
          if (harness === "pi" && got === null) {
            reports.push({ threadId, report: null, at: null, searched: [...new Set([...(elsewhere === undefined ? [] : [elsewhere]), ...piOf(context).dirs])], ...unwatched });
            continue;
          }
          // Validate per report, so one malformed report is dropped instead of failing the whole batch at the RPC boundary.
          const parsed = got?.report == null ? null : usageReportSchema.safeParse(got.report);
          if (parsed !== null && !parsed.success) {
            if (!warned.has(threadId)) {
              if (warned.size > 500) warned.clear();
              warned.add(threadId);
              console.warn(`[burn] dropping an invalid ${harness} report for ${threadId}: ${parsed.error.issues[0]?.message ?? "invalid report"}`);
            }
          }
          reports.push({ threadId, report: parsed?.success ? parsed.data : null, at: parsed?.success ? (got?.at ?? null) : null, ...unwatched });
        }
        return { dir: harness === "antigravity" ? agyDir : harness === "omp" ? ompDir : piOf(context).dirs.join(", "), reports };
      },
    },
  });
}

export default createHostEntry();
