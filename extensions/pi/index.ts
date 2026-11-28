import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  parseSessionEntries,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type BudgetPolicy, budgetAlert, isExpensiveTurn, NEAR_FRACTION, parseBudget, shouldStop } from "../../src/budget.js";
import { formatBudget, formatDelta, formatUsd, summaryMarkdown, turnMultiple } from "../../src/format.js";
import { buildReport, forkedAt, type UsageReport } from "../../src/report.js";
import { type BbReporter, createBbReporter } from "./bb-report.js";
import { completions, parseCommand, SUBCOMMANDS } from "./commands.js";
import { createHistoryLoader, type HistoryLoader, type SessionFile } from "./history.js";
import { BurnPanel, type PanelResult, type PanelView } from "./panel.js";
import { renderPill, SPINNER_MS } from "./pill.js";
import { BUDGET_ENTRY, describeBudget, effectivePolicy, ownBudget, threadBudget } from "./policy.js";
import { type BurnSettings, DEFAULT_SETTINGS, readSettings, settingsPath, writeSettings } from "./settings.js";
import { applySetting, settingsComponent, settingsText } from "./settings-view.js";
import { summaryText } from "./text.js";

const STATUS_KEY = "burn";
const PANEL_MAX_WIDTH = 100;

export interface BurnDeps {
  /** pi's agent directory, where burn.json lives. */
  agentDir?: () => string;
  reporter?: BbReporter;
  copy?: (text: string) => Promise<void>;
  listSessions?: (cwd: string) => Promise<SessionFile[]>;
  parseSession?: (text: string) => unknown[];
  now?: () => number;
}

interface Snapshot {
  report: UsageReport;
  policy: BudgetPolicy;
}

const stopMessage = (budget: number): string =>
  `Burn stopped this run at the thread's ${formatBudget(budget)} budget. Send another prompt to keep going, or raise it with /burn budget.`;

function alertMessage(alert: "near" | "over", report: UsageReport, budget: number): string {
  const spent = `${formatUsd(report.cost.total)} so far, last turn ${formatDelta(report.lastTurnCost)}`;
  return alert === "near"
    ? `Burn: this thread passed ${Math.round(NEAR_FRACTION * 100)}% of its ${formatBudget(budget)} budget: ${spent}.`
    : `Burn: this thread passed its ${formatBudget(budget)} budget: ${spent}.`;
}

const panelWidth = (columns: number): number => Math.max(Math.min(columns, 20), Math.min(PANEL_MAX_WIDTH, columns - 4));

const isTui = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.hasUI;

function contextOf(ctx: ExtensionContext): UsageReport["context"] {
  const usage = ctx.getContextUsage();
  return usage ? { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent } : null;
}

export function createBurn(deps: BurnDeps = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    // bb owns usage and budget enforcement for its threads.
    if (process.env.BB_THREAD_ID) return;

    const reporter = deps.reporter ?? createBbReporter({});
    const now = deps.now ?? Date.now;
    const copy = deps.copy ?? copyToClipboard;
    const path = () => settingsPath((deps.agentDir ?? getAgentDir)());
    const history: HistoryLoader = createHistoryLoader({
      list: deps.listSessions ?? ((cwd) => SessionManager.list(cwd)),
      parse: deps.parseSession ?? parseSessionEntries,
      now,
    });

    let settings: BurnSettings = DEFAULT_SETTINGS;
    let reportedError: string | null = null;
    let prevCost: number | null = null;
    let running = false;
    let stoppedAt: number | null = null;
    let nudged: number | null = null;
    let last: Snapshot | null = null;
    let frame = 0;
    let spinner: ReturnType<typeof setInterval> | null = null;
    let panel: { component: BurnPanel; tui: TUI } | null = null;

    function loadSettings(ctx: ExtensionContext): void {
      const { settings: read, error } = readSettings(path());
      if (error !== null && error !== reportedError && ctx.hasUI) ctx.ui.notify(error, "warning");
      reportedError = error;
      settings = read;
    }

    function snapshot(ctx: ExtensionContext): Snapshot {
      const entries = ctx.sessionManager.getEntries();
      const thread = threadBudget(entries);
      const policy = effectivePolicy(reporter.policy(), thread, settings);
      const report = buildReport(entries, contextOf(ctx), { countFrom: forkedAt(ctx.sessionManager.getHeader()) });
      report.running = running;
      report.budget = ownBudget(thread, settings);
      report.stoppedAt = stoppedAt;
      return { report, policy };
    }

    function show(ctx: ExtensionContext, snap: Snapshot): void {
      last = snap;
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, renderPill(ctx.ui.theme, snap.report, snap.policy.budget, frame));
      if (panel) {
        panel.component.update(snap.report, snap.policy.budget);
        panel.tui.requestRender();
      }
      void reporter.report(snap.report, ctx.mode, ctx.sessionManager.getSessionFile() ?? null);
    }

    /** The only place Burn may stop a run: with stop at budget on, for the run that crosses it. */
    function watch(ctx: ExtensionContext, snap: Snapshot): void {
      const cost = snap.report.cost.total;
      const before = prevCost;
      prevCost = cost;
      if (before === null) return;
      const { policy, report } = snap;
      const budget = policy.budget;
      if (budget === null || policy.includeChildren) return;
      if (running && shouldStop(policy, before, cost)) {
        stoppedAt = now();
        report.stoppedAt = stoppedAt;
        ctx.abort();
        if (isTui(ctx)) ctx.ui.notify(stopMessage(budget), "warning");
        return;
      }
      const alert = budgetAlert(before, cost, budget);
      if (alert && isTui(ctx)) ctx.ui.notify(alertMessage(alert, report, budget), "warning");
    }

    function refresh(ctx: ExtensionContext, opts: { quiet?: boolean } = {}): Snapshot | null {
      try {
        const snap = snapshot(ctx);
        if (opts.quiet) prevCost = snap.report.cost.total;
        else watch(ctx, snap);
        show(ctx, snap);
        return snap;
      } catch {
        // A malformed old entry must never break a pi event handler.
        return null;
      }
    }

    function nudge(ctx: ExtensionContext, snap: Snapshot): void {
      if (!snap.policy.notifyExpensiveTurn || !isTui(ctx)) return;
      const { turns } = snap.report;
      const turn = turns[turns.length - 1];
      if (!turn || turn.n === nudged || !isExpensiveTurn(turn, turns)) return;
      nudged = turn.n;
      const multiple = turnMultiple(turn, turns) ?? 0;
      ctx.ui.notify(`That prompt cost ${formatUsd(turn.cost)}, ${multiple.toFixed(1)}× this thread's median. /burn turns`, "info");
    }

    function startSpinner(ctx: ExtensionContext): void {
      if (spinner || !isTui(ctx)) return;
      spinner = setInterval(() => {
        frame++;
        try {
          if (last) ctx.ui.setStatus(STATUS_KEY, renderPill(ctx.ui.theme, last.report, last.policy.budget, frame));
        } catch {
          // The session may be going away between frames.
        }
      }, SPINNER_MS);
      spinner.unref?.();
    }

    function stopSpinner(): void {
      if (spinner) clearInterval(spinner);
      spinner = null;
    }

    pi.on("session_start", (_event, ctx) => {
      prevCost = null;
      running = false;
      stoppedAt = null;
      nudged = null;
      loadSettings(ctx);
      refresh(ctx, { quiet: true });
    });
    pi.on("session_tree", (_event, ctx) => void refresh(ctx));
    pi.on("session_compact", (_event, ctx) => void refresh(ctx));
    pi.on("agent_start", (_event, ctx) => {
      running = true;
      loadSettings(ctx);
      startSpinner(ctx);
      refresh(ctx);
    });
    pi.on("message_end", (event, ctx) => {
      if ((event.message as { role?: string } | undefined)?.role === "assistant") refresh(ctx);
    });
    pi.on("turn_end", (_event, ctx) => void refresh(ctx));
    pi.on("agent_end", (_event, ctx) => {
      running = false;
      stopSpinner();
      const snap = refresh(ctx);
      if (snap) nudge(ctx, snap);
    });
    pi.on("session_shutdown", () => {
      stopSpinner();
      panel = null;
    });

    async function openPanel(ctx: ExtensionCommandContext, view: PanelView): Promise<void> {
      loadSettings(ctx);
      const snap = snapshot(ctx);
      if (!isTui(ctx)) {
        ctx.ui.notify(summaryText(snap.report, snap.policy), "info");
        return;
      }
      const currentPath = ctx.sessionManager.getSessionFile() ?? null;
      const title = ctx.sessionManager.getSessionName();
      let tuiRef: TUI | null = null;
      const result = await ctx.ui.custom<PanelResult>(
        (tui, theme, _keybindings, done) => {
          tuiRef = tui;
          const component = new BurnPanel({
            report: snap.report,
            budget: snap.policy.budget,
            theme,
            view,
            done,
            rows: () => tui.terminal.rows,
            requestRender: () => tui.requestRender(),
            copy,
            title,
            now,
            history: {
              cwd: ctx.cwd,
              currentPath,
              currentTitle: title || snap.report.turns.find((t) => t.n === 1)?.prompt || "This session",
              load: () => history.load(ctx.cwd),
            },
          });
          panel = { component, tui };
          return component;
        },
        {
          overlay: true,
          overlayOptions: () => {
            const columns = tuiRef?.terminal.columns ?? 80;
            const rows = tuiRef?.terminal.rows ?? 24;
            return { anchor: "center", width: panelWidth(columns), maxHeight: Math.max(8, rows - 2) };
          },
        },
      );
      panel = null;
      if (result?.resume) await ctx.switchSession(result.resume);
    }

    async function budgetCommand(ctx: ExtensionCommandContext, scope: "thread" | "default", input: string | null): Promise<void> {
      loadSettings(ctx);
      const thread = threadBudget(ctx.sessionManager.getEntries());
      const bb = reporter.policy();
      if (input === null) {
        ctx.ui.notify(describeBudget(bb, thread, settings), "info");
        return;
      }
      const budget = parseBudget(input);
      if (budget === undefined) {
        const example = scope === "default" ? "/burn budget default 10" : "/burn budget 10";
        ctx.ui.notify(`"${input}" is not a budget. Use dollars, such as ${example}, or off.`, "warning");
        return;
      }
      if (scope === "thread") {
        pi.appendEntry(BUDGET_ENTRY, { budget });
        refresh(ctx);
        ctx.ui.notify(describeBudget(bb, budget, settings), "info");
        return;
      }
      if (!save(ctx, { ...settings, defaultBudget: budget })) return;
      const saved = budget === null ? "Default budget turned off." : `Default budget set to ${formatBudget(budget)}.`;
      ctx.ui.notify(`${saved}\n${describeBudget(bb, thread, settings)}`, "info");
    }

    function save(ctx: ExtensionContext, next: BurnSettings): boolean {
      try {
        writeSettings(path(), next);
      } catch (err) {
        ctx.ui.notify(`Burn could not save ${path()}: ${err instanceof Error ? err.message : String(err)}`, "error");
        return false;
      }
      loadSettings(ctx);
      refresh(ctx);
      return true;
    }

    async function copyCommand(ctx: ExtensionCommandContext): Promise<void> {
      const { report, policy } = snapshot(ctx);
      try {
        await copy(summaryMarkdown(report, { title: ctx.sessionManager.getSessionName(), budget: policy.budget }));
        ctx.ui.notify("Copied this thread's cost summary to the clipboard as Markdown.", "info");
      } catch (err) {
        ctx.ui.notify(`Burn could not copy to the clipboard: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }

    async function settingsCommand(ctx: ExtensionCommandContext): Promise<void> {
      loadSettings(ctx);
      if (!isTui(ctx)) {
        ctx.ui.notify(settingsText(settings, path()), "info");
        return;
      }
      await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) =>
        settingsComponent(
          theme,
          settings,
          (id, value) => void save(ctx, applySetting(settings, id, value)),
          () => done(undefined),
          () => tui.requestRender(),
        ),
      );
    }

    pi.registerCommand("burn", {
      description: "What this thread has cost: overview, turns, models, history, budget, copy and settings",
      getArgumentCompletions: completions,
      handler: async (args, ctx) => {
        const command = parseCommand(args);
        switch (command.kind) {
          case "view":
            return openPanel(ctx, command.view);
          case "budget":
            return budgetCommand(ctx, command.scope, command.input);
          case "copy":
            return copyCommand(ctx);
          case "settings":
            return settingsCommand(ctx);
          case "unknown": {
            const names = [...new Set(SUBCOMMANDS.map((s) => s.label.split(" ")[0]))].join(", ");
            ctx.ui.notify(`Burn has no "${command.name}" command. Try /burn with ${names}.`, "warning");
          }
        }
      },
    });
  };
}

export default createBurn();
