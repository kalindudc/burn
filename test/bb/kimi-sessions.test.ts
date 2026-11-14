import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createHostEntry } from "../../extensions/bb/host/entry.js";
import { createKimiSessions } from "../../extensions/bb/host/kimi-sessions.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const line = (v: unknown) => JSON.stringify(v) + "\n";
const t = Date.parse("2026-11-14T12:00:00Z");
const use = (time = t, model = "ollama-cloud/kimi-k3.1-pro") => ({
  type: "usage.record", usageScope: "turn", time, model,
  usage: { inputOther: 100, inputCacheRead: 200, inputCacheCreation: 0, output: 10 },
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "burn-kimi-")); dirs.push(dir);
  const agent = (session: string, name: string) => {
    const d = join(dir, "workspace", session, "agents", name);
    mkdirSync(d, { recursive: true });
    return join(d, "wire.jsonl");
  };
  return { dir, agent, reader: createKimiSessions({ dir }) };
}

it("counts only usage records from the requested session and its native agents once", async () => {
  const s = setup(), main = s.agent("session_a", "main"), child = s.agent("session_a", "agent-0");
  writeFileSync(main, line({ type: "turn.prompt", time: t - 10, origin: { kind: "user" }, input: [{ type: "text", text: "Hello" }] }) +
    line(use()) + line({ type: "context.append_loop_event", time: t, event: { usage: use().usage } }));
  writeFileSync(child, line(use(t + 1)));
  writeFileSync(s.agent("session_neighbour", "main"), line(use()));
  const got = await s.reader.reportOf(["session_a", "session_a", "thr_bb"], "UTC");
  expect(got?.report.calls).toBe(2);
  expect(got?.report.tokens).toMatchObject({ input: 200, cacheRead: 400, output: 20 });
  expect(got?.report.cost.total).toBeCloseTo(2 * (100 * 2 + 200 * 0.2 + 10 * 10) / 1e6);
  expect(got?.report.estimated).toBe(true);
  expect(got?.report.turnCount).toBe(1);
  expect(got?.report.agents?.rows).toHaveLength(1);
  expect(got?.report.agents?.rows[0]?.calls).toBe(1);
  expect(await s.reader.reportOf(["../session_a"], "UTC")).toBeNull();
});

it("reads appended complete records, detects rewrites and applies changed prices", async () => {
  const s = setup(), main = s.agent("session_a", "main");
  writeFileSync(main, line(use()));
  expect((await s.reader.reportOf(["session_a"], "UTC"))?.report.calls).toBe(1);
  const next = line(use(t + 1));
  appendFileSync(main, next.slice(0, -1));
  expect((await s.reader.reportOf(["session_a"], "UTC"))?.report.calls).toBe(1);
  appendFileSync(main, "\n");
  expect((await s.reader.reportOf(["session_a"], "UTC"))?.report.calls).toBe(2);
  const prices = { "ollama-cloud/kimi-k3.1-pro": { input: 4, output: 0, cacheRead: 0, cacheWrite: 0 } };
  expect((await s.reader.reportOf(["session_a"], "UTC", { prices }))?.report.cost.total).toBeCloseTo(800 / 1e6);
  writeFileSync(main, line(use(t + 2, "ollama-cloud/kimi-k3")));
  expect((await s.reader.reportOf(["session_a"], "UTC"))?.report.calls).toBe(1);
});

it("preserves tokens and marks unknown pricing, missing sessions, and fork history as partial", async () => {
  const s = setup(), main = s.agent("session_a", "main");
  writeFileSync(main, line(use(t, "other-provider/unknown")) + line(use(t + 1)));
  const got = await s.reader.reportOf(["session_a", "session_missing"], "UTC");
  expect(got?.report.tokens.input).toBe(200);
  expect(got?.report.coverage).toBe("partial");
  expect(got?.report.coverageNote).toContain("no known price");
  const fork = await s.reader.reportOf(["session_a"], "UTC", { since: t + 1 });
  expect(fork?.report.calls).toBe(1);
  expect(fork?.report.coverage).toBe("partial");
});

it("does not guess a price for cache writes and honours an explicit override", async () => {
  const s = setup(), main = s.agent("session_a", "main"), row = use();
  row.usage.inputCacheCreation = 50;
  writeFileSync(main, line(row));
  expect((await s.reader.reportOf(["session_a"], "UTC"))?.report.coverage).toBe("partial");
  const prices = { [row.model]: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 } };
  const got = await s.reader.reportOf(["session_a"], "UTC", { prices });
  expect(got?.report.coverage).toBe("available");
  expect(got?.report.cost.cacheWrite).toBeCloseTo(100 / 1e6);
});

it("returns Kimi reports through the host RPC contract", async () => {
  const s = setup(), main = s.agent("session_a", "main");
  writeFileSync(main, line(use()));
  const host = experimental_createHostEntryHarness(createHostEntry({ dir: s.dir, kimiDir: s.dir }));
  const result = await host.experimental_call("reports", {
    harness: "kimi", timeZone: "UTC", threads: [{ threadId: "thr_00000001", sessionIds: ["session_a"] }],
  });
  expect(result.reports[0]?.report?.calls).toBe(1);
  expect(result.reports[0]?.report?.cost.total).toBeCloseTo(0.00034);
  await host.experimental_dispose();
});
