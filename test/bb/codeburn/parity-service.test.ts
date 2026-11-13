import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { createParityService, exportDateWindow } from "../../../extensions/bb/codeburn/parity-service.js";
import { reportQuerySchema, scopeSchema } from "../../../extensions/bb/codeburn/parity-contract.js";
import { mergeProjectFilter, readProjectFilter } from "../../../extensions/bb/codeburn/project-filter.js";
const comparisonKey = `-Users-${"canonical-project-".repeat(30)}/repo`;

async function fixture(now?: () => number) {
  const home = await mkdtemp(join(tmpdir(), "bb-codeburn-parity-test-"));
  const executable = join(home, "codeburn.mjs");
  const marker = join(home, "currency.txt");
  const waiters = new Map<string, () => void>();
  const watcher = watch(home, (_event, filename) => {
    if (filename) waiters.get(filename.toString())?.();
  });
  await writeFile(executable, `#!/usr/bin/env node
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
const home = ${JSON.stringify(home)};
const key = ${JSON.stringify(comparisonKey)};
const args = process.argv.slice(2);
if (process.env.CODEBURN_CURSOR_SYNC !== "0") await writeFile(join(home, "cursor-sync.txt"), "unexpected automatic synchronization");
async function gate(name) {
  const pending = Promise.withResolvers();
  const watcher = watch(home, (_event, filename) => { if (filename?.toString() === name) pending.resolve(); });
  try {
    try { await readFile(join(home, name)); pending.resolve(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await pending.promise;
  } finally { watcher.close(); }
}
if (args[0] === "currency") {
  await writeFile(${JSON.stringify(marker)}, args[1]);
  if (args[1] === "JPY") { console.error("post-commit refresh failed"); process.exitCode = 1; }
  else console.log("Currency saved");
} else if (args[0] === "export") {
  const output = args[args.indexOf("--output") + 1];
  await writeFile(join(home, "export-target.txt"), output);
  let large = false;
  try { await readFile(join(home, "large-export")); large = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (args.includes("json")) await writeFile(output, JSON.stringify(large ? { padding: "x".repeat(2 * 1024 * 1024) } : { native: true, records: [1, 2, 3] }));
  else { await mkdir(output, { recursive: true }); await writeFile(join(output, "records.csv"), "id,cost\\na,0.0038\\n"); }
  console.log("Exported (fixture) to: " + output);
} else if (args[0] === "compare-periods") {
  if (args.includes("sessions")) {
    const attached = args.find((arg) => arg.startsWith("--key="));
    const chosen = attached ? attached.slice(6) : args[args.indexOf("--key") + 1];
    console.log(JSON.stringify(chosen === key ? [{ sessionId: "matching-session", cost: 0.0038 }] : []));
  } else console.log(JSON.stringify({ projects: [{ key, cost: 0.0038 }] }));
} else if (args[0] === "compare") {
  let captured = "before";
  try { captured = await readFile(${JSON.stringify(marker)}, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(join(home, "report-started"), "ready");
  await gate("report-release");
  console.log(JSON.stringify({ captured }));
} else if (args[0] === "model-alias") {
  console.log(JSON.stringify(Object.fromEntries(Array.from({ length: 125 }, (_, i) => ["entry-" + i, { canonical: "model-" + i }]))));
} else if (args[0] === "models") {
  await writeFile(join(home, "models-started"), "ready");
  await gate("models-release");
  console.log("[]");
} else {
  console.log(JSON.stringify(Array.from({ length: 125 }, (_, i) => ({ sessionId: "session-" + i, cost: i / 1000, project: i === 101 ? "needle" : "ordinary", contributions: { segments: [{ branch: "branch-" + i, cost: i / 1000 }] } }))));
}
`, { mode: 0o700 });
  const service = createParityService({ home, now });
  return {
    home, executable, marker, service,
    async ready(name: string) {
      const pending = Promise.withResolvers<void>();
      waiters.set(name, pending.resolve);
      // Diagnostic deadline for an external process; synchronization uses filesystem events, never a sleep.
      const timer = setTimeout(() => pending.reject(new Error(`CLI fixture did not reach ${name}`)), 5000);
      try {
        try { await readFile(join(home, name)); pending.resolve(); }
        catch (error) { if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        await pending.promise;
      } finally { clearTimeout(timer); waiters.delete(name); }
    },
    async close() {
      watcher.close();
      try { await service.dispose(); } finally { await rm(home, { recursive: true, force: true }); }
    },
  };
}

const signal = () => new AbortController().signal;

test.skipIf(process.platform === "win32")("pages the entire report and keeps nested session contributions available through stable snapshot paths", async () => {
  const f = await fixture();
  try {
    const input = { ...reportQuerySchema.parse({ report: "sessions", period: "today" }), cliPath: f.executable };
    const first = await f.service.report(input, signal());
    assert.equal(first.totalRows, 125);
    assert.equal(first.rows.length, 50);
    const second = await f.service.report({ ...input, snapshot: first.snapshot, page: 2 }, signal());
    assert.equal(second.rows[1]?.sessionId, "session-101");
    const detail = await f.service.report({ ...input, snapshot: first.snapshot, focus: second.rowPaths[1] }, signal());
    assert.ok(detail.fields.some((field) => field.name === "sessionId" && field.value === "session-101"));
    const contributions = detail.fields.find((field) => field.name === "contributions");
    assert.ok(contributions);
    const nested = await f.service.report({ ...input, snapshot: first.snapshot, focus: [...contributions.path, "segments"] }, signal());
    assert.deepEqual(nested.rows[0], { branch: "branch-101", cost: 0.101 });
    const filtered = await f.service.report({ ...input, snapshot: first.snapshot, search: "needle" }, signal());
    assert.equal(filtered.totalRows, 1);
    assert.equal(filtered.rows[0]?.sessionId, "session-101");
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("configuration preview has no side effect and confirmation is single-use and executable-bound", async () => {
  const f = await fixture();
  try {
    const preview = await f.service.preview({ cliPath: f.executable, action: "currency-set", values: { code: "EUR" } }, signal());
    await assert.rejects(readFile(f.marker), { code: "ENOENT" });
    await assert.rejects(f.service.confirm({ cliPath: "/wrong/codeburn", ticket: preview.ticket }, signal()), /executable|expired|invalid|match/i);
    const confirmed = await f.service.confirm({ cliPath: f.executable, ticket: preview.ticket }, signal());
    assert.match(confirmed.stdout, /Currency saved/);
    assert.equal(await readFile(f.marker, "utf8"), "EUR");
    await assert.rejects(f.service.confirm({ cliPath: f.executable, ticket: preview.ticket }, signal()), /expired|invalid|used/i);
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("rejects invalid calendar dates, unsupported operations, and out-of-snapshot paths before execution", async () => {
  const f = await fixture();
  try {
    assert.equal(reportQuerySchema.safeParse({ report: "sessions", range: { from: "2025-02-30", to: "2025-03-10" } }).success, false);
    assert.equal(reportQuerySchema.safeParse({ report: "sessions", range: { from: "2025-03-11", to: "2025-03-10" } }).success, false);
    assert.equal(reportQuerySchema.safeParse({ report: "shell", params: { command: "touch forbidden" } }).success, false);
    const input = { ...reportQuerySchema.parse({ report: "sessions" }), cliPath: f.executable };
    const first = await f.service.report(input, signal());
    await assert.rejects(f.service.report({ ...input, snapshot: first.snapshot, focus: ["__proto__"] }, signal()), /path|field|invalid|prototype/i);
    await assert.rejects(f.service.report({ ...input, snapshot: "nonexistent" }, signal()), /expired|snapshot|invalid/i);
    await assert.rejects(f.service.preview({ cliPath: f.executable, action: "currency-set", values: { code: "--help" } }, signal()), /currency|invalid|code/i);
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("exports native bytes in bounded chunks and released leases cannot read files", async () => {
  const f = await fixture();
  try {
    const lease = await f.service.exportStart({ cliPath: f.executable, format: "json", period: "today", provider: "all", project: [], exclude: [] }, signal());
    assert.equal(lease.files.length, 1);
    const file = lease.files[0]!;
    const chunk = await f.service.exportRead({ cliPath: f.executable, id: lease.id, name: file.name, offset: 0 }, signal());
    assert.equal(chunk.eof, true);
    assert.deepEqual(JSON.parse(Buffer.from(chunk.base64, "base64").toString("utf8")), { native: true, records: [1, 2, 3] });
    await assert.rejects(f.service.exportRead({ cliPath: f.executable, id: lease.id, name: "../currency.txt", offset: 0 }, signal()), /file|invalid|name/i);
    await f.service.exportEnd({ cliPath: f.executable, id: lease.id }, signal());
    await assert.rejects(f.service.exportRead({ cliPath: f.executable, id: lease.id, name: file.name, offset: 0 }, signal()), /expired|export|lease/i);
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("a malformed saved project filter fails closed rather than silently exposing unfiltered usage", async () => {
  const f = await fixture();
  try {
    const config = join(f.home, ".config", "codeburn");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "app-filter.json"), "{incomplete");
    const input = { ...reportQuerySchema.parse({ report: "sessions" }), cliPath: f.executable };
    await assert.rejects(f.service.report(input, signal()), /filter|project|unreadable|JSON/i);
  } finally { await f.close(); }
});

test("saved project includes cannot be widened and exclusions always survive a narrower selection", async () => {
  const home = await mkdtemp(join(tmpdir(), "bb-codeburn-filter-test-"));
  try {
    const path = join(home, ".config", "codeburn");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "app-filter.json"), JSON.stringify({
      project: [" ~/source ", "~/source", "-Users-me-project", "other"],
      exclude: ["private", "private", " generated "],
    }));
    const saved = await readProjectFilter(home);
    assert.deepEqual(saved, {
      project: [join(home, "source"), "-Users-me-project", "other"],
      exclude: ["private", "generated"],
    });
    assert.deepEqual(mergeProjectFilter(saved, { project: ["other"], exclude: ["extra"] }), {
      project: ["other"], exclude: ["private", "generated", "extra"],
    });
    assert.throws(() => mergeProjectFilter(saved, { project: ["unknown"], exclude: [] }), /widen|saved/i);
    await writeFile(join(path, "app-filter.json"), "{invalid");
    await assert.rejects(readProjectFilter(home), /filter|JSON/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("expired snapshots, previews and export leases cannot be replayed", async () => {
  let time = new Date(2026, 2, 1, 12).getTime();
  const f = await fixture(() => time);
  try {
    const query = { ...reportQuerySchema.parse({ report: "sessions" }), cliPath: f.executable };
    const result = await f.service.report(query, signal());
    const preview = await f.service.preview({ cliPath: f.executable, action: "currency-set", values: { code: "EUR" } }, signal());
    const lease = await f.service.exportStart({ cliPath: f.executable, format: "json", period: "today", provider: "all", project: [], exclude: [] }, signal());
    time += 5 * 60_000 + 1;
    await assert.rejects(f.service.report({ ...query, snapshot: result.snapshot }, signal()), /expired|snapshot/i);
    await assert.rejects(f.service.confirm({ cliPath: f.executable, ticket: preview.ticket }, signal()), /expired|ticket/i);
    await assert.rejects(f.service.exportRead({ cliPath: f.executable, id: lease.id, name: lease.files[0]!.name, offset: 0 }, signal()), /expired|lease/i);
    await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("export windows preserve local calendar boundaries and upstream trailing-period semantics", () => {
  const now = new Date(2024, 2, 1, 12).getTime();
  const expected: Record<string, string> = {
    today: "2024-03-01", week: "2024-02-23", "30days": "2024-01-31",
    month: "2024-03-01", all: "2023-09-01", lifetime: "1970-01-01",
  };
  for (const [period, from] of Object.entries(expected)) {
    assert.deepEqual(exportDateWindow(scopeSchema.parse({ period }), now), { from, to: "2024-03-01" });
  }
  assert.deepEqual(exportDateWindow(scopeSchema.parse({
    period: "all", range: { from: "2024-02-29", to: "2024-03-01" },
  }), now), { from: "2024-02-29", to: "2024-03-01" });
});

test.skipIf(process.platform === "win32")("project visibility changes only on confirmation and invalidates saved report snapshots", async () => {
  const f = await fixture();
  try {
    const query = { ...reportQuerySchema.parse({ report: "sessions" }), cliPath: f.executable };
    const before = await f.service.report(query, signal());
    const filterFile = join(f.home, ".config", "codeburn", "app-filter.json");
    const preview = await f.service.preview({
      cliPath: f.executable, action: "project-filter-set",
      values: { project: " ~/source\n~/source", exclude: "private\nprivate" },
    }, signal());
    await assert.rejects(readFile(filterFile), { code: "ENOENT" });
    assert.equal(preview.command[1], filterFile);
    await f.service.confirm({ cliPath: f.executable, ticket: preview.ticket }, signal());
    assert.deepEqual(await readProjectFilter(f.home), {
      project: [join(f.home, "source")], exclude: ["private"],
    });
    await assert.rejects(f.service.report({ ...query, snapshot: before.snapshot }, signal()), /snapshot|invalid|expired/i);
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("large native objects page by original field paths without losing nested values", async () => {
  const f = await fixture();
  try {
    const query = { ...reportQuerySchema.parse({ report: "aliases" }), cliPath: f.executable };
    const first = await f.service.report(query, signal());
    assert.equal(first.totalRows, 125);
    assert.equal(first.fields.length, 50);
    const second = await f.service.report({ ...query, snapshot: first.snapshot, page: 2 }, signal());
    assert.deepEqual(second.rowPaths[1], ["entry-101"]);
    const detail = await f.service.report({ ...query, snapshot: first.snapshot, focus: second.rowPaths[1] }, signal());
    assert.equal(detail.fields.find((field) => field.name === "canonical")?.value, "model-101");
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("disposing an in-flight native report cancels the child and rejects further use", async () => {
  const f = await fixture();
  try {
    const input = { ...reportQuerySchema.parse({ report: "models" }), cliPath: f.executable };
    const pending = f.service.report(input, signal());
    await f.ready("models-started");
    await f.service.dispose();
    await assert.rejects(pending, /cancelled|disposed/i);
    await assert.rejects(f.service.report(input, signal()), /disposed/i);
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("price previews never invent zero input or output rates for omitted values", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.preview({
      cliPath: f.executable, action: "price-set", values: { model: "test-model", output: "2" },
    }, signal()), /input.*required|input.*missing|both.*input/i);
    await assert.rejects(f.service.preview({
      cliPath: f.executable, action: "price-set", values: { model: "test-model", input: "2" },
    }, signal()), /output.*required|output.*missing|both.*input/i);
  } finally { await f.close(); }
});

test("different confirmed settings survive concurrent read-modify-write CLI operations", async () => {
  const f = await fixture();
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let stored: Record<string, { input: number; output: number }> = {};
  const service = createParityService({
    home: f.home,
    run: async (_cliPath, args) => {
      const before = { ...stored };
      if (args[1] === "first-model") { firstStarted.resolve(); await releaseFirst.promise; }
      stored = { ...before, [args[1]!]: { input: 1, output: 2 } };
      return { stdout: "Price saved", stderr: "" };
    },
  });
  try {
    const first = await service.preview({ cliPath: f.executable, action: "price-set", values: { model: "first-model", input: "1", output: "2" } }, signal());
    const second = await service.preview({ cliPath: f.executable, action: "price-set", values: { model: "second-model", input: "1", output: "2" } }, signal());
    const confirmations = [first, second].map((preview) => service.confirm({ cliPath: f.executable, ticket: preview.ticket }, signal()));
    await firstStarted.promise;
    releaseFirst.resolve();
    await Promise.all(confirmations);
    assert.deepEqual(Object.keys(stored).sort(), ["first-model", "second-model"]);
  } finally { releaseFirst.resolve(); await service.dispose(); await f.close(); }
});

test.skipIf(process.platform === "win32")("a post-commit failure invalidates snapshots instead of retaining stale accounting", async () => {
  const f = await fixture();
  try {
    const input = { ...reportQuerySchema.parse({ report: "sessions" }), cliPath: f.executable };
    const before = await f.service.report(input, signal());
    const preview = await f.service.preview({ cliPath: f.executable, action: "currency-set", values: { code: "JPY" } }, signal());
    await assert.rejects(f.service.confirm({ cliPath: f.executable, ticket: preview.ticket }, signal()), /post-commit refresh failed/);
    assert.equal(await readFile(f.marker, "utf8"), "JPY");
    await assert.rejects(f.service.report({ ...input, snapshot: before.snapshot }, signal()), /snapshot|configuration|expired/i);
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("a report begun before a confirmed change cannot publish after mutation settlement", async () => {
  const f = await fixture();
  try {
    const pending = f.service.report({ ...reportQuerySchema.parse({ report: "model-comparison" }), cliPath: f.executable }, signal());
    await f.ready("report-started");
    const preview = await f.service.preview({ cliPath: f.executable, action: "currency-set", values: { code: "EUR" } }, signal());
    await f.service.confirm({ cliPath: f.executable, ticket: preview.ticket }, signal());
    await writeFile(join(f.home, "report-release"), "go");
    await assert.rejects(pending, /configuration|changed|superseded/i);
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("pending native exports reserve the two-lease capacity before launching children", async () => {
  const f = await fixture();
  try {
    const input = { cliPath: f.executable, format: "json" as const, period: "today" as const, provider: "all", project: [], exclude: [] };
    const results = await Promise.allSettled([f.service.exportStart(input, signal()), f.service.exportStart(input, signal()), f.service.exportStart(input, signal())]);
    const completed = results.filter((result) => result.status === "fulfilled");
    assert.equal(completed.length, 2);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    for (const result of completed) await f.service.exportEnd({ cliPath: f.executable, id: result.value.id }, signal());
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("multi-chunk export reads reject same-size in-place rewrites", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, "large-export"), "yes");
    const lease = await f.service.exportStart({ cliPath: f.executable, format: "json", period: "today", provider: "all", project: [], exclude: [] }, signal());
    const name = lease.files[0]!.name;
    const first = await f.service.exportRead({ cliPath: f.executable, id: lease.id, name, offset: 0 }, signal());
    assert.equal(first.nextOffset, 1024 * 1024);
    assert.equal(first.eof, false);
    const path = await readFile(join(f.home, "export-target.txt"), "utf8");
    const bytes = await readFile(path);
    bytes[bytes.length - 10] = "y".charCodeAt(0);
    await writeFile(path, bytes);
    await assert.rejects(f.service.exportRead({ cliPath: f.executable, id: lease.id, name, offset: first.nextOffset }, signal()), /changed|integrity/i);
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("read-only reports disable implicit synchronization and never initialize sharing identity", async () => {
  const f = await fixture();
  try {
    await f.service.report({ ...reportQuerySchema.parse({ report: "sessions" }), cliPath: f.executable }, signal());
    await assert.rejects(readFile(join(f.home, "cursor-sync.txt")), { code: "ENOENT" });
    for (const report of ["devices", "device-scan", "identity", "share-status"] as const) {
      await assert.rejects(f.service.report({ ...reportQuerySchema.parse({ report }), cliPath: f.executable }, signal()), /sharing|identity|initialize/i);
    }
    await assert.rejects(readFile(join(f.home, ".config", "codeburn", "sharing", "device-key.pem")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test.skipIf(process.platform === "win32")("comparison drill-through preserves long dash-leading canonical identities", async () => {
  const f = await fixture();
  try {
    const dates = { fromA: "2025-03-01", toA: "2025-03-02", fromB: "2025-03-03", toB: "2025-03-04" };
    const input = { ...reportQuerySchema.parse({ report: "period-comparison", params: dates }), cliPath: f.executable };
    const base = await f.service.report(input, signal());
    const projects = await f.service.report({ ...input, snapshot: base.snapshot, focus: ["projects"] }, signal());
    assert.equal(projects.rows[0]?.key, comparisonKey);
    const drill = await f.service.report({ ...reportQuerySchema.parse({
      report: "period-sessions", params: { ...dates, dimension: "project", key: String(projects.rows[0]!.key) },
    }), cliPath: f.executable }, signal());
    assert.equal(drill.rows[0]?.sessionId, "matching-session");
  } finally { await f.close(); }
});

test("worker disposal waits for a cancelled native export to finish and removes its private directory", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let destination = "";
  let childFinished = false;
  const service = createParityService({ home: f.home, run: async (_path, args, childSignal) => {
    destination = args[args.indexOf("--output") + 1]!;
    await writeFile(destination, '{"partial":true}');
    const onAbort = () => cancelled.resolve();
    childSignal.addEventListener("abort", onAbort, { once: true });
    started.resolve();
    try {
      await finish.promise;
      childFinished = true;
      return { stdout: "Export complete", stderr: "" };
    } finally { childSignal.removeEventListener("abort", onAbort); }
  } });
  try {
    const pending = service.exportStart({ cliPath: f.executable, format: "json", period: "today", provider: "all", project: [], exclude: [] }, signal());
    const rejected = assert.rejects(pending, /cancelled/i);
    await started.promise;
    const disposed = service.dispose();
    await cancelled.promise;
    finish.resolve();
    await disposed;
    assert.equal(childFinished, true);
    await assert.rejects(stat(dirname(destination)), { code: "ENOENT" });
    await rejected;
  } finally { finish.resolve(); await service.dispose(); await f.close(); }
});
