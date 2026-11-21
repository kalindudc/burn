import { lstat, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { buildReport, type EntryLike, forkedAt, slimEntry, type UsageReport } from "../../../src/report.js";

const NEWLINE = 0x0a;
const CHUNK_BYTES = 1024 * 1024;
const FILES_MAX = 1000;
/** Expire discovery on the next read after a minute, without scanning on every warm read. */
const OMP_DISCOVERY_TTL_MS = 60_000;
/** Entries kept per log; a longer session is read from its newest entries, as opencode's reader caps its messages. */
const ENTRIES_FILE_MAX = 50_000;
/** Entries kept across every log, so a host with many long sessions stays bounded; an evicted log is read again when asked for. */
const ENTRIES_TOTAL_MAX = 200_000;
/** A line with no newline this long is dropped instead of held, so one corrupt write cannot grow the buffer without bound. */
const CARRY_MAX_BYTES = 4 * 1024 * 1024;
const EXTENSION = ".jsonl";

/** Where older bb kept every pi session. Newer bb copies a log from here into its bridge folder when the thread next runs. */
export function legacySessionDir(home = homedir()): string {
  return join(home, ".bb", "pi-bridge-sessions");
}

/** bb's data folder: bb gives a host worker `<bb data>/plugins/<plugin id>/host-data`. */
function bbDataDir(hostDataDir: string | undefined, home: string): string {
  if (hostDataDir !== undefined && basename(hostDataDir) === "host-data" && basename(dirname(dirname(hostDataDir))) === "plugins") {
    return dirname(dirname(dirname(hostDataDir)));
  }
  return join(home, ".bb");
}

/**
 * Every folder that can hold a pi session log on this machine: BB_PI_BRIDGE_SESSION_DIR when this
 * worker sees it, provider-pi's `<bb data>/plugins/provider-pi/bridge-data/sessions`, then the folder
 * older bb used. The defaults stay in the list because bb can give the variable to plugins without
 * giving it to the bridge, which then still writes to its default folder.
 */
export function piSessionDirs(opts: { hostDataDir?: string; env?: Readonly<Record<string, string | undefined>>; home?: string } = {}): string[] {
  const home = opts.home ?? homedir();
  const override = (opts.env ?? process.env).BB_PI_BRIDGE_SESSION_DIR?.trim();
  const bridge = join(bbDataDir(opts.hostDataDir, home), "plugins", "provider-pi", "bridge-data", "sessions");
  return [...new Set([...(override ? [resolve(override)] : []), bridge, legacySessionDir(home)])];
}

/** A file or folder the worker may not read, as opposed to one that is not there. */
export const isAccessDenied = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
};

/** OMP's native session tree, grouped by working directory. */
export function ompSessionDir(home = homedir()): string {
  return join(home, ".omp", "agent", "sessions");
}

const OMP_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** The file name stem bb's pi bridge uses for a session id (provider-pi's sanitizeSessionKey). */
export const sessionStem = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");

export const sessionFile = (dir: string, id: string): string => join(dir, `${sessionStem(id)}${EXTENSION}`);

/**
 * The folder of the session log a thread's pi reported, when the file is named for one of the
 * thread's own sessions; else null. Only the thread's own session file names are read there, each
 * only when it is a regular file, so a report cannot point Burn at another thread's log, at a link
 * or at a file that is not a session log.
 */
export function hintedDir(file: string | undefined, sessionIds: readonly string[]): string | null {
  if (file === undefined || !isAbsolute(file)) return null;
  const name = basename(file);
  return sessionIds.some((id) => `${sessionStem(id)}${EXTENSION}` === name) ? dirname(resolve(file)) : null;
}

/** What has been read of one log: `offset` bytes, of which `carry` is a line pi has not finished writing. */
interface FileState {
  offset: number;
  mtimeMs: number;
  carry: Buffer;
  firstLine: string | null;
  header: unknown;
  /** Complete parsed entries before trimming, so capped snapshots still compare by history length. */
  parsedEntries: number;
  entries: EntryLike[];
}

export interface PiSessions {
  /**
   * The report of a thread's sessions on this machine; null when none has a file. `hintedDir` is one
   * more folder for the thread's sessions, where only regular files count (pi layout only).
   */
  reportOf(sessionIds: readonly string[], timeZone: string, hintedDir?: string): Promise<{ report: UsageReport; at: number } | null>;
  /** The session a changed path belongs to, or null when it is not a session log. */
  sessionIdOf(path: string): string | null;
}

const fresh = (): FileState => ({ offset: 0, mtimeMs: 0, carry: Buffer.alloc(0), firstLine: null, header: null, parsedEntries: 0, entries: [] });

function consumeLine(state: FileState, line: string): void {
  if (line.trim() === "") return;
  const first = state.firstLine === null;
  if (first) state.firstLine = line;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (state.header === null && (value as { type?: unknown } | null)?.type === "session") {
    state.header = value;
    return;
  }
  const entry = slimEntry(value);
  if (entry) {
    state.entries.push(entry);
    state.parsedEntries++;
  }
}

/** Drops the oldest entries past the per-file cap; the newest matter most for a live chip. */
function trim(state: FileState, max: number): void {
  const excess = state.entries.length - max;
  if (excess > 0) state.entries.splice(0, excess);
}

function consume(state: FileState, bytes: Buffer, carryMax: number): void {
  // Split on the newline byte, never inside a character: UTF-8 never uses 0x0a within one.
  const buf = state.carry.length > 0 ? Buffer.concat([state.carry, bytes]) : bytes;
  let start = 0;
  for (let end = buf.indexOf(NEWLINE); end !== -1; end = buf.indexOf(NEWLINE, start)) {
    consumeLine(state, buf.toString("utf8", start, end));
    start = end + 1;
  }
  state.carry = Buffer.from(buf.subarray(start));
  if (state.carry.length > carryMax) state.carry = Buffer.alloc(0);
}

async function readFirstLine(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

interface Limits {
  entriesFileMax: number;
  entriesTotalMax: number;
  carryMaxBytes: number;
}

async function readFrom(path: string, state: FileState, size: number, limits: Limits): Promise<void> {
  const handle = await open(path, "r");
  try {
    while (state.offset < size) {
      const length = Math.min(CHUNK_BYTES, size - state.offset);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, state.offset);
      if (bytesRead === 0) break;
      state.offset += bytesRead;
      consume(state, chunk.subarray(0, bytesRead), limits.carryMaxBytes);
      trim(state, limits.entriesFileMax);
    }
  } finally {
    await handle.close();
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Reads pi session logs incrementally: each file keeps what was parsed, as slim
 * entries, and later reads parse only the bytes pi appended. A file that shrank
 * or whose first line changed (pi rewrote it) is read again from the start.
 */
export function createPiSessions(
  opts: { limits?: Partial<Limits> } & ({ layout?: "pi"; dirs: readonly string[] } | { layout: "omp"; dir: string }),
): PiSessions {
  const limits: Limits = {
    entriesFileMax: opts.limits?.entriesFileMax ?? ENTRIES_FILE_MAX,
    entriesTotalMax: opts.limits?.entriesTotalMax ?? ENTRIES_TOTAL_MAX,
    carryMaxBytes: opts.limits?.carryMaxBytes ?? CARRY_MAX_BYTES,
  };
  const files = new Map<string, FileState>();
  const busy = new Map<string, Promise<FileState | null>>();
  // Keep every known copy of an OMP identity, but do not rescan unrelated history on warm reads.
  const ompPaths = new Map<string, { paths: string[]; at: number }>();
  const warned = new Set<string>();

  function unavailable(path: string, err: unknown): boolean {
    if (isMissing(err)) return true;
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") return false;
    if (!warned.has(path)) {
      if (warned.size >= FILES_MAX) warned.clear();
      warned.add(path);
      console.warn(`[burn] cannot read ${opts.layout === "omp" ? "OMP" : "pi"} session path ${path}: ${code}; its sessions may be unavailable`);
    }
    return true;
  }

  /** Entries held across every file; recomputed at a keep, which runs once per file read. */
  function heldEntries(): number {
    let total = 0;
    for (const state of files.values()) total += state.entries.length;
    return total;
  }

  function keep(path: string, state: FileState): void {
    files.delete(path);
    files.set(path, state);
    // Drop the least recently read logs first. The one just read is last, so it is evicted only when it is the only one left.
    while ((files.size > FILES_MAX || heldEntries() > limits.entriesTotalMax) && files.size > 1) {
      const oldest = files.keys().next().value;
      if (oldest === undefined) break;
      files.delete(oldest);
    }
  }

  async function update(path: string): Promise<FileState | null> {
    let info: { size: number; mtimeMs: number };
    try {
      info = await stat(path);
    } catch (err) {
      if (!isMissing(err)) throw err;
      files.delete(path);
      return null;
    }
    let state = files.get(path);
    if (state && info.size === state.offset && info.mtimeMs === state.mtimeMs) {
      // Touch the entry so eviction follows last use, not last change.
      keep(path, state);
      return state;
    }
    if (state && (info.size < state.offset || (state.firstLine !== null && (await rewritten(path, state.firstLine))))) state = undefined;
    state ??= fresh();
    if (info.size > state.offset) await readFrom(path, state, info.size, limits);
    state.mtimeMs = info.mtimeMs;
    keep(path, state);
    return state;
  }

  async function rewritten(path: string, firstLine: string): Promise<boolean> {
    return (await readFirstLine(path, Buffer.byteLength(firstLine))) !== firstLine;
  }

  /** One read of a file at a time, so two calls never append the same lines twice. */
  function refresh(path: string): Promise<FileState | null> {
    const run = (busy.get(path) ?? Promise.resolve(null)).then(
      () => update(path),
      () => update(path),
    );
    busy.set(path, run);
    const done = () => {
      if (busy.get(path) === run) busy.delete(path);
    };
    run.then(done, done);
    return run;
  }

  /**
   * A pi session's copies, the one bb most likely still writes to first. Newer bb copies an older log
   * into its bridge folder and appends only there, and an older bb, after a downgrade, appends only to
   * the old one. So the copy written last comes first, then the larger, then the folder listed first.
   * A copy that cannot be read gives way to the next one.
   */
  async function copiesOf(dirs: readonly string[], id: string, denied: Map<string, unknown>, hinted?: string): Promise<string[]> {
    const found: { path: string; mtimeMs: number; size: number; order: number }[] = [];
    const candidates = [...new Set([...(hinted === undefined ? [] : [sessionFile(hinted, id)]), ...dirs.map((dir) => sessionFile(dir, id))])];
    for (const [order, path] of candidates.entries()) {
      try {
        // A folder a report named counts only its regular files, never a link to some other log.
        const isHinted = hinted !== undefined && order === 0;
        const info = isHinted ? await lstat(path) : await stat(path);
        if (isHinted && !info.isFile()) {
          files.delete(path);
          continue;
        }
        found.push({ path, mtimeMs: info.mtimeMs, size: info.size, order });
      } catch (err) {
        files.delete(path);
        if (!unavailable(path, err)) throw err;
        if (!isMissing(err) && !denied.has(id)) denied.set(id, err);
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size || a.order - b.order).map((c) => c.path);
  }

  async function discover(root: string, ids: ReadonlySet<string>): Promise<{ found: Map<string, string[]>; incomplete: boolean }> {
    const discovered = new Map<string, string[]>();
    const at = Date.now();
    let incomplete = false;
    try {
      const projects = await readdir(root, { withFileTypes: true });
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const dir = join(root, project.name);
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
          if (unavailable(dir, err)) {
            incomplete = true;
            continue;
          }
          throw err;
        }
        for (const file of entries) {
          if (!file.isFile() || !file.name.endsWith(EXTENSION)) continue;
          const id = file.name.slice(file.name.lastIndexOf("_") + 1, -EXTENSION.length);
          if (!ids.has(id)) continue;
          const paths = discovered.get(id) ?? [];
          paths.push(join(dir, file.name));
          discovered.set(id, paths);
        }
      }
    } catch (err) {
      if (!unavailable(root, err)) throw err;
      incomplete = true;
    }
    // Never cache a partially enumerated tree: later reads must retry the inaccessible buckets.
    for (const id of ids) {
      const paths = discovered.get(id);
      if (paths && !incomplete) ompPaths.set(id, { paths, at });
      else ompPaths.delete(id);
    }
    while (ompPaths.size > FILES_MAX) {
      const oldest = ompPaths.keys().next().value;
      if (oldest === undefined) break;
      ompPaths.delete(oldest);
    }
    return { found: discovered, incomplete };
  }

  async function pathsOf(
    ids: ReadonlySet<string>,
    denied: Map<string, unknown>,
    hinted?: string,
  ): Promise<{ paths: { path: string; id: string }[]; incomplete: boolean }> {
    if (opts.layout !== "omp") {
      const paths = [];
      for (const id of ids) {
        for (const path of await copiesOf(opts.dirs, id, denied, hinted)) paths.push({ path, id });
      }
      return { paths, incomplete: false };
    }
    const now = Date.now();
    const missing = new Set([...ids].filter((id) => {
      const cached = ompPaths.get(id);
      return !cached || now < cached.at || now - cached.at >= OMP_DISCOVERY_TTL_MS;
    }));
    const scan = missing.size > 0 ? await discover(opts.dir, missing) : null;
    const paths = [...ids].flatMap((id) => {
      const cached = ompPaths.get(id);
      const known = scan?.found.get(id) ?? cached?.paths;
      if (!known) return [];
      if (cached) {
        ompPaths.delete(id);
        ompPaths.set(id, cached);
      }
      return known.map((path) => ({ path, id }));
    });
    return { paths, incomplete: scan?.incomplete ?? false };
  }

  return {
    async reportOf(sessionIds, timeZone, hinted) {
      const foundById = new Map<string, FileState>();
      const ids = new Set(sessionIds.filter((id) => opts.layout !== "omp" || OMP_ID.test(id)));
      const missing = new Set<string>();
      const denied = new Map<string, unknown>();
      let unreadable = false;
      async function collect(paths: { path: string; id: string }[]): Promise<void> {
        for (const { path, id } of paths) {
          // pi: the first copy that reads is the session; the others are not read or kept.
          if (opts.layout !== "omp" && foundById.has(id)) {
            files.delete(path);
            continue;
          }
          let state: FileState | null;
          try {
            state = await refresh(path);
          } catch (err) {
            if (unavailable(path, err)) {
              unreadable = true;
              if (!isMissing(err) && !denied.has(id)) denied.set(id, err);
              continue;
            }
            throw err;
          }
          if (!state || (opts.layout === "omp" && (state.header as { id?: unknown } | null)?.id !== id)) {
            missing.add(id);
            continue;
          }
          const previous = foundById.get(id);
          // Inspect every known copy; a newer filesystem timestamp can still carry stale content.
          if (!previous || state.parsedEntries > previous.parsedEntries ||
            (state.parsedEntries === previous.parsedEntries && state.mtimeMs > previous.mtimeMs)) {
            foundById.set(id, state);
          }
        }
      }
      const initial = await pathsOf(ids, denied, hinted);
      unreadable ||= initial.incomplete;
      await collect(initial.paths);
      if (opts.layout === "omp" && missing.size > 0) {
        // A session can move between project buckets. Rediscover only identities whose path disappeared.
        for (const id of missing) ompPaths.delete(id);
        const retried = await pathsOf(missing, denied);
        unreadable ||= retried.incomplete;
        await collect(retried.paths);
      }
      const found = [...foundById.values()];
      if (found.length === 0) {
        // A pi folder this worker may not read could hold the session, so say so rather than report none.
        const blocked = opts.layout === "omp" ? undefined : [...denied.values()][0];
        if (blocked !== undefined) throw blocked;
        return null;
      }
      const began = (s: FileState): number => {
        const at = Date.parse((s.header as { timestamp?: string } | null)?.timestamp ?? "");
        return Number.isFinite(at) ? at : 0;
      };
      const entries = found
        .sort((a, b) => began(a) - began(b))
        .flatMap((s) => {
          const cut = forkedAt(s.header);
          return cut === null ? s.entries : s.entries.filter((e) => !(Date.parse(e.timestamp) < cut));
        });
      const report = buildReport(entries, null, { timeZone });
      if (opts.layout === "omp" && (unreadable || foundById.size < ids.size)) {
        report.coverage = "partial";
        report.coverageNote = "Partial OMP session history: some recorded sessions are unavailable.";
      } else if (opts.layout !== "omp" && [...denied.keys()].some((id) => !foundById.has(id))) {
        report.coverage = "partial";
        report.coverageNote = "Partial pi session history: Burn may not read some of this thread's session logs.";
      }
      return { report, at: Math.max(...found.map((s) => s.mtimeMs)) };
    },
    sessionIdOf(path) {
      const name = basename(path);
      return name.endsWith(EXTENSION) && name.length > EXTENSION.length ? name.slice(0, -EXTENSION.length) : null;
    },
  };
}
