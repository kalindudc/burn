import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import {
  antigravityBrainDir,
  createAntigravitySessions,
  extractAntigravityPrompt,
  stripEffortSuffix,
} from "../../extensions/bb/host/antigravity-sessions.js";
import { createHostEntry } from "../../extensions/bb/host/entry.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TS = "2026-11-23T11:29:07.000Z";
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

function userInput(content: string, created_at = TS) {
  return { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at, content };
}

function planner(
  opts: {
    model?: string;
    input?: number;
    cacheRead?: number;
    output?: number;
    status?: string;
    error?: string;
    tools?: string[];
    created_at?: string;
  } = {},
) {
  return {
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: opts.status ?? "DONE",
    created_at: opts.created_at ?? TS,
    model: opts.model ?? "gemini-4-hydrogen-high",
    input_tokens: opts.input ?? 1000,
    cache_read_tokens: opts.cacheRead ?? 2000,
    output_tokens: opts.output ?? 500,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(opts.tools ? { tool_calls: opts.tools.map((name) => ({ name, args: {} })) } : {}),
  };
}

function setup(opts: { withCatalog?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "burn-agy-"));
  dirs.push(base);
  const dir = join(base, "brain");
  mkdirSync(dir, { recursive: true });
  const modelsPath = join(base, "models.json");
  if (opts.withCatalog !== false) {
    writeFileSync(
      modelsPath,
      JSON.stringify({
        google: {
          models: {
            "gemini-4-hydrogen": { cost: { input: 1.5, output: 7.5, cache_read: 0.075 } },
            "gemini-4-neon": { cost: { input: 3, output: 15, cache_read: 0.15 } },
          },
        },
      }),
    );
  }
  const writeSession = (sessionId: string, rows: unknown[], mtimeSec?: number) => {
    const logs = join(dir, sessionId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const file = join(logs, "transcript.jsonl");
    writeFileSync(file, rows.map(line).join(""));
    if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
    return file;
  };
  return { base, dir, modelsPath, writeSession, reader: createAntigravitySessions({ dir, modelsPath }) };
}

describe("antigravity prompt and model helpers", () => {
  it("extracts USER_REQUEST and strips system_instructions", () => {
    const raw =
      "<USER_REQUEST>\n<system_instructions>\nInternal rules\n</system_instructions>\nCheck  Burn\nstatus\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>";
    expect(extractAntigravityPrompt(raw)).toBe("Check Burn status");
    expect(extractAntigravityPrompt("plain   prompt")).toBe("plain prompt");
  });

  it("strips effort suffixes from Antigravity model names", () => {
    expect(stripEffortSuffix("gemini-4-hydrogen-high")).toBe("gemini-4-hydrogen");
    expect(stripEffortSuffix("gemini-4-neon-medium")).toBe("gemini-4-neon");
    expect(stripEffortSuffix("gemini-4-neon-low")).toBe("gemini-4-neon");
    expect(stripEffortSuffix("gemini-4-hydrogen-xhigh")).toBe("gemini-4-hydrogen");
    expect(stripEffortSuffix("gemini-4-hydrogen-max")).toBe("gemini-4-hydrogen");
    expect(stripEffortSuffix("gemini-4-argon")).toBe("gemini-4-argon");
  });

  it("locates brain dir under ~/.gemini/antigravity-cli/brain", () => {
    expect(antigravityBrainDir("/home/me")).toBe("/home/me/.gemini/antigravity-cli/brain");
  });
});

describe("createAntigravitySessions", () => {
  it("prices models by stripping effort suffix against models.dev catalog and counts tools and turns", async () => {
    const s = setup();
    s.writeSession(
      "ses-uuid-1",
      [
        userInput("<USER_REQUEST>\n<system_instructions>skip</system_instructions>Inspect Burn\n</USER_REQUEST>"),
        planner({ model: "gemini-4-hydrogen-high", input: 1_000_000, cacheRead: 2_000_000, output: 100_000, tools: ["read_file", "read_file", "run_command"] }),
        { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: TS, content: "tool output" },
      ],
      1_700_000_000,
    );
    const got = await s.reader.reportOf(["ses-uuid-1", "thr_fallback"], "UTC");
    expect(got?.at).toBe(1_700_000_000_000);
    expect(got?.report.calls).toBe(1);
    expect(got?.report.turnCount).toBe(1);
    expect(got?.report.estimated).toBe(true);
    expect(got?.report.tokens).toMatchObject({ input: 1_000_000, cacheRead: 2_000_000, output: 100_000, cacheWrite: 0 });
    // 1M * 1.5 + 2M * 0.075 + 0.1M * 7.5 = 1.5 + 0.15 + 0.75 = 2.40
    expect(got?.report.cost.total).toBeCloseTo(2.4, 9);
    expect(got?.report.byModel).toMatchObject([{ key: "acp-antigravity/gemini-4-hydrogen-high", calls: 1 }]);
    expect(got?.report.turns[0]).toMatchObject({
      n: 1,
      prompt: "Inspect Burn",
      calls: 1,
      tools: [
        { name: "read_file", count: 2 },
        { name: "run_command", count: 1 },
      ],
    });
  });

  it("falls back to priceOverrides by exact model id, and shows tokens without cost when unpriced", async () => {
    const s = setup({ withCatalog: false });
    s.writeSession("ses-uuid-2", [
      userInput("Hello"),
      planner({ model: "gemini-4-hydrogen-high", input: 1_000_000, cacheRead: 0, output: 100_000 }),
      planner({ model: "custom-unpriced-medium", input: 500, cacheRead: 0, output: 200 }),
    ]);

    const unpriced = await s.reader.reportOf(["ses-uuid-2"], "UTC");
    expect(unpriced?.report.calls).toBe(2);
    expect(unpriced?.report.tokens).toMatchObject({ input: 1_000_500, output: 100_200 });
    expect(unpriced?.report.cost.total).toBe(0);
    expect(unpriced?.report.estimated).toBe(false);

    const overridden = await s.reader.reportOf(["ses-uuid-2"], "UTC", {
      prices: { "gemini-4-hydrogen-high": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } },
    });
    // 1M * 2 + 0.1M * 10 = 3.0; custom-unpriced-medium stays 0
    expect(overridden?.report.cost.total).toBeCloseTo(3, 9);
    expect(overridden?.report.estimated).toBe(true);
  });

  it("counts failed PLANNER_RESPONSE calls and ignores GENERIC tool errors", async () => {
    const s = setup();
    s.writeSession("ses-err", [
      userInput("Run check"),
      planner({ model: "gemini-4-neon-medium", input: 0, cacheRead: 0, output: 0, status: "ERROR", error: "quota exceeded" }),
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "ERROR", error: "file does not exist", created_at: TS },
    ]);
    const got = await s.reader.reportOf(["ses-err"], "UTC");
    expect(got?.report.calls).toBe(1);
    expect(got?.report.cost.total).toBe(0);
  });

  it("returns null for missing logs, thread-id fallbacks, and traversal ids", async () => {
    const s = setup();
    expect(await s.reader.reportOf(["missing-id"], "UTC")).toBeNull();
    expect(await s.reader.reportOf(["thr_only"], "UTC")).toBeNull();
    expect(await s.reader.reportOf(["../escape"], "UTC")).toBeNull();
  });

  it("reads appended lines incrementally including split UTF-8 characters", async () => {
    const s = setup();
    const file = s.writeSession("ses-inc", [userInput("First")]);
    appendFileSync(file, line(planner({ model: "gemini-4-neon-low", input: 1_000_000, cacheRead: 0, output: 0 })));
    expect((await s.reader.reportOf(["ses-inc"], "UTC"))?.report.cost.total).toBeCloseTo(3, 9);

    const next = line(userInput("Привет 🔥")) + line(planner({ model: "gemini-4-neon-low", input: 1_000_000, cacheRead: 0, output: 0 }));
    const bytes = Buffer.from(next);
    const cut = bytes.indexOf(0xf0) + 2;
    appendFileSync(file, bytes.subarray(0, cut));
    expect((await s.reader.reportOf(["ses-inc"], "UTC"))?.report.calls).toBe(1);

    appendFileSync(file, bytes.subarray(cut));
    const after = await s.reader.reportOf(["ses-inc"], "UTC");
    expect(after?.report.calls).toBe(2);
    expect(after?.report.cost.total).toBeCloseTo(6, 9);
    expect(after?.report.turns.at(-1)?.prompt).toBe("Привет 🔥");
  });

  it("serves Antigravity reports through the Burn host entry", async () => {
    const s = setup();
    s.writeSession("ses-host", [
      userInput("Via host"),
      planner({ model: "gemini-4-hydrogen-high", input: 1_000_000, cacheRead: 0, output: 0 }),
    ]);
    const entry = createHostEntry({ antigravityDir: s.dir, opencodeModels: s.modelsPath });
    const h = experimental_createHostEntryHarness(entry, { experimental_watch: () => ({ dispose: async () => undefined }) });
    const res = await h.experimental_call("reports", {
      harness: "antigravity",
      timeZone: "UTC",
      threads: [{ threadId: "thr_aaaaaaaa", sessionIds: ["ses-host", "thr_aaaaaaaa"] }],
    });
    expect(res.dir).toBe(s.dir);
    expect(res.reports[0]?.report?.calls).toBe(1);
    expect(res.reports[0]?.report?.cost.total).toBeCloseTo(1.5, 9);
    await h.experimental_dispose();
  });
});
