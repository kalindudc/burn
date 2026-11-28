import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbReporter } from "../../extensions/pi/bb-report.js";
import { PLAIN } from "../../extensions/pi/draw.js";
import burn, { createBurn } from "../../extensions/pi/index.js";
import type { BurnPanel } from "../../extensions/pi/panel.js";
import { BUDGET_ENTRY } from "../../extensions/pi/policy.js";
import { SPINNER } from "../../extensions/pi/pill.js";
import type { BudgetPolicy } from "../../src/budget.js";
import type { UsageReport } from "../../src/report.js";
import { assistant, user } from "../helpers.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = {
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null;
};

let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "burn-agent-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("BB_THREAD_ID", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
  vi.useRealTimers();
});

const writeSettings = (value: unknown) => writeFileSync(join(agentDir, "burn.json"), typeof value === "string" ? value : JSON.stringify(value));

function setup(opts: { entries?: unknown[]; header?: unknown; mode?: string; hasUI?: boolean; bbPolicy?: BudgetPolicy | null } = {}, extension?: typeof burn) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const entries: unknown[] = opts.entries ?? [user(), assistant(1.5)];
  const sent: UsageReport[] = [];
  let bbPolicy = opts.bbPolicy ?? null;
  const reporter: BbReporter = {
    report: vi.fn(async (report: UsageReport) => void sent.push(report)),
    policy: () => bbPolicy,
  };
  const copy = vi.fn(async (_text: string) => {});
  const pi = {
    on: (name: string, handler: Handler) => void handlers.set(name, handler),
    registerCommand: (name: string, def: Command) => void commands.set(name, def),
    appendEntry: (customType: string, data: unknown) =>
      void entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() }),
  };
  const setStatus = vi.fn();
  const notify = vi.fn();
  let overlay: { factory: (...args: unknown[]) => unknown; options: Record<string, unknown>; resolve: (v: unknown) => void } | null = null;
  const custom = vi.fn(
    (factory: (...args: unknown[]) => unknown, options: Record<string, unknown>) =>
      new Promise((resolve) => {
        overlay = { factory, options, resolve };
      }),
  );
  const abort = vi.fn();
  const switchSession = vi.fn(async () => ({ cancelled: false }));
  const ctx = {
    mode: opts.mode ?? "tui",
    hasUI: opts.hasUI ?? true,
    cwd: agentDir,
    ui: {
      setStatus,
      notify,
      custom,
      theme: { ...PLAIN, fg: (_c: string, t: string) => t, getBgAnsi: () => "\x1b[48;2;1;2;3m" },
    },
    sessionManager: {
      getEntries: () => entries,
      getHeader: () => opts.header ?? null,
      getSessionFile: () => "/s/current",
      getSessionName: () => "burn work",
    },
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    abort,
    switchSession,
  };
  const initialize = extension ?? createBurn({ agentDir: () => agentDir, reporter, copy, listSessions: async () => [], now: () => 1_000 });
  initialize(pi as never);
  const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const run = (args: string) => commands.get("burn")!.handler(args, ctx);
  const spend = (cost: number) => entries.push(assistant(cost));
  const lastPill = () => setStatus.mock.calls.at(-1)?.[1] as string;
  return {
    handlers,
    commands,
    entries,
    sent,
    setStatus,
    notify,
    custom,
    abort,
    switchSession,
    copy,
    ctx,
    fire,
    run,
    spend,
    lastPill,
    overlay: () => overlay,
    setBbPolicy: (p: BudgetPolicy | null) => {
      bbPolicy = p;
    },
  };
}

const notes = (notify: ReturnType<typeof vi.fn>) => notify.mock.calls.map((c) => String(c[0]));

describe("burn pi extension", () => {
  it.each([
    ["without a Burn plugin endpoint", undefined, undefined],
    ["with a Burn plugin endpoint", "http://127.0.0.1:4318/usage", "test-token"],
  ])("registers nothing in BB-managed Pi %s", (_label, url, token) => {
    writeSettings({ defaultBudget: 1, stopAtBudget: true, notifyExpensiveTurn: true });
    vi.stubEnv("BB_THREAD_ID", "thr_test0001");
    vi.stubEnv("BURN_BB_URL", url);
    vi.stubEnv("BURN_BB_TOKEN", token);
    const t = setup({ mode: "rpc" }, burn);
    expect([t.handlers.size, t.commands.size]).toEqual([0, 0]);
  });

  it("registers /burn and shows dollar spend in standalone Pi", () => {
    const t = setup({}, burn);
    expect(t.commands.has("burn")).toBe(true);
    t.fire("session_start");
    expect(t.setStatus).toHaveBeenLastCalledWith("burn", expect.stringContaining("$1.50"));
  });

  it("counts a forked session only from its creation, not the parent's copied calls", () => {
    const stamped = (iso: string, entry: { timestamp: string }) => ({ ...entry, timestamp: iso });
    const header = { type: "session", version: 3, id: "s", timestamp: "2026-10-18T12:00:00.000Z", cwd: "/w", parentSession: "/s/parent.jsonl" };
    const entries = [
      stamped("2026-10-18T10:00:00.000Z", user("parent")),
      stamped("2026-10-18T10:00:01.000Z", assistant(5)),
      stamped("2026-10-18T12:00:01.000Z", user("side chat")),
      stamped("2026-10-18T12:00:02.000Z", assistant(1.25)),
    ];
    const t = setup({ entries, header });
    t.fire("turn_end");
    expect(t.lastPill()).toContain("$1.25");
    expect(t.sent.at(-1)?.cost.total).toBeCloseTo(1.25);
    const whole = setup({ entries, header: { ...header, parentSession: undefined } });
    whole.fire("turn_end");
    expect(whole.sent.at(-1)?.cost.total).toBeCloseTo(6.25);
  });

  it("sets the pill after a turn and reads $0.00 with no calls", () => {
    const t = setup();
    t.fire("turn_end");
    expect(t.setStatus).toHaveBeenLastCalledWith("burn", expect.stringContaining("$1.50"));
    const empty = setup({ entries: [] });
    empty.fire("session_start");
    expect(empty.setStatus).toHaveBeenLastCalledWith("burn", expect.stringContaining("$0.00"));
  });

  it("listens on every refresh event and refreshes on assistant messages only", () => {
    const t = setup();
    for (const name of ["session_start", "session_tree", "session_compact", "agent_start", "message_end", "turn_end", "agent_end", "session_shutdown"]) {
      expect(t.handlers.has(name), name).toBe(true);
    }
    t.fire("message_end", { message: { role: "user" } });
    expect(t.setStatus).not.toHaveBeenCalled();
    t.fire("message_end", { message: { role: "assistant" } });
    expect(t.setStatus).toHaveBeenCalledTimes(1);
  });

  it("does not touch the status without a UI", () => {
    const t = setup({ hasUI: false });
    t.fire("turn_end");
    expect(t.setStatus).not.toHaveBeenCalled();
  });

  it("swallows a failing session manager", () => {
    const t = setup();
    (t.ctx.sessionManager as unknown as { getEntries: () => never }).getEntries = () => {
      throw new Error("boom");
    };
    for (const name of ["session_start", "agent_start", "turn_end", "agent_end"]) expect(() => t.fire(name), name).not.toThrow();
  });

  it("sends running state and budget fields to the injected reporter", () => {
    const t = setup({ mode: "rpc" });
    t.fire("session_start");
    t.fire("agent_start");
    expect(t.sent.at(-1)).toMatchObject({ version: 2, running: true, budget: null, stoppedAt: null });
    t.fire("agent_end");
    expect(t.sent.at(-1)?.running).toBe(false);
  });

  it("animates the pill only while a run is active in the TUI", () => {
    vi.useFakeTimers();
    const t = setup();
    t.fire("session_start");
    t.fire("agent_start");
    expect(t.lastPill()).toContain(SPINNER[0]);
    vi.advanceTimersByTime(120);
    expect(t.lastPill()).toContain(SPINNER[1]);
    t.fire("agent_end");
    const calls = t.setStatus.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(t.setStatus.mock.calls.length).toBe(calls);
    expect(t.lastPill()).toContain("\uf06d");
    t.fire("agent_start");
    t.fire("session_shutdown");
    const after = t.setStatus.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(t.setStatus.mock.calls.length).toBe(after);
  });

  it("never animates outside the TUI", () => {
    vi.useFakeTimers();
    const t = setup({ mode: "rpc" });
    t.fire("agent_start");
    const calls = t.setStatus.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(t.setStatus.mock.calls.length).toBe(calls);
    t.fire("agent_end");
  });
});

describe("/burn", () => {
  it("opens a centred overlay in the TUI on the requested view", async () => {
    const t = setup();
    void t.run("");
    expect(t.custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));
    const tui = { terminal: { columns: 160, rows: 50 }, requestRender: vi.fn() };
    const panel = t.overlay()!.factory(tui, PLAIN, {}, () => {}) as BurnPanel;
    expect((t.overlay()!.options.overlayOptions as () => unknown)()).toEqual({ anchor: "center", width: 100, maxHeight: 48 });
    expect(panel.current()).toBe("overview");
    void t.run("turns");
    expect((t.overlay()!.factory(tui, PLAIN, {}, () => {}) as BurnPanel).current()).toBe("turns");
    void t.run("history");
    expect((t.overlay()!.factory(tui, PLAIN, {}, () => {}) as BurnPanel).current()).toBe("history");
  });

  it("keeps the open panel live and lets go of it on close", async () => {
    const t = setup();
    const opened = t.run("");
    const tui = { terminal: { columns: 100, rows: 50 }, requestRender: vi.fn() };
    let done: (v: unknown) => void = () => {};
    const panel = t.overlay()!.factory(tui, PLAIN, {}, (v: unknown) => done(v)) as BurnPanel;
    done = t.overlay()!.resolve;
    expect(panel.render(100).join("\n")).toContain("$1.50 spent");
    t.spend(2);
    t.fire("message_end", { message: { role: "assistant" } });
    expect(tui.requestRender).toHaveBeenCalled();
    expect(panel.render(100).join("\n")).toContain("$3.50 spent");
    panel.handleInput("\x1b");
    await opened;
    tui.requestRender.mockClear();
    t.fire("turn_end");
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("resumes the session History picks", async () => {
    const t = setup();
    const opened = t.run("history");
    t.overlay()!.factory({ terminal: { columns: 100, rows: 50 }, requestRender: () => {} }, PLAIN, {}, () => {});
    t.overlay()!.resolve({ resume: "/s/other" });
    await opened;
    expect(t.switchSession).toHaveBeenCalledWith("/s/other");
  });

  it("notifies a plain-text summary with the budget and last turns outside the TUI", async () => {
    const t = setup({ mode: "rpc", entries: [user("first prompt"), assistant(1), user("second prompt"), assistant(0.5)] });
    await t.run("");
    expect(t.custom).not.toHaveBeenCalled();
    const [text, level] = t.notify.mock.calls[0] as [string, string];
    expect(level).toBe("info");
    expect(text).toContain("Thread usage · 2 calls · 2 prompts");
    expect(text).toContain("No budget (/burn budget 10 sets one).");
    expect(text).toContain("Last turns:");
    expect(text.indexOf("second prompt")).toBeLessThan(text.indexOf("first prompt"));
  });

  it("completes subcommands with a description each", () => {
    const { getArgumentCompletions } = setup().commands.get("burn")!;
    const all = getArgumentCompletions!("")!;
    expect(all.map((c) => c.label)).toEqual([
      "turns",
      "models",
      "history",
      "budget",
      "budget <usd>|off",
      "budget default <usd>|off",
      "copy",
      "settings",
    ]);
    for (const item of all) expect(item.description).toBeTruthy();
    expect(getArgumentCompletions!("bu")!.map((c) => c.value)).toEqual(["budget", "budget ", "budget default "]);
    expect(getArgumentCompletions!("budget d")!.map((c) => c.value)).toEqual(["budget default "]);
    expect(getArgumentCompletions!("zzz")).toBeNull();
    expect(all.find((c) => c.value === "settings")!.description).toContain("off by default");
  });

  it("copies the Markdown summary", async () => {
    const t = setup();
    await t.run("copy");
    expect(t.copy).toHaveBeenCalledWith(expect.stringContaining("### Cost of “burn work”"));
    expect(t.notify).toHaveBeenCalledWith(expect.stringContaining("Copied"), "info");
  });

  it("warns about an unknown subcommand", async () => {
    const t = setup();
    await t.run("nope");
    expect(t.notify).toHaveBeenCalledWith(expect.stringContaining('no "nope" command'), "warning");
  });
});

describe("budgets", () => {
  it("shows where the budget in effect comes from", async () => {
    const t = setup();
    await t.run("budget");
    expect(notes(t.notify).at(-1)).toContain("No budget.");
    writeSettings({ defaultBudget: 10 });
    await t.run("budget");
    expect(notes(t.notify).at(-1)).toContain("$10, the default");
    await t.run("budget 4");
    expect(notes(t.notify).at(-1)).toContain("$4, set for this thread");
    expect(notes(t.notify).at(-1)).toContain("never stops a run");
    await t.run("budget off");
    expect(notes(t.notify).at(-1)).toContain("turned off for this thread");
  });

  it("stores the thread's budget as a session entry, and null overrides the default", async () => {
    writeSettings({ defaultBudget: 10 });
    const t = setup({ mode: "rpc" });
    t.fire("session_start");
    expect(t.sent.at(-1)?.budget).toBe(10);
    await t.run("budget $7.50");
    expect(t.entries.at(-1)).toMatchObject({ type: "custom", customType: BUDGET_ENTRY, data: { budget: 7.5 } });
    expect(t.sent.at(-1)?.budget).toBe(7.5);
    await t.run("budget off");
    expect(t.sent.at(-1)?.budget).toBeNull();
  });

  it("writes the default budget to burn.json", async () => {
    const t = setup();
    await t.run("budget default 25");
    expect(JSON.parse(readFileSync(join(agentDir, "burn.json"), "utf-8"))).toEqual({
      defaultBudget: 25,
      stopAtBudget: false,
      notifyExpensiveTurn: false,
    });
    await t.run("budget default off");
    expect(JSON.parse(readFileSync(join(agentDir, "burn.json"), "utf-8")).defaultBudget).toBeNull();
  });

  it("rejects a budget it cannot read", async () => {
    const t = setup();
    await t.run("budget ten");
    await t.run("budget default -3");
    expect(t.notify.mock.calls.map((c) => c[1])).toEqual(["warning", "warning"]);
    expect(notes(t.notify)[0]).toContain('"ten" is not a budget');
    expect(t.entries.some((e) => (e as { type: string }).type === "custom")).toBe(false);
  });

  it("colours the pill by the budget in effect", async () => {
    const t = setup({ entries: [user(), assistant(8.5)] });
    await t.run("budget 10");
    expect(t.lastPill()).toContain(" / $10");
  });

  it("uses the injected policy's budget, falling back to pi's own when it has none", async () => {
    const t = setup({ mode: "rpc", bbPolicy: { budget: 20, stopAtBudget: false, notifyExpensiveTurn: false } });
    await t.run("budget 4");
    await t.run("budget");
    expect(notes(t.notify).at(-1)).toContain("$20, set in bb");
    expect(t.sent.at(-1)?.budget).toBe(4);
    t.setBbPolicy({ budget: null, stopAtBudget: false, notifyExpensiveTurn: false });
    await t.run("budget");
    expect(notes(t.notify).at(-1)).toContain("$4, set for this thread");
  });

  it("alerts once at 80% and once at 100%, in the TUI", async () => {
    const t = setup({ entries: [user(), assistant(7)] });
    t.fire("session_start");
    await t.run("budget 10");
    t.notify.mockClear();
    t.spend(1.5);
    t.fire("turn_end");
    t.spend(0.5);
    t.fire("turn_end");
    t.spend(1.5);
    t.fire("turn_end");
    t.spend(1);
    t.fire("turn_end");
    expect(notes(t.notify)).toEqual([
      "Burn: this thread passed 80% of its $10 budget: $8.50 so far, last turn +$8.50.",
      "Burn: this thread passed its $10 budget: $10.50 so far, last turn +$10.50.",
    ]);
  });

  it("does not alert when a session that is already over budget opens, nor in RPC mode", () => {
    writeSettings({ defaultBudget: 10 });
    const t = setup({ entries: [user(), assistant(12)] });
    t.fire("session_start");
    t.fire("turn_end");
    expect(t.notify).not.toHaveBeenCalled();
    const rpc = setup({ mode: "rpc", entries: [user(), assistant(7)] });
    rpc.fire("session_start");
    rpc.spend(4);
    rpc.fire("turn_end");
    expect(rpc.notify).not.toHaveBeenCalled();
  });

  it("reports a malformed burn.json once and uses the defaults", () => {
    writeSettings("{nope");
    const t = setup();
    t.fire("session_start");
    t.fire("agent_start");
    t.fire("agent_end");
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith(expect.stringContaining("burn.json"), "warning");
  });
});

describe("stopping at the budget", () => {
  function crossing(opts: { settings?: unknown; mode?: string; bbPolicy?: BudgetPolicy } = {}) {
    if (opts.settings) writeSettings(opts.settings);
    const t = setup({ entries: [user(), assistant(9), { type: "custom", customType: BUDGET_ENTRY, data: { budget: 10 }, timestamp: new Date().toISOString() }], mode: opts.mode, bbPolicy: opts.bbPolicy });
    t.fire("session_start");
    t.fire("agent_start");
    t.spend(2);
    t.fire("message_end", { message: { role: "assistant" } });
    return t;
  }

  it("never stops a run with the default settings", () => {
    const t = crossing();
    t.spend(5);
    t.fire("turn_end");
    t.fire("agent_end");
    expect(t.abort).not.toHaveBeenCalled();
    expect(t.sent.at(-1)?.stoppedAt).toBeNull();
    expect(notes(t.notify)).toEqual([expect.stringContaining("passed its $10 budget")]);
  });

  it("stops only the run that crosses the budget when turned on", () => {
    const t = crossing({ settings: { stopAtBudget: true } });
    expect(t.abort).toHaveBeenCalledTimes(1);
    expect(notes(t.notify)).toEqual([
      "Burn stopped this run at the thread's $10 budget. Send another prompt to keep going, or raise it with /burn budget.",
    ]);
    expect(t.sent.at(-1)?.stoppedAt).toBe(1_000);
    t.fire("agent_end");
    t.fire("agent_start");
    t.spend(3);
    t.fire("message_end", { message: { role: "assistant" } });
    t.fire("agent_end");
    expect(t.abort).toHaveBeenCalledTimes(1);
  });

  it("does not stop outside a run", () => {
    writeSettings({ stopAtBudget: true });
    const t = setup({ entries: [user(), assistant(9), { type: "custom", customType: BUDGET_ENTRY, data: { budget: 10 }, timestamp: "" }] });
    t.fire("session_start");
    t.spend(2);
    t.fire("session_compact");
    expect(t.abort).not.toHaveBeenCalled();
  });

  it("leaves shared-budget stops to bb, which can see child spending", () => {
    const t = crossing({ mode: "rpc", bbPolicy: { budget: 10, stopAtBudget: true, notifyExpensiveTurn: false, includeChildren: true } });
    expect(t.abort).not.toHaveBeenCalled();
    expect(t.sent.at(-1)?.stoppedAt).toBeNull();
  });

  it("honors an injected stop policy in RPC mode without a notification", () => {
    const off = crossing({ settings: { stopAtBudget: true }, mode: "rpc", bbPolicy: { budget: null, stopAtBudget: false, notifyExpensiveTurn: false } });
    expect(off.abort).not.toHaveBeenCalled();
    const on = crossing({ mode: "rpc", bbPolicy: { budget: 10, stopAtBudget: true, notifyExpensiveTurn: false } });
    expect(on.abort).toHaveBeenCalledTimes(1);
    expect(on.notify).not.toHaveBeenCalled();
  });
});

describe("expensive-turn nudge", () => {
  const thread = () => [user(), assistant(0.2), user(), assistant(0.25), user(), assistant(0.2), user(), assistant(0.3), user()];

  it("is off by default", () => {
    const t = setup({ entries: thread() });
    t.fire("session_start");
    t.fire("agent_start");
    t.spend(1.42);
    t.fire("agent_end");
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("notifies once after an expensive prompt when turned on", () => {
    writeSettings({ notifyExpensiveTurn: true });
    const t = setup({ entries: thread() });
    t.fire("session_start");
    t.fire("agent_start");
    t.spend(1.42);
    t.fire("agent_end");
    t.fire("agent_start");
    t.fire("agent_end");
    expect(notes(t.notify)).toEqual(["That prompt cost $1.42, 6.3× this thread's median. /burn turns"]);
  });
});

describe("/burn settings", () => {
  it("prints the settings and how to change them outside the TUI", async () => {
    const t = setup({ mode: "rpc" });
    await t.run("settings");
    const text = notes(t.notify)[0]!;
    expect(text).toContain("Stop a run at the budget: off. Off by default.");
    expect(text).toContain("stops only the run whose cost crosses the budget");
    expect(text).toContain(join(agentDir, "burn.json"));
  });

  it("edits burn.json from a settings list in the TUI", async () => {
    const t = setup();
    void t.run("settings");
    const tui = { terminal: { columns: 100, rows: 40 }, requestRender: vi.fn() };
    const list = t.overlay()!.factory(tui, PLAIN, {}, () => {}) as { render(w: number): string[]; handleInput(d: string): void };
    const out = list.render(100).join("\n");
    expect(out).toContain("Stop a run at the budget");
    expect(out).toContain("Off by default");
    list.handleInput("\r");
    expect(JSON.parse(readFileSync(join(agentDir, "burn.json"), "utf-8")).stopAtBudget).toBe(true);
    expect(tui.requestRender).toHaveBeenCalled();
  });
});
