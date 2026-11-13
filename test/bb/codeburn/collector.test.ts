import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollector, dateWindow } from "../../../extensions/bb/codeburn/collector.js";
import { statsSchema } from "../../../extensions/bb/codeburn/contract.js";

const baseQuery = {
  cliPath: "codeburn",
  period: "7d" as const,
  table: "daily" as const,
  page: 0,
  search: "",
  refresh: false,
};
const emptyProjectFilter = async () => ({ project: [] as string[], exclude: [] as string[] });

function exportData(overrides: Record<string, unknown> = {}) {
  return {
    schema: "codeburn.export.v3",
    generated: "2025-03-10T16:00:00Z",
    currency: { code: "USD", rate: 1, symbol: "$" },
    summary: [{ period: "Custom", cost: 17.5, saved: 2, apiCalls: 3, sessions: 2, projects: 1 }],
    periods: [{
      label: "Custom",
      daily: [
        { date: "2025-03-09", cost: 10, saved: 2, apiCalls: 2, sessions: 1,
          inputTokens: 11, outputTokens: 12, cacheReadTokens: 13, cacheWriteTokens: 14,
          costBasis: { recorded: 1 } },
        { date: "2025-03-10", cost: 7.5, saved: 0, apiCalls: 1, sessions: 1,
          inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8,
          costBasis: { recorded: 1 } },
      ],
      activity: [{ activity: "Editing", cost: 17.5, share: 100, turns: 3 }],
      models: [{ model: "Example", cost: 17.5, apiCalls: 3, extraColumn: "kept" }],
    }],
    projects: [{ project: "Sandbox", cost: 17.5, saved: 2, apiCalls: 3, sessions: 2 }],
    sessions: [{ sessionId: "session-one", project: "Sandbox", cost: 17.5, costBasis: { recorded: 1 } }],
    records: [{ sessionId: "session-one", timestamp: "2025-03-10T15:00:00Z", cost: 17.5, costBasis: { recorded: 1 } }],
    tools: [{ tool: "Write", calls: 2 }],
    mcp: [{ server: "example", calls: 1 }],
    shellCommands: [{ command: "pwd", calls: 1 }],
    ...overrides,
  };
}

function makeCollector(payload: unknown = exportData(), now = () => new Date(2025, 2, 10, 12)) {
  const collector = createCollector({ now, run: async () => JSON.stringify(payload), readFilter: emptyProjectFilter });
  return { collector };
}

test("calendar presets match CodeBurn's native trailing ranges across DST and year boundaries", () => {
  const prior = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.deepEqual(dateWindow("7d", new Date(2025, 2, 10, 0, 1)), { from: "2025-03-03", to: "2025-03-10" });
    assert.deepEqual(dateWindow("30d", new Date(2025, 2, 10, 0, 1)), { from: "2025-02-08", to: "2025-03-10" });
    assert.deepEqual(dateWindow("today", new Date(2025, 0, 1, 0, 1)), { from: "2025-01-01", to: "2025-01-01" });
    assert.deepEqual(dateWindow("7d", new Date(2025, 0, 1, 0, 1)), { from: "2024-12-25", to: "2025-01-01" });
    assert.deepEqual(dateWindow("today", new Date("2025-01-01T04:30:00Z")), { from: "2024-12-31", to: "2024-12-31" });
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
});

test("exports exactly the selected local calendar window, and returns complete typed summary and token totals", async () => {
  const { collector } = makeCollector();
  const result = await collector.statistics(baseQuery, new AbortController().signal);
  assert.equal(result.schema, "codeburn.export.v3");
  assert.deepEqual(result.summary, { cost: 17.5, saved: 2, apiCalls: 3, sessions: 2, projects: 1 });
  assert.deepEqual(result.tokens, { input: 16, output: 18, cacheRead: 20, cacheWrite: 22 });
  assert.deepEqual(statsSchema.parse(result), result);
  assert.deepEqual([result.from, result.to, result.totalRows, result.page, result.pageSize], ["2025-03-03", "2025-03-10", 2, 0, 50]);
  assert.deepEqual(result.rows[0]?.costBasis, { recorded: 1 });
  assert.ok(result.columns.includes("costBasis"));
  collector.dispose();
});

test("rejects old schemas with an actionable upgrade message", async () => {
  const { collector } = makeCollector(exportData({ schema: "codeburn.export.v2" }));
  await assert.rejects(collector.statistics(baseQuery, new AbortController().signal), /codeburn\.export\.v3.*0\.9\.28|0\.9\.28.*codeburn\.export\.v3/i);
  collector.dispose();
});

test("rejects missing summary fields rather than inventing zero", async () => {
  const { collector } = makeCollector(exportData({ summary: [{ period: "Custom", cost: 3, saved: 0, apiCalls: 1, sessions: 1 }] }));
  await assert.rejects(collector.statistics(baseQuery, new AbortController().signal), /summary|projects/i);
  collector.dispose();
});

test("surfaces missing executable errors from the real default runner", async () => {
  const collector = createCollector({ readFilter: emptyProjectFilter });
  await assert.rejects(
    collector.statistics({ ...baseQuery, cliPath: "/no-such-codeburn-executable-for-test" }, new AbortController().signal),
    /executable|ENOENT|no such file/i,
  );
  collector.dispose();
});

test.skipIf(process.platform === "win32")("reads the native export file instead of treating CLI success narration as JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-codeburn-test-"));
  const executable = join(directory, "codeburn.mjs");
  const outputPathRecord = join(directory, "written-path.txt");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const at = process.argv.indexOf("--output");
if (at >= 0) {
  await writeFile(process.argv[at + 1], ${JSON.stringify(JSON.stringify(exportData()))});
  await writeFile(${JSON.stringify(outputPathRecord)}, process.argv[at + 1]);
}
console.log("Exported usage to a JSON file.");
`, { mode: 0o700 });
  const collector = createCollector({ readFilter: emptyProjectFilter });
  try {
    const result = await collector.statistics({ ...baseQuery, cliPath: executable }, new AbortController().signal);
    assert.deepEqual(result.tokens, { input: 16, output: 18, cacheRead: 20, cacheWrite: 22 });
    const writtenPath = await readFile(outputPathRecord, "utf8");
    await assert.rejects(readFile(writtenPath), { code: "ENOENT" });
  } finally {
    collector.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed JSON and missing daily token fields visibly", async () => {
  const malformed = createCollector({ run: async () => "{not json", readFilter: emptyProjectFilter });
  await assert.rejects(malformed.statistics(baseQuery, new AbortController().signal), /malformed|JSON/i);
  malformed.dispose();
  const missing = makeCollector(exportData({ periods: [{ label: "Custom", daily: [{ date: "2025-03-10", cost: 1 }], activity: [], models: [] }] }));
  await assert.rejects(missing.collector.statistics(baseQuery, new AbortController().signal), /daily|inputTokens/i);
  missing.collector.dispose();
});

test("requires one selected custom-period summary and every requested table", async () => {
  const multiple = makeCollector(exportData({ summary: [exportData().summary[0], exportData().summary[0]] }));
  await assert.rejects(multiple.collector.statistics(baseQuery, new AbortController().signal), /summary|period/i);
  multiple.collector.dispose();
  const missing: Record<string, unknown> = exportData();
  delete missing.shellCommands;
  const absentTable = makeCollector(missing);
  await assert.rejects(absentTable.collector.statistics({ ...baseQuery, table: "shellCommands" }, new AbortController().signal), /shellCommands/i);
  absentTable.collector.dispose();
});


test("pages complete raw records, clamps excessive page indices, and preserves sparse optional columns", async () => {
  const records = Array.from({ length: 123 }, (_, index) => ({
    timestamp: `2025-03-10T00:00:${String(index).padStart(3, "0")}Z`, sessionId: `session-${index}`, cost: 1,
    ...(index === 99 ? { optional: { costBasis: "recorded" } } : {}),
  }));
  const { collector } = makeCollector(exportData({ records }));
  const first = await collector.statistics({ ...baseQuery, table: "records" }, new AbortController().signal);
  assert.ok(first.columns.includes("optional"));
  const second = await collector.statistics({ ...baseQuery, table: "records", page: 1 }, new AbortController().signal);
  assert.deepEqual([second.totalRows, second.rows.length, second.page], [123, 50, 1]);
  assert.deepEqual(second.rows[49]?.optional, { costBasis: "recorded" });
  assert.ok(second.columns.includes("optional"));
  const last = await collector.statistics({ ...baseQuery, table: "records", page: 99 }, new AbortController().signal);
  assert.deepEqual([last.totalRows, last.rows.length, last.page], [123, 23, 2]);
  assert.deepEqual(last.summary, second.summary);
  const nested = await collector.statistics({ ...baseQuery, table: "records", search: "RECORDED" }, new AbortController().signal);
  assert.deepEqual([nested.totalRows, nested.rows[0]?.sessionId], [1, "session-99"]);
  collector.dispose();
});
test("pages full sessions without turning the selected period's full summary into a page subtotal", async () => {
  const sessions = Array.from({ length: 61 }, (_, index) => ({ sessionId: `session-${index}`, cost: index + 0.5 }));
  const { collector } = makeCollector(exportData({ sessions }));
  const second = await collector.statistics({ ...baseQuery, table: "sessions", page: 1 }, new AbortController().signal);
  assert.deepEqual([second.totalRows, second.rows.length, second.page], [61, 11, 1]);
  assert.deepEqual(second.rows[0], sessions[50]);
  assert.deepEqual(second.summary, { cost: 17.5, saved: 2, apiCalls: 3, sessions: 2, projects: 1 });
  collector.dispose();
});


test("search filters full native rows before pagination but never changes period-wide summary or token totals", async () => {
  const { collector } = makeCollector(exportData({ records: Array.from({ length: 85 }, (_, i) => ({ sessionId: i % 2 ? "match" : "other", value: i })) }));
  const result = await collector.statistics({ ...baseQuery, table: "records", search: "match", page: 1 }, new AbortController().signal);
  assert.equal(result.totalRows, 42);
  assert.equal(result.page, 0);
  assert.equal(result.rows.length, 42);
  assert.deepEqual(result.summary, { cost: 17.5, saved: 2, apiCalls: 3, sessions: 2, projects: 1 });
  assert.deepEqual(result.tokens, { input: 16, output: 18, cacheRead: 20, cacheWrite: 22 });
  collector.dispose();
});

test("caches only successful exports for thirty seconds by executable, period, and local day; refresh failure never serves stale data", async () => {
  let time = new Date(2025, 2, 10, 12);
  let tries = 0;
  const collector = createCollector({ now: () => time, readFilter: emptyProjectFilter, run: async () => {
    tries++;
    if (tries === 3) throw new Error("executable unavailable");
    return JSON.stringify(exportData());
  } });
  const signal = new AbortController().signal;
  await collector.statistics(baseQuery, signal);
  await collector.statistics({ ...baseQuery, table: "records" }, signal);
  time = new Date(2025, 2, 10, 12, 0, 29);
  await collector.statistics(baseQuery, signal);
  assert.equal(tries, 1);
  time = new Date(2025, 2, 10, 12, 0, 30);
  await collector.statistics(baseQuery, signal);
  assert.equal(tries, 2);
  await assert.rejects(collector.statistics({ ...baseQuery, refresh: true }, signal), /executable unavailable/);
  await collector.statistics({ ...baseQuery, cliPath: "/another/codeburn" }, signal);
  await collector.statistics({ ...baseQuery, period: "today" }, signal);
  time = new Date(2025, 2, 11, 0);
  await collector.statistics(baseQuery, signal);
  assert.equal(tries, 6);
  collector.dispose();
});

test("an older concurrent export cannot replace a completed newer refresh", async () => {
  const completions: ((value: string) => void)[] = [];
  const bothStarted = Promise.withResolvers<void>();
  const collector = createCollector({
    readFilter: emptyProjectFilter,
    now: () => new Date(2025, 2, 10, 12),
    run: async () => {
      const pending = Promise.withResolvers<string>();
      completions.push(pending.resolve);
      if (completions.length === 2) bothStarted.resolve();
      return pending.promise;
    },
  });
  const signal = new AbortController().signal;
  const older = collector.statistics(baseQuery, signal);
  const refreshed = collector.statistics({ ...baseQuery, refresh: true }, signal);
  await bothStarted.promise;
  completions[1](JSON.stringify(exportData({ generated: "2025-03-10T17:00:00Z" })));
  const latest = await refreshed;
  completions[0](JSON.stringify(exportData({ generated: "2025-03-10T16:00:00Z" })));
  await older;
  const nextPage = await collector.statistics({ ...baseQuery, table: "records" }, signal);
  assert.equal(nextPage.generated, latest.generated);
  collector.dispose();
});

test("propagates request cancellation and disposal to owned CLI requests", async () => {
  const started: AbortSignal[] = [];
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const collector = createCollector({ readFilter: emptyProjectFilter, run: async (_cliPath, _args, signal) => {
    const pending = Promise.withResolvers<string>();
    started.push(signal);
    (started.length === 1 ? firstStarted : secondStarted).resolve();
    signal.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
    return pending.promise;
  } });
  const first = new AbortController();
  const firstCall = collector.statistics(baseQuery, first.signal);
  await firstStarted.promise;
  first.abort();
  await assert.rejects(firstCall, /abort/i);
  assert.equal(started[0]?.aborted, true);
  const secondCall = collector.statistics(baseQuery, new AbortController().signal);
  await secondStarted.promise;
  collector.dispose();
  await assert.rejects(secondCall, /abort|dispos/i);
  assert.equal(started[1]?.aborted, true);
  await assert.rejects(collector.statistics(baseQuery, new AbortController().signal), /dispos/i);
});

test("a changed or unreadable saved visibility filter cannot serve a previous unfiltered export", async () => {
  let filter = { project: [] as string[], exclude: [] as string[] };
  let unreadable = false;
  let scans = 0;
  const collector = createCollector({
    now: () => new Date(2025, 2, 10, 12),
    readFilter: async () => {
      if (unreadable) throw new Error("Project visibility filter is unreadable");
      return filter;
    },
    run: async () => {
      scans++;
      return JSON.stringify(exportData({ projects: [{ project: scans === 1 ? "Private project" : "Public project", cost: 1 }] }));
    },
  });
  try {
    const query = { ...baseQuery, table: "projects" as const };
    assert.equal((await collector.statistics(query, new AbortController().signal)).rows[0]?.project, "Private project");
    filter = { project: [], exclude: ["Private project"] };
    assert.equal((await collector.statistics(query, new AbortController().signal)).rows[0]?.project, "Public project");
    unreadable = true;
    await assert.rejects(collector.statistics(query, new AbortController().signal), /visibility filter is unreadable/);
  } finally {
    collector.dispose();
  }
});
