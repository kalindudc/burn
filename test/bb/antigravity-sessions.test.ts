import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAntigravitySessions } from "../../extensions/bb/host/antigravity-sessions.js";

const parent = "00000000-0000-0000-0000-000000000001";
const child = "00000000-0000-0000-0000-000000000002";
const time = "2025-01-01T12:00:00Z";
const model = "example-model-medium";
const prompt = { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: time, content: "inspect" };
const call = { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: time, model, input_tokens: 1000, output_tokens: 30, cache_read_tokens: 0 };
const second = { ...call, step_index: 3, input_tokens: 200, output_tokens: 20, cache_read_tokens: 500 };
const rate = { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 };
const prices = { "example-model": rate };

describe("Antigravity transcript accounting", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "burn-agy-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  function write(id: string, rows: unknown[]) {
    const logs = join(dir, id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const data = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(logs, "transcript_full.jsonl"), data);
    const path = join(logs, "transcript.jsonl");
    writeFileSync(path, data);
    return path;
  }

  it("counts each step once, keeps the actual model, and reprices the cached token counts", async () => {
    write(parent, [prompt, call, call, second]);
    const sessions = createAntigravitySessions(dir);
    const get = (overrides: typeof prices | Record<string, typeof rate>) => sessions.reportOf([parent, parent], "UTC", { prices: overrides });
    const got = (await get(prices))?.report;
    expect(got).toMatchObject({ calls: 2, turnCount: 1, estimated: true, tokens: { input: 1200, cacheRead: 500, output: 50 }, byModel: [{ key: "antigravity-plus/" + model }] });
    expect(got?.cost.total).toBeCloseTo(0.004425, 12);
    const exact = await get({ ...prices, [model]: { ...rate, input: 4 } });
    expect(exact?.report.cost.total).toBeCloseTo(0.005625, 12);
  });

  it("keeps unpriced tokens, recovers after an append and ignores unrelated session paths", async () => {
    const file = write(parent, [prompt, call]);
    const sessions = createAntigravitySessions(dir);
    expect(await sessions.reportOf([child, "../" + parent], "UTC")).toBeNull();
    expect((await sessions.reportOf([parent], "UTC"))?.report).toMatchObject({ coverage: "partial", calls: 1, cost: { total: 0 }, tokens: { input: 1000 } });
    const json = JSON.stringify(second);
    appendFileSync(file, json.slice(0, -1));
    expect((await sessions.reportOf([parent], "UTC", { prices }))?.report.coverage).toBe("partial");
    appendFileSync(file, json.slice(-1) + "\n");
    const got = (await sessions.reportOf([parent], "UTC", { prices }))?.report;
    expect(got?.coverage).not.toBe("partial");
    expect(got?.calls).toBe(2);
  });

  it("excludes inherited calls and keeps a new call in the second of a fork", async () => {
    write(parent, [prompt, call]);
    write(child, [prompt, call, second]);
    const got = await createAntigravitySessions(dir).reportOf([child], "UTC", { prices, since: Date.parse(time) + 123, parentSessionIds: [parent] });
    expect(got?.report).toMatchObject({ calls: 1, tokens: { input: 200, cacheRead: 500, output: 20 } });
  });
});
