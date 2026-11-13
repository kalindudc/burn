import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSessions } from "../../extensions/bb/host/pi-sessions.js";
import { createHostEntry } from "../../extensions/bb/host/entry.js";
import { createReportSource } from "../../extensions/bb/sources.js";
import { costEvent, identityEvent, listEvents, requestEvent } from "./fixtures.js";
import { assistant, user } from "../helpers.js";

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

  it("does not count incomplete lines or duplicate session copies twice", async () => {
    const s = setup();
    const path = s.write(A, [user("inspect"), assistant(1)]);
    s.write(A, [user("inspect"), assistant(1)], "project-copy");
    expect((await s.report(A))?.report.cost.total).toBe(1);
    const next = line(assistant(2));
    appendFileSync(path, next.slice(0, -1));
    expect((await s.report(A))?.report.cost.total).toBe(1);
    appendFileSync(path, "\n");
    expect((await s.report(A))?.report).toMatchObject({ calls: 2, cost: { total: 3 } });
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

  it("replaces BB cost-only events with session metrics and refreshes during an active turn", async () => {
    const s = setup();
    const path = s.write(A, [user("inspect"), assistant(1), assistant(2)]);
    const thread = makeThreadResponse({ id: "thr_aaaaaaaa", providerId: "acp-omp", environmentId: "env_1", status: "active" });
    const rows = [identityEvent(thread.id, A), requestEvent(thread.id, "inspect", "p/m1"), costEvent(thread.id, 3, "USD", A)];
    const host = experimental_createHostEntryHarness(createHostEntry({ dir: join(s.dir, "pi"), ompDir: s.dir }));
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
