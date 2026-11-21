import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentalHostWatchListener, ExperimentalHostWatchOptions } from "@get-bb/plugin-sdk";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { CHANGED_MAX } from "../../extensions/bb/host/contract.js";
import hostEntry, { createHostEntry, realDir } from "../../extensions/bb/host/entry.js";
import { createPiSessions, hintedDir, legacySessionDir, piSessionDirs, sessionFile } from "../../extensions/bb/host/pi-sessions.js";
import { assistant, toolResult, user } from "../helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ZONE = "UTC";
const headerOf = (id: string, timestamp = "2026-10-18T12:00:00.000Z", extra: Record<string, unknown> = {}) => ({
  type: "session",
  version: 3,
  id,
  timestamp,
  cwd: "/tmp",
  ...extra,
});
const line = (entry: unknown): string => `${JSON.stringify(entry)}\n`;
const stamped = (iso: string) => <T extends { timestamp: string }>(entry: T): T => ({ ...entry, timestamp: iso });

function setup(limits?: { entriesFileMax?: number; entriesTotalMax?: number; carryMaxBytes?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "burn-host-"));
  dirs.push(dir);
  const sessions = createPiSessions({ dirs: [dir], ...(limits ? { limits } : {}) });
  const path = (id: string) => sessionFile(dir, id);
  const write = (id: string, entries: unknown[], header: unknown = headerOf(id)): string => {
    writeFileSync(path(id), [header, ...entries].map(line).join(""));
    return path(id);
  };
  const cost = async (...ids: string[]) => (await sessions.reportOf(ids, ZONE))?.report.cost.total;
  return { dir, sessions, path, write, cost };
}

describe("piSessionDirs and sessionFile", () => {
  it("name the files the way bb's pi bridge does", () => {
    expect(legacySessionDir("/home/me")).toBe("/home/me/.bb/pi-bridge-sessions");
    expect(sessionFile("/d", "pi_ef25-17")).toBe("/d/pi_ef25-17.jsonl");
    expect(sessionFile("/d", "a/b c")).toBe("/d/a_b_c.jsonl");
  });

  it("finds provider-pi's bridge folder beside this plugin's host data, then the folder older bb used", () => {
    expect(piSessionDirs({ hostDataDir: "/data/bb/plugins/burn/host-data", home: "/home/me", env: {} })).toEqual([
      "/data/bb/plugins/provider-pi/bridge-data/sessions",
      "/home/me/.bb/pi-bridge-sessions",
    ]);
  });

  it("falls back to ~/.bb when bb gives no host data folder it recognises", () => {
    const expected = ["/home/me/.bb/plugins/provider-pi/bridge-data/sessions", "/home/me/.bb/pi-bridge-sessions"];
    expect(piSessionDirs({ home: "/home/me", env: {} })).toEqual(expected);
    expect(piSessionDirs({ hostDataDir: "/test/plugin-data", home: "/home/me", env: {} })).toEqual(expected);
  });

  it("reads BB_PI_BRIDGE_SESSION_DIR first when the host sees it, and keeps the folders the bridge may still use", () => {
    expect(piSessionDirs({ home: "/home/me", env: { BB_PI_BRIDGE_SESSION_DIR: " /custom/sessions " } })).toEqual([
      "/custom/sessions",
      "/home/me/.bb/plugins/provider-pi/bridge-data/sessions",
      "/home/me/.bb/pi-bridge-sessions",
    ]);
    expect(piSessionDirs({ home: "/home/me", env: { BB_PI_BRIDGE_SESSION_DIR: "  " } })).toHaveLength(2);
  });
});

describe("hintedDir", () => {
  it("is the folder of a session file that names one of the thread's sessions", () => {
    expect(hintedDir("/custom/sessions/pi_one.jsonl", ["pi_one", "pi_two"])).toBe("/custom/sessions");
    expect(hintedDir("/custom/a/../sessions/pi_two.jsonl", ["pi_one", "pi_two"])).toBe("/custom/sessions");
  });

  it("is null for another thread's session, a file that is not a session log, a relative path or none", () => {
    expect(hintedDir("/custom/sessions/pi_other.jsonl", ["pi_one"])).toBeNull();
    expect(hintedDir("/custom/sessions/pi_one.txt", ["pi_one"])).toBeNull();
    expect(hintedDir("sessions/pi_one.jsonl", ["pi_one"])).toBeNull();
    expect(hintedDir(undefined, ["pi_one"])).toBeNull();
  });
});

describe("createPiSessions over several folders", () => {
  function folders() {
    const base = mkdtempSync(join(tmpdir(), "burn-dirs-"));
    dirs.push(base);
    const bridge = join(base, "bridge");
    const legacy = join(base, "legacy");
    mkdirSync(bridge);
    mkdirSync(legacy);
    const sessions = createPiSessions({ dirs: [bridge, legacy] });
    const write = (dir: string, id: string, entries: unknown[], mtime?: number): string => {
      const path = sessionFile(dir, id);
      writeFileSync(path, [headerOf(id), ...entries].map(line).join(""));
      if (mtime !== undefined) utimesSync(path, mtime, mtime);
      return path;
    };
    const cost = async (...ids: string[]) => (await sessions.reportOf(ids, ZONE))?.report.cost.total;
    return { bridge, legacy, sessions, write, cost };
  }

  it("reads a session that only the older folder holds", async () => {
    const f = folders();
    f.write(f.legacy, "pi_old", [user(), assistant(1.5)]);
    f.write(f.bridge, "pi_new", [user(), assistant(2)]);
    expect(await f.cost("pi_old")).toBeCloseTo(1.5);
    expect(await f.cost("pi_old", "pi_new")).toBeCloseTo(3.5);
  });

  it("counts a session copied into the bridge folder once, from the copy bb kept writing", async () => {
    const f = folders();
    f.write(f.legacy, "pi_one", [user(), assistant(1)], 1_700_000_000);
    f.write(f.bridge, "pi_one", [user(), assistant(1)], 1_700_000_000);
    expect(await f.cost("pi_one")).toBeCloseTo(1);
    appendFileSync(sessionFile(f.bridge, "pi_one"), line(user()) + line(assistant(2)));
    expect(await f.cost("pi_one")).toBeCloseTo(3);
  });

  it("follows the folder written last, even while its copy is the smaller one", async () => {
    const f = folders();
    f.write(f.bridge, "pi_one", [user(), assistant(1), user(), assistant(1), user(), assistant(1)], 1_700_000_000);
    f.write(f.legacy, "pi_one", [user(), assistant(5)], 1_700_000_100);
    expect(await f.cost("pi_one")).toBeCloseTo(5);
  });

  it("takes the larger copy when both were written at the same moment", async () => {
    const f = folders();
    f.write(f.bridge, "pi_one", [user(), assistant(1)], 1_700_000_000);
    f.write(f.legacy, "pi_one", [user(), assistant(1), user(), assistant(4)], 1_700_000_000);
    expect(await f.cost("pi_one")).toBeCloseTo(5);
  });

  it("reads a readable folder's copy when another folder cannot be read", async () => {
    const f = folders();
    f.write(f.bridge, "pi_one", [user(), assistant(2)]);
    const flipped = createPiSessions({ dirs: [f.legacy, f.bridge] });
    chmodSync(f.legacy, 0);
    try {
      expect(await f.cost("pi_one")).toBeCloseTo(2);
      expect((await flipped.reportOf(["pi_one"], ZONE))?.report.cost.total).toBeCloseTo(2);
    } finally {
      chmodSync(f.legacy, 0o700);
    }
  });

  it("reads the next copy when the newest one cannot be opened", async () => {
    const f = folders();
    f.write(f.bridge, "pi_one", [user(), assistant(2)], 1_700_000_000);
    const newest = f.write(f.legacy, "pi_one", [user(), assistant(9)], 1_700_000_100);
    chmodSync(newest, 0);
    try {
      expect(await f.cost("pi_one")).toBeCloseTo(2);
    } finally {
      chmodSync(newest, 0o600);
    }
  });

  it("marks a thread's report partial when one of its sessions cannot be read in any folder", async () => {
    const f = folders();
    f.write(f.bridge, "pi_one", [user(), assistant(3)]);
    const shut = f.write(f.legacy, "pi_two", [user(), assistant(6)]);
    expect((await f.sessions.reportOf(["pi_one", "pi_two"], ZONE))?.report).toMatchObject({ cost: { total: 9 } });
    expect((await f.sessions.reportOf(["pi_one", "pi_two"], ZONE))?.report.coverage).toBeUndefined();
    chmodSync(shut, 0);
    try {
      const cold = createPiSessions({ dirs: [f.bridge, f.legacy] });
      expect((await cold.reportOf(["pi_one", "pi_two"], ZONE))?.report).toMatchObject({
        cost: { total: 3 },
        coverage: "partial",
        coverageNote: expect.stringContaining("may not read"),
      });
    } finally {
      chmodSync(shut, 0o600);
    }
  });

  it("fails the read when the only folders that could hold the session cannot be read", async () => {
    const f = folders();
    f.write(f.legacy, "pi_one", [user(), assistant(2)]);
    chmodSync(f.legacy, 0);
    try {
      await expect(f.sessions.reportOf(["pi_one"], ZONE)).rejects.toThrow(/EACCES|EPERM/);
    } finally {
      chmodSync(f.legacy, 0o700);
    }
  });

  it("reads every one of the thread's sessions in a folder named for this read, but no link there", async () => {
    const f = folders();
    const custom = join(f.bridge, "..", "custom");
    const elsewhere = join(f.bridge, "..", "elsewhere");
    mkdirSync(custom);
    mkdirSync(elsewhere);
    // A thread resumed in another worktree has a session before and after; both are in the custom folder.
    f.write(custom, "pi_before", [user(), assistant(4)]);
    f.write(custom, "pi_after", [user(), assistant(5)]);
    f.write(elsewhere, "pi_linked", [user(), assistant(100)]);
    symlinkSync(sessionFile(elsewhere, "pi_linked"), sessionFile(custom, "pi_linked"));
    expect(await f.sessions.reportOf(["pi_before", "pi_after", "pi_linked"], ZONE)).toBeNull();
    expect((await f.sessions.reportOf(["pi_before", "pi_after", "pi_linked"], ZONE, custom))?.report.cost.total).toBeCloseTo(9);
  });

  it("is null when no folder holds the session", async () => {
    const f = folders();
    expect(await f.sessions.reportOf(["pi_none"], ZONE)).toBeNull();
  });
});

describe("createPiSessions", () => {
  it("builds the report from a session log as pi itself would, with when it last changed", async () => {
    const s = setup();
    const file = s.write("pi_one", [user("hi"), assistant(1.25), toolResult(0.25), user("again"), assistant(0.5)]);
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    const got = await s.sessions.reportOf(["pi_one"], ZONE);
    expect(got?.report.cost.total).toBeCloseTo(2);
    expect(got?.report).toMatchObject({ calls: 2, turnCount: 2, running: false, budget: null, context: null });
    expect(got?.at).toBe(1_700_000_000_000);
  });

  it("adds up every session, ordered by when each began, and skips one with no file", async () => {
    const s = setup();
    s.write("pi_one", [user("second"), assistant(2)], headerOf("pi_one", "2026-10-18T13:00:00.000Z"));
    s.write("pi_two", [user("first"), assistant(1)], headerOf("pi_two", "2026-10-18T11:00:00.000Z"));
    const got = await s.sessions.reportOf(["pi_one", "pi_gone", "pi_two"], ZONE);
    expect(got?.report.cost.total).toBeCloseTo(3);
    expect(got?.report.turns.map((t) => t.prompt)).toEqual(["first", "second"]);
  });

  it("is null when none of the sessions has a file", async () => {
    const s = setup();
    expect(await s.sessions.reportOf(["pi_elsewhere"], ZONE)).toBeNull();
    expect(await s.sessions.reportOf([], ZONE)).toBeNull();
  });

  it("parses only the lines appended since the last read", async () => {
    const s = setup();
    const file = s.write("pi_one", [user(), assistant(1), assistant(2)]);
    expect(await s.cost("pi_one")).toBeCloseTo(3);
    // Blank out an already-read line without changing the size: a full reread would lose its $2.
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines[3] = " ".repeat(lines[3]!.length);
    writeFileSync(file, lines.join("\n"));
    appendFileSync(file, line(assistant(4)));
    expect(await s.cost("pi_one")).toBeCloseTo(7);
  });

  it("waits for a line pi is still writing, and skips lines that are not JSON", async () => {
    const s = setup();
    const file = s.write("pi_one", [user(), assistant(1)]);
    const half = line(assistant(2));
    appendFileSync(file, `not json\n${half.slice(0, 40)}`);
    expect(await s.cost("pi_one")).toBeCloseTo(1);
    appendFileSync(file, half.slice(40));
    expect(await s.cost("pi_one")).toBeCloseTo(3);
  });

  it("keeps a character split across two reads whole", async () => {
    const s = setup();
    const file = s.write("pi_one", []);
    const prompt = line(user("caf\u00e9 \u{1f525}"));
    const bytes = Buffer.from(prompt);
    const cut = bytes.indexOf(0xf0) + 2;
    appendFileSync(file, bytes.subarray(0, cut));
    expect((await s.sessions.reportOf(["pi_one"], ZONE))?.report.turnCount).toBe(0);
    appendFileSync(file, bytes.subarray(cut));
    expect((await s.sessions.reportOf(["pi_one"], ZONE))?.report.turns[0]?.prompt).toBe("caf\u00e9 \u{1f525}");
  });

  it("rereads a file that shrank or whose first line changed", async () => {
    const s = setup();
    s.write("pi_one", [user(), assistant(1), assistant(2)]);
    expect(await s.cost("pi_one")).toBeCloseTo(3);
    s.write("pi_one", [user(), assistant(4)]);
    expect(await s.cost("pi_one")).toBeCloseTo(4);
    s.write("pi_one", [user(), assistant(5), assistant(6)], headerOf("pi_one", "2026-10-18T12:30:00.000Z"));
    expect(await s.cost("pi_one")).toBeCloseTo(11);
  });

  it("rereads a file rewritten at the same size when its first line changed", async () => {
    const s = setup();
    const file = s.write("pi_one", [user(), assistant(1)], headerOf("pi_one", "2026-10-18T12:00:00.000Z", { version: 2 }));
    expect(await s.cost("pi_one")).toBeCloseTo(1);
    const text = readFileSync(file, "utf8").replace('"version":2', '"version":3').replace('"total":1}', '"total":7}');
    writeFileSync(file, text);
    utimesSync(file, 1_800_000_000, 1_800_000_000);
    expect(await s.cost("pi_one")).toBeCloseTo(7);
  });

  it("counts a forked session only from its creation, each session by its own header", async () => {
    const s = setup();
    const copied = [stamped("2026-10-18T10:00:00.000Z")(user("parent")), stamped("2026-10-18T10:00:01.000Z")(assistant(5))];
    const own = [stamped("2026-10-18T12:00:01.000Z")(user("side chat")), stamped("2026-10-18T12:00:02.000Z")(assistant(1.5))];
    s.write("pi_fork", [...copied, ...own], headerOf("pi_fork", "2026-10-18T12:00:00.000Z", { parentSession: "/p/parent.jsonl" }));
    s.write("pi_parent", copied, headerOf("pi_parent", "2026-10-18T09:00:00.000Z"));
    expect(await s.cost("pi_fork")).toBeCloseTo(1.5);
    expect(await s.cost("pi_fork", "pi_parent")).toBeCloseTo(6.5);
  });

  it("fills days in the zone asked for and UTC days beside them", async () => {
    const s = setup();
    s.write("pi_one", [stamped("2026-10-19T01:59:00.000Z")(user()), stamped("2026-10-19T02:00:00.000Z")(assistant(1))]);
    const got = await s.sessions.reportOf(["pi_one"], "America/Toronto");
    expect(got?.report.days.map((d) => d.day)).toEqual(["2026-10-18"]);
    expect(got?.report.utcDays.map((d) => d.day)).toEqual(["2026-10-19"]);
  });

  it("serves concurrent reads of a growing file without counting a line twice", async () => {
    const s = setup();
    const file = s.write("pi_one", [user(), assistant(1)]);
    await s.cost("pi_one");
    appendFileSync(file, line(assistant(2)));
    const both = await Promise.all([s.cost("pi_one"), s.cost("pi_one"), s.cost("pi_one")]);
    for (const cost of both) expect(cost).toBeCloseTo(3);
  });

  it("drops a file that disappears", async () => {
    const s = setup();
    const file = s.write("pi_one", [user(), assistant(1)]);
    await s.cost("pi_one");
    rmSync(file);
    expect(await s.sessions.reportOf(["pi_one"], ZONE)).toBeNull();
  });

  it("keeps the newest entries when a log passes the per-file cap", async () => {
    const s = setup({ entriesFileMax: 5 });
    s.write("pi_one", Array.from({ length: 10 }, (_, i) => user(`m${i}`)));
    const got = await s.sessions.reportOf(["pi_one"], ZONE);
    expect(got?.report.turnCount).toBe(5);
    expect(got?.report.turns.at(-1)?.prompt).toBe("m9");
  });

  it("turns a malformed usage field into a finite number", async () => {
    const s = setup();
    const call = assistant(1.25);
    const bad = { ...call, message: { ...call.message, usage: { ...call.message.usage, input: "oops" } } };
    s.write("pi_one", [user(), bad]);
    const got = await s.sessions.reportOf(["pi_one"], ZONE);
    expect(got?.report.tokens.input).toBe(0);
    expect(got?.report.cost.total).toBeCloseTo(1.25);
  });

  it("names the session of a changed path, for .jsonl files only", () => {
    expect(createPiSessions({ dirs: ["/d"] }).sessionIdOf(".jsonl")).toBeNull();
    const s = setup();
    expect(s.sessions.sessionIdOf(join(s.dir, "pi_one.jsonl"))).toBe("pi_one");
    expect(s.sessions.sessionIdOf("pi_two.jsonl")).toBe("pi_two");
    expect(s.sessions.sessionIdOf(join(s.dir, "pi_one.jsonl.tmp"))).toBeNull();
    expect(s.sessions.sessionIdOf(s.dir)).toBeNull();
  });
});

describe("realDir", () => {
  // A machine can link ~/.bb elsewhere, and a file watcher can refuse a root reached through a link.
  function linked() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "burn-real-")));
    dirs.push(base);
    mkdirSync(join(base, "elsewhere", "bb"), { recursive: true });
    symlinkSync(join(base, "elsewhere", "bb"), join(base, ".bb"));
    return base;
  }

  it("resolves a folder reached through a symlinked parent", async () => {
    const base = linked();
    mkdirSync(join(base, "elsewhere", "bb", "pi-bridge-sessions"));
    expect(await realDir(join(base, ".bb", "pi-bridge-sessions"))).toBe(join(base, "elsewhere", "bb", "pi-bridge-sessions"));
  });

  it("resolves the parent of a folder that does not exist yet", async () => {
    const base = linked();
    expect(await realDir(join(base, ".bb", "pi-bridge-sessions"))).toBe(join(base, "elsewhere", "bb", "pi-bridge-sessions"));
    expect(await realDir(join(base, "none", "deeper"))).toBe(join(base, "none", "deeper"));
  });
});

describe("host entry", () => {
  const THREAD = "thr_aaaaaaaa";

  function harness(opts: { failWatch?: number; neverReady?: boolean; watchWaitMs?: number } = {}) {
    const s = setup();
    const watches: { options: ExperimentalHostWatchOptions; listener: ExperimentalHostWatchListener; disposed: boolean }[] = [];
    let failures = opts.failWatch ?? 0;
    const entry = createHostEntry({ piDirs: () => [s.dir], ...(opts.watchWaitMs === undefined ? {} : { watchWaitMs: opts.watchWaitMs }) });
    const h = experimental_createHostEntryHarness(entry, {
      experimental_watch: (options, listener) => {
        if (failures > 0) {
          failures--;
          throw new Error("ENOENT: no such directory");
        }
        const watch = { options, listener, disposed: false };
        watches.push(watch);
        // bb answers a watch only once its root is watched, which can be never.
        if (opts.neverReady) return new Promise(() => undefined);
        return { dispose: async () => void (watch.disposed = true) };
      },
    });
    const reports = (sessionIds: string[] = ["pi_one"]) =>
      h.experimental_call("reports", { harness: "pi", timeZone: "UTC", threads: [{ threadId: THREAD, sessionIds }] });
    const change = (...names: string[]) =>
      watches.at(-1)!.listener({ kind: "changed", changes: names.map((name) => ({ path: join(s.dir, name), type: "update" as const })) });
    return { ...s, h, watches, reports, change, signals: () => h.experimental_getSignals() };
  }

  it("answers reports per thread and starts one watch on the session folder", async () => {
    const t = harness();
    t.write("pi_one", [user(), assistant(2.5)]);
    const got = await t.reports();
    expect(got.dir).toBe(t.dir);
    expect(got.reports).toHaveLength(1);
    expect(got.reports[0]).toMatchObject({ threadId: THREAD, at: expect.any(Number) });
    expect(got.reports[0]?.report?.cost.total).toBeCloseTo(2.5);
    expect((await t.reports(["pi_none"])).reports).toEqual([{ threadId: THREAD, report: null, at: null, searched: [t.dir] }]);
    expect(t.watches.map((w) => w.options)).toEqual([{ rootPath: realpathSync(t.dir), ignoredPaths: [], debounceMs: 150, maxWaitMs: 1000 }]);
    await t.h.experimental_dispose();
  });

  it("signals the sessions whose logs changed, and every session when the watcher lost track", async () => {
    const t = harness();
    await t.reports();
    await t.change("pi_one.jsonl", "pi_two.jsonl", "pi_one.jsonl", "notes.txt");
    await t.change("notes.txt");
    await t.watches[0]!.listener({ kind: "rescan-required" });
    await t.change(...Array.from({ length: CHANGED_MAX + 1 }, (_, i) => `pi_${i}.jsonl`));
    expect(t.signals()).toEqual([
      { signal: "changed", payload: { sessionIds: ["pi_one", "pi_two"], all: false } },
      { signal: "changed", payload: { sessionIds: [], all: true } },
      { signal: "changed", payload: { sessionIds: [], all: true } },
    ]);
    await t.h.experimental_dispose();
  });

  it("answers even when the watch cannot start, and tries again on the next call", async () => {
    const t = harness({ failWatch: 1 });
    t.write("pi_one", [user(), assistant(1)]);
    expect((await t.reports()).reports[0]?.report?.cost.total).toBeCloseTo(1);
    expect(t.watches).toHaveLength(0);
    await t.reports();
    expect(t.watches).toHaveLength(1);
    await t.h.experimental_dispose();
  });

  it("starts the watch again after a call cancelled before its watch was ready", async () => {
    const t = harness();
    const input = { harness: "pi" as const, timeZone: "UTC", threads: [{ threadId: THREAD, sessionIds: ["pi_one"] }] };
    await expect(t.h.experimental_call("reports", input, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(t.watches[0]?.disposed).toBe(true);
    await t.reports();
    await t.reports();
    expect(t.watches).toHaveLength(2);
    await t.h.experimental_dispose();
  });

  it("replaces a watch that reported an error on the next call", async () => {
    const t = harness();
    await t.reports();
    await t.watches[0]!.listener({ kind: "watch-error", message: "watcher died" });
    expect(t.watches[0]!.disposed).toBe(true);
    await t.reports();
    expect(t.watches).toHaveLength(2);
    expect(t.signals()).toEqual([]);
    await t.h.experimental_dispose();
  });

  it("answers at once when bb never gets the watch ready, and starts no second watch", async () => {
    const t = harness({ neverReady: true, watchWaitMs: 20 });
    t.write("pi_one", [user(), assistant(1.5)]);
    expect((await t.reports()).reports[0]?.report?.cost.total).toBeCloseTo(1.5);
    await t.watches[0]!.listener({ kind: "watch-error", message: "Watched path does not exist yet" });
    t.write("pi_one", [user(), assistant(1.5), user(), assistant(2)]);
    expect((await t.reports()).reports[0]?.report?.cost.total).toBeCloseTo(3.5);
    // bb keeps retrying a watch that is not ready yet, so another would only pile up beside it.
    expect(t.watches).toHaveLength(1);
    await t.h.experimental_dispose();
  });

  it("reads the bridge folder beside the host data bb gives it, the older folder too, and watches both", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "burn-entry-")));
    dirs.push(base);
    const hostDataDir = join(base, "bb", "plugins", "burn", "host-data");
    const bridge = join(base, "bb", "plugins", "provider-pi", "bridge-data", "sessions");
    const legacy = join(base, "home", ".bb", "pi-bridge-sessions");
    for (const dir of [hostDataDir, bridge, legacy]) mkdirSync(dir, { recursive: true });
    writeFileSync(sessionFile(bridge, "pi_new"), [headerOf("pi_new"), user(), assistant(2)].map(line).join(""));
    writeFileSync(sessionFile(legacy, "pi_old"), [headerOf("pi_old"), user(), assistant(0.5)].map(line).join(""));
    const listeners = new Map<string, ExperimentalHostWatchListener>();
    const entry = createHostEntry({ piDirs: (dataDir) => piSessionDirs({ hostDataDir: dataDir, home: join(base, "home"), env: {} }) });
    const h = experimental_createHostEntryHarness(entry, {
      experimental_paths: { dataDir: hostDataDir, tempDir: join(base, "tmp") },
      experimental_watch: (options, listener) => {
        listeners.set(options.rootPath, listener);
        return { dispose: async () => undefined };
      },
    });
    const got = await h.experimental_call("reports", {
      harness: "pi",
      timeZone: "UTC",
      threads: [
        { threadId: "thr_aaaaaaaa", sessionIds: ["pi_new"] },
        { threadId: "thr_bbbbbbbb", sessionIds: ["pi_old"] },
      ],
    });
    expect(got.reports.map((r) => r.report?.cost.total)).toEqual([2, 0.5]);
    expect([...listeners.keys()].sort()).toEqual([bridge, legacy].sort());
    await listeners.get(legacy)!({ kind: "changed", changes: [{ path: sessionFile(legacy, "pi_old"), type: "update" }] });
    await listeners.get(bridge)!({ kind: "changed", changes: [{ path: sessionFile(bridge, "pi_new"), type: "update" }] });
    expect(h.experimental_getSignals().map((s) => s.payload.sessionIds)).toEqual([["pi_old"], ["pi_new"]]);
    await h.experimental_dispose();
  });

  it("costs only its own thread when a folder cannot be read and no other folder holds the thread's log", async () => {
    const base = mkdtempSync(join(tmpdir(), "burn-entry-"));
    dirs.push(base);
    const [open_, shut] = [join(base, "open"), join(base, "shut")];
    for (const dir of [open_, shut]) mkdirSync(dir);
    writeFileSync(sessionFile(open_, "pi_one"), [headerOf("pi_one"), user(), assistant(3)].map(line).join(""));
    const entry = createHostEntry({ piDirs: () => [open_, shut] });
    const h = experimental_createHostEntryHarness(entry, { experimental_watch: () => ({ dispose: async () => undefined }) });
    chmodSync(shut, 0);
    try {
      const got = await h.experimental_call("reports", {
        harness: "pi",
        timeZone: "UTC",
        threads: [
          { threadId: "thr_aaaaaaaa", sessionIds: ["pi_one"] },
          { threadId: "thr_bbbbbbbb", sessionIds: ["pi_two"] },
        ],
      });
      expect(got.reports[0]?.report?.cost.total).toBeCloseTo(3);
      expect(got.reports[1]).toMatchObject({ threadId: "thr_bbbbbbbb", report: null, at: null, error: expect.stringMatching(/EACCES|EPERM/) });
    } finally {
      chmodSync(shut, 0o700);
    }
    await h.experimental_dispose();
  });

  it("rereads everything once a watch on a folder that did not exist yet is ready", async () => {
    const base = mkdtempSync(join(tmpdir(), "burn-entry-"));
    dirs.push(base);
    const here = join(base, "here");
    mkdirSync(here);
    let ready: (() => void) | null = null;
    const entry = createHostEntry({ piDirs: () => [join(base, "later"), here] });
    const h = experimental_createHostEntryHarness(entry, {
      experimental_watch: (options) => {
        const subscription = { dispose: async () => undefined };
        if (!options.rootPath.endsWith("/later")) return subscription;
        return new Promise((resolve) => (ready = () => resolve(subscription)));
      },
    });
    await h.experimental_call("reports", { harness: "pi", timeZone: "UTC", threads: [{ threadId: THREAD, sessionIds: ["pi_one"] }] });
    expect(h.experimental_getSignals()).toEqual([]);
    ready!();
    await expect.poll(() => h.experimental_getSignals()).toEqual([{ signal: "changed", payload: { sessionIds: [], all: true } }]);
    await h.experimental_dispose();
  });

  it("reads the folder a thread's pi named without watching it, and says where it looked when no folder holds the log", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "burn-entry-")));
    dirs.push(base);
    const [usual, custom, linked] = [join(base, "usual"), join(base, "custom"), join(base, "linked")];
    for (const dir of [usual, custom, linked]) mkdirSync(dir);
    writeFileSync(sessionFile(custom, "pi_one"), [headerOf("pi_one"), user(), assistant(4)].map(line).join(""));
    writeFileSync(sessionFile(custom, "pi_four"), [headerOf("pi_four"), user(), assistant(5)].map(line).join(""));
    symlinkSync(sessionFile(custom, "pi_four"), sessionFile(linked, "pi_four"));
    const roots: string[] = [];
    const entry = createHostEntry({ piDirs: () => [usual] });
    const h = experimental_createHostEntryHarness(entry, {
      experimental_watch: (options) => {
        roots.push(options.rootPath);
        return { dispose: async () => undefined };
      },
    });
    const got = await h.experimental_call("reports", {
      harness: "pi",
      timeZone: "UTC",
      threads: [
        { threadId: "thr_aaaaaaaa", sessionIds: ["pi_one"], sessionFile: sessionFile(custom, "pi_one") },
        { threadId: "thr_bbbbbbbb", sessionIds: ["pi_two"], sessionFile: sessionFile(custom, "pi_one") },
        { threadId: "thr_cccccccc", sessionIds: ["pi_three"], sessionFile: sessionFile(custom, "pi_three") },
        { threadId: "thr_dddddddd", sessionIds: ["pi_four"], sessionFile: sessionFile(linked, "pi_four") },
      ],
    });
    expect(got.reports[0]).toMatchObject({ unwatched: true });
    expect(got.reports[0]?.report?.cost.total).toBeCloseTo(4);
    // Another thread's file name is no hint at all. A file that is not there yet, or a link, is not read, but the
    // thread's log is still outside what the host watches, so each report from its pi reads it again.
    expect(got.reports[1]).toEqual({ threadId: "thr_bbbbbbbb", report: null, at: null, searched: [usual] });
    expect(got.reports[2]).toEqual({ threadId: "thr_cccccccc", report: null, at: null, searched: [custom, usual], unwatched: true });
    expect(got.reports[3]).toEqual({ threadId: "thr_dddddddd", report: null, at: null, searched: [linked, usual], unwatched: true });
    expect(roots).toEqual([usual]);
    await h.experimental_dispose();
  });

  it("waits only for the watches on folders that exist", async () => {
    const base = mkdtempSync(join(tmpdir(), "burn-entry-"));
    dirs.push(base);
    const here = join(base, "here");
    mkdirSync(here);
    const entry = createHostEntry({ piDirs: () => [join(base, "missing"), here], watchWaitMs: 5000 });
    const roots: string[] = [];
    const h = experimental_createHostEntryHarness(entry, {
      experimental_watch: (options) => {
        roots.push(options.rootPath);
        // bb answers a watch on a missing folder only once the folder appears.
        if (options.rootPath.endsWith("/missing")) return new Promise(() => undefined);
        return { dispose: async () => undefined };
      },
    });
    const began = Date.now();
    await h.experimental_call("reports", { harness: "pi", timeZone: "UTC", threads: [{ threadId: THREAD, sessionIds: ["pi_one"] }] });
    expect(Date.now() - began).toBeLessThan(1000);
    expect(roots).toHaveLength(2);
    await h.experimental_dispose();
  });

  it("replaces only the watch that reported an error", async () => {
    const base = mkdtempSync(join(tmpdir(), "burn-entry-"));
    dirs.push(base);
    const watches: { rootPath: string; listener: ExperimentalHostWatchListener; disposed: boolean }[] = [];
    for (const name of ["a", "b"]) mkdirSync(join(base, name));
    const entry = createHostEntry({ piDirs: () => [join(base, "a"), join(base, "b")] });
    const h = experimental_createHostEntryHarness(entry, {
      experimental_watch: (options, listener) => {
        const watch = { rootPath: options.rootPath, listener, disposed: false };
        watches.push(watch);
        return { dispose: async () => void (watch.disposed = true) };
      },
    });
    const reports = () => h.experimental_call("reports", { harness: "pi", timeZone: "UTC", threads: [{ threadId: THREAD, sessionIds: ["pi_one"] }] });
    const on = (name: string) => watches.filter((w) => w.rootPath.endsWith(`/${name}`));
    await reports();
    await on("b")[0]!.listener({ kind: "watch-error", message: "watcher died" });
    expect([on("a")[0]!.disposed, on("b")[0]!.disposed]).toEqual([false, true]);
    await reports();
    expect([on("a").length, on("b").length]).toEqual([1, 2]);
    await h.experimental_dispose();
  });

  it("exports the entry for this machine's pi session folder", () => {
    expect(Object.keys(hostEntry.handlers)).toEqual(["reports"]);
    expect(Object.keys(hostEntry.experimental_signals ?? {})).toEqual(["changed"]);
  });
});
