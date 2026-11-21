import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiSessions } from "../../extensions/bb/host/pi-sessions.js";
import { createHostEntry } from "../../extensions/bb/host/entry.js";
import { createReportSource } from "../../extensions/bb/sources.js";
import { costEvent, identityEvent, listEvents, requestEvent } from "./fixtures.js";
import { assistant, usage, user } from "../helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const A = "01a1d655-af5e-776d-921a-f1c8a816886d";
const B = "01a1d655-af5e-776d-921a-f1c8a816886e";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const line = (value: unknown) => JSON.stringify(value) + "\n";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "burn-omp-"));
  dirs.push(dir);
  const sessions = createPiSessions({ dir, layout: "omp" });
  const write = (id: string, entries: unknown[], project = "project", header: Record<string, unknown> = {}) => {
    mkdirSync(join(dir, project), { recursive: true });
    const path = join(dir, project, `2026-10-18T12-00-00-000Z_${id}.jsonl`);
    writeFileSync(path, line({ type: "session", version: 3, id, timestamp: "2026-10-18T12:00:00.000Z", ...header }) + entries.map(line).join(""));
    return path;
  };
  const report = (...ids: string[]) => sessions.reportOf(ids, "UTC");
  return { dir, sessions, write, report };
}

describe("OMP session accounting", () => {
  it("recovers model calls, tokens, recorded costs, timing and tool counts from an exact session", async () => {
    const s = setup();
    const call = assistant(0.25, "model-a", { input: 200, output: 50, cacheRead: 800 }, "provider", ["read", "read", "bash"], { duration: 1500 });
    s.write(A, [user("inspect"), { ...call, message: { ...call.message, usage: { ...call.message.usage, reasoningTokens: 20 } } }]);
    s.write(B, [user("unrelated"), assistant(99)]);
    const got = (await s.report(A, A, "thr_aaaaaaaa"))?.report;
    expect(got).toMatchObject({ calls: 1, turnCount: 1, tokens: { input: 200, output: 50, cacheRead: 800, cacheWrite: 0, reasoning: 20 }, cost: { total: 0.25 } });
    expect(got?.byModel).toMatchObject([{ key: "provider/model-a", calls: 1, timed: 1, ms: 1500, timedOutput: 50 }]);
    expect(got?.turns[0]?.tools).toEqual([{ name: "read", count: 2 }, { name: "bash", count: 1 }]);
    expect(got?.coverage).not.toBe("partial");
  });

  it("keeps OMP side-call and blocking-task spend when replacing a larger BB event total", async () => {
    const s = setup();
    const first = assistant(1);
    const timestamp = first.timestamp;
    s.write(A, [
      user("delegate"),
      first,
      { type: "model_usage", timestamp, provider: "p", model: "side", usage: usage(0.05, { input: 5, output: 2 }) },
      { type: "message", timestamp, message: { role: "toolResult", toolName: "task", details: { usage: usage(2, { input: 200, output: 100 }) } } },
    ]);
    const thread = makeThreadResponse({ id: "thr_aaaaaaaa", providerId: "acp-omp", environmentId: "env_1" });
    const rows = [identityEvent(thread.id, A), requestEvent(thread.id, "delegate", "p/m1"), costEvent(thread.id, 3.05, "USD", A)];
    const host = experimental_createHostEntryHarness(createHostEntry({ piDirs: () => [join(s.dir, "pi")], ompDir: s.dir }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "burn",
      sdk: {
        threads: { get: async () => thread, events: { list: listEvents(() => rows) } },
        environments: { get: async () => ({ id: "env_1", hostId: "host_1" }) },
        hosts: { list: async () => [{ id: "host_1", status: "connected" }] },
      },
      experimental_callHostRpc: ({ method, input }) => host.experimental_call(method as "reports", input as never),
    });
    const source = createReportSource(bb, { onChange: () => {} });
    try {
      const got = (await source.reportsOf([thread.id])).get(thread.id);
      expect(got?.source).toBe("log");
      expect(got?.report.cost.total).toBeCloseTo(3.05);
      expect(got?.report.lastTurnCost).toBeCloseTo(3.05);
      expect(got?.report.turns[0]?.cost).toBeCloseTo(3.05);
      expect(got?.report.tokens).toMatchObject({ input: 305, output: 152 });
      expect(got?.report.calls).toBe(1);
      expect(got?.report.byModel.find((row) => row.key === "p/side")?.cost).toBeCloseTo(0.05);
      expect(got?.report.coverage).not.toBe("partial");
    } finally {
      source.dispose();
      await host.experimental_dispose();
      await harness.lifecycle.dispose();
    }
  });

  it("refreshes a known session without directory listing permission and rediscovers a moved log", async () => {
    const s = setup();
    const path = s.write(A, [assistant(1)]);
    expect((await s.report(A))?.report.cost.total).toBe(1);
    chmodSync(s.dir, 0o100);
    try {
      appendFileSync(path, line(assistant(2)));
      expect((await s.report(A))?.report.cost.total).toBe(3);
    } finally {
      chmodSync(s.dir, 0o700);
    }
    mkdirSync(join(s.dir, "moved"));
    renameSync(path, join(s.dir, "moved", `moved_${A}.jsonl`));
    expect((await s.report(A))?.report.cost.total).toBe(3);
  });

  it("isolates an unreadable OMP bucket from available sessions and other harnesses", async () => {
    const s = setup();
    s.write(A, [assistant(1)], "available");
    s.write(B, [assistant(2)], "unreadable");
    const blocked = join(s.dir, "unreadable");
    const pi = join(s.dir, "pi");
    mkdirSync(pi);
    writeFileSync(join(pi, "pi_one.jsonl"), line({ type: "session", id: "pi_one" }) + line(assistant(4)));
    const host = experimental_createHostEntryHarness(createHostEntry({ piDirs: () => [pi], ompDir: s.dir, watchWaitMs: 0 }));
    chmodSync(blocked, 0);
    try {
      const got = await host.experimental_call("reports", { harness: "omp", timeZone: "UTC", threads: [{ threadId: "thr_aaaaaaaa", sessionIds: [A, B] }] });
      expect(got.reports[0]?.report).toMatchObject({ cost: { total: 1 }, coverage: "partial" });
      const other = await host.experimental_call("reports", { harness: "pi", timeZone: "UTC", threads: [{ threadId: "thr_bbbbbbbb", sessionIds: ["pi_one"] }] });
      expect(other.reports[0]?.report?.cost.total).toBe(4);
    } finally {
      chmodSync(blocked, 0o700);
      await host.experimental_dispose();
    }
  });

  it("marks a stale fallback partial when its known complete original becomes unreadable", async () => {
    const s = setup();
    s.write(A, [assistant(1)], "a-copy");
    s.write(A, [assistant(1), assistant(2)], "z-original");
    expect((await s.report(A))?.report.cost.total).toBe(3);
    const original = join(s.dir, "z-original");
    chmodSync(original, 0);
    try {
      const got = (await s.report(A))?.report;
      expect(got?.cost.total).toBe(1);
      expect(got?.coverage).toBe("partial");
    } finally {
      chmodSync(original, 0o700);
    }
    expect((await s.report(A))?.report.cost.total).toBe(3);
  });

  it("marks cold discovery partial and retries after an unreadable bucket becomes available", async () => {
    const s = setup();
    s.write(A, [assistant(1)], "a-copy");
    s.write(A, [assistant(1), assistant(2)], "z-original");
    const original = join(s.dir, "z-original");
    chmodSync(original, 0);
    try {
      expect((await s.report(A))?.report).toMatchObject({ cost: { total: 1 }, coverage: "partial" });
    } finally {
      chmodSync(original, 0o700);
    }
    const recovered = (await s.report(A))?.report;
    expect(recovered?.cost.total).toBe(3);
    expect(recovered?.coverage).not.toBe("partial");
  });

  it("does not expose a stale candidate while another bucket is still being discovered", async () => {
    const s = setup();
    s.write(A, [assistant(1)], "a-copy");
    s.write(A, [assistant(1), assistant(2)], "z-original");
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    const { readdir } = await vi.importActual<typeof fs>("node:fs/promises");
    let gated = false;
    const spy = vi.mocked(fs.readdir).mockImplementation(async (...args) => {
      if (args[0] === join(s.dir, "z-original") && !gated) {
        gated = true;
        enter();
        await release;
      }
      const entries = await readdir(...args);
      return args[0] === s.dir ? entries.sort((a, b) => a.name.toString().localeCompare(b.name.toString())) : entries;
    });
    const first = s.report(A);
    try {
      await entered;
      expect((await s.report(A))?.report.cost.total).toBe(3);
    } finally {
      resume();
      await first;
      spy.mockRestore();
    }
    expect((await first)?.report.cost.total).toBe(3);
  });

  it("refreshes the active original when a stale copy sorts first, without counting incomplete lines or copies twice", async () => {
    const s = setup();
    const path = s.write(A, [user("inspect"), assistant(1)]);
    s.write(A, [user("inspect"), assistant(1)], "a-stale-copy");
    expect((await s.report(A))?.report.cost.total).toBe(1);
    const next = line(assistant(2));
    appendFileSync(path, next.slice(0, -1));
    expect((await s.report(A))?.report.cost.total).toBe(1);
    appendFileSync(path, "\n");
    expect((await s.report(A))?.report).toMatchObject({ calls: 2, tokens: { input: 200, output: 100 }, cost: { total: 3 } });
  });

  it("discovers a fuller copy created after a warm read without rescanning on every read or counting copies twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.now();
      const s = setup();
      const first = assistant(1);
      s.write(A, [first]);
      expect((await s.report(A))?.report.cost.total).toBe(1);
      s.write(A, [first, assistant(2)], "new-bucket");
      const initialScans = vi.mocked(fs.readdir).mock.calls.length;
      for (const elapsed of [20_000, 40_000, 59_999]) {
        vi.setSystemTime(now + elapsed);
        await s.report(A);
      }
      expect(vi.mocked(fs.readdir).mock.calls.length).toBe(initialScans);
      vi.setSystemTime(now + 60_000);
      const updated = (await s.report(A))?.report;
      expect(updated).toMatchObject({ calls: 2, cost: { total: 3 }, tokens: { input: 200, output: 100 } });
      expect(updated?.coverage).not.toBe("partial");
      const refreshedScans = vi.mocked(fs.readdir).mock.calls.length;
      expect((await s.report(A))?.report.cost.total).toBe(3);
      expect(vi.mocked(fs.readdir).mock.calls.length).toBe(refreshedScans);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers more complete history over a newer copy's mtime even when retained entries are capped", async () => {
    const s = setup();
    const path = s.write(A, [assistant(1), assistant(2)]);
    const copy = s.write(A, [assistant(1), assistant(2)], "a-stale-copy");
    const copiedAt = new Date("2030-01-01T00:00:00.000Z");
    utimesSync(copy, copiedAt, copiedAt);
    const sessions = createPiSessions({ dir: s.dir, layout: "omp", limits: { entriesFileMax: 2 } });
    expect((await sessions.reportOf([A], "UTC"))?.report.cost.total).toBe(3);
    appendFileSync(path, line(assistant(4)));
    const activeAt = new Date("2026-10-18T12:01:00.000Z");
    utimesSync(path, activeAt, activeAt);
    expect((await sessions.reportOf([A], "UTC"))?.report).toMatchObject({ calls: 2, tokens: { input: 200, output: 100 }, cost: { total: 6 } });
  });

  it("rejects mismatched headers and symlinked project directories", async () => {
    const s = setup();
    s.write(A, [assistant(50)], "wrong-header", { id: B });
    const outside = setup();
    outside.write(A, [assistant(100)]);
    symlinkSync(join(outside.dir, "project"), join(s.dir, "linked-project"));
    expect(await s.report(A, "../outside", "thr_aaaaaaaa")).toBeNull();
  });

  it("marks missing session history partial and discovers sessions created after an empty read", async () => {
    const s = setup();
    expect(await s.report(A)).toBeNull();
    s.write(A, [user("first"), assistant(1)]);
    const got = (await s.report(A, B))?.report;
    expect(got).toMatchObject({ calls: 1, cost: { total: 1 }, coverage: "partial" });
    s.write(B, [user("second"), assistant(2)]);
    const complete = (await s.report(A, B))?.report;
    expect(complete).toMatchObject({ calls: 2, cost: { total: 3 } });
    expect(complete?.coverage).not.toBe("partial");
  });

  it("excludes copied history in a fork", async () => {
    const s = setup();
    s.write(A, [
      { ...assistant(20), timestamp: "2026-10-18T11:00:00.000Z" },
      { ...user("fork"), timestamp: "2026-10-18T12:01:00.000Z" },
      { ...assistant(2), timestamp: "2026-10-18T12:02:00.000Z" },
    ], "project", { parentSession: "/original/session.jsonl" });
    expect((await s.report(A))?.report).toMatchObject({ calls: 1, cost: { total: 2 } });
  });

  it("reads a session header after OMP's prepended title metadata", async () => {
    const s = setup();
    const path = s.write(A, [user("inspect"), assistant(2)]);
    writeFileSync(path, line({ type: "title", title: "Saved session" }) + readFileSync(path, "utf8"));
    expect((await s.report(A))?.report).toMatchObject({ calls: 1, cost: { total: 2 } });
  });

  it("keeps reporting OMP spend as a partial log grows past the saved report", async () => {
    const s = setup();
    const path = s.write(A, [user("inspect"), assistant(1)]);
    s.write(A, [assistant(1)], "stale-copy");
    const missing = s.write(B, [assistant(2)]);
    const thread = makeThreadResponse({ id: "thr_aaaaaaaa", providerId: "acp-omp", environmentId: "env_1", status: "active" });
    const rows = [identityEvent(thread.id, A), identityEvent(thread.id, B)];
    const host = experimental_createHostEntryHarness(createHostEntry({ piDirs: () => [join(s.dir, "pi")], ompDir: s.dir }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "burn",
      sdk: {
        threads: { get: async () => thread, events: { list: listEvents(() => rows) } },
        environments: { get: async () => ({ id: "env_1", hostId: "host_1" }) },
        hosts: { list: async () => [{ id: "host_1", status: "connected" }] },
      },
      experimental_callHostRpc: ({ method, input }) => host.experimental_call(method as "reports", input as never),
    });
    const source = createReportSource(bb, { onChange: () => {} });
    const report = async () => (await source.reportsOf([thread.id])).get(thread.id)?.report;
    const changed = (sequence: number) => harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence });
    const append = (cost: number) => {
      appendFileSync(path, line(assistant(cost)));
      const at = new Date(Date.UTC(2026, 9, 18, 12, 0, cost));
      utimesSync(path, at, at);
    };
    try {
      const complete = await report();
      expect(complete?.cost.total).toBe(3);
      expect(complete?.coverage).not.toBe("partial");

      rmSync(missing);
      await changed(10);
      expect(await report()).toMatchObject({ cost: { total: 3 }, coverage: "partial", coverageNote: expect.stringContaining("last saved") });

      append(2);
      await changed(11);
      expect(await report()).toMatchObject({ cost: { total: 3 }, coverage: "partial", coverageNote: expect.stringContaining("some recorded sessions") });

      append(4);
      await changed(12);
      expect(await report()).toMatchObject({ calls: 3, cost: { total: 7 }, coverage: "partial" });

      append(8);
      await changed(13);
      expect(await report()).toMatchObject({ calls: 4, cost: { total: 15 }, coverage: "partial" });

      rmSync(path);
      await changed(14);
      expect(await report()).toMatchObject({ cost: { total: 15 }, coverage: "partial", coverageNote: expect.stringContaining("last saved") });
    } finally {
      source.dispose();
      await host.experimental_dispose();
      await harness.lifecycle.dispose();
    }
  });

  it("replaces BB cost-only events with session metrics and refreshes during an active turn", async () => {
    const s = setup();
    const path = s.write(A, [user("inspect"), assistant(1), assistant(2)]);
    const thread = makeThreadResponse({ id: "thr_aaaaaaaa", providerId: "acp-omp", environmentId: "env_1", status: "active" });
    const rows = [identityEvent(thread.id, A), requestEvent(thread.id, "inspect", "p/m1"), costEvent(thread.id, 3, "USD", A)];
    const host = experimental_createHostEntryHarness(createHostEntry({ piDirs: () => [join(s.dir, "pi")], ompDir: s.dir }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "burn",
      sdk: {
        threads: { get: async () => thread, events: { list: listEvents(() => rows) } },
        environments: { get: async () => ({ id: "env_1", hostId: "host_1" }) },
        hosts: { list: async () => [{ id: "host_1", status: "connected" }] },
      },
      experimental_callHostRpc: ({ method, input }) => host.experimental_call(method as "reports", input as never),
    });
    const source = createReportSource(bb, { onChange: () => {} });
    try {
      const got = (await source.reportsOf([thread.id])).get(thread.id);
      expect(got).toMatchObject({ source: "log", report: { calls: 2, tokens: { input: 200, output: 100 }, cost: { total: 3 } } });
      appendFileSync(path, line(assistant(4)));
      await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 10 });
      expect((await source.reportsOf([thread.id])).get(thread.id)?.report).toMatchObject({ calls: 3, cost: { total: 7 } });
      rmSync(path);
      await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 11 });
      expect((await source.reportsOf([thread.id])).get(thread.id)?.report.cost.total).toBe(7);
    } finally {
      source.dispose();
      await host.experimental_dispose();
      await harness.lifecycle.dispose();
    }
  });
});
