// @vitest-environment jsdom
import { loadPluginApp, type MountedPluginContentScripts, mountPluginContentScripts, type RenderedSlot, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BurnAlert } from "../../extensions/bb/alerts.js";
import type { rpcContract } from "../../extensions/bb/contract.js";
import { overBudgetStatus, setRowFlags } from "../../extensions/bb/flags.js";
import { backend, OTHER, THREAD } from "./fixtures.js";
import { resetVisibility, setVisibility } from "./visibility.js";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const slots: RenderedSlot[] = [];
const scripts: MountedPluginContentScripts[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  for (const mounted of scripts.splice(0)) await mounted.lifecycle.dispose();
  setRowFlags(new Map());
  resetVisibility();
});

const FLAG = { icon: "burn-flame", label: "Over budget · $12.40 of $10", tone: "error" };

async function mountScripts(omit = false) {
  const app = await loadPluginApp(() => import("../../extensions/bb/app.js"));
  const mounted = await mountPluginContentScripts(app, { pluginId: "burn", omitExperimentalThreadRowStatus: omit });
  scripts.push(mounted);
  return mounted;
}

async function renderOverlay(server: ReturnType<typeof backend>, settings: Record<string, boolean | number> = {}) {
  const app = await loadPluginApp(() => import("../../extensions/bb/app.js"));
  const overlay = app.appOverlays[0];
  if (!overlay) throw new Error("the Burn overlay is not registered");
  const slot = renderSlot<Record<string, never>, typeof rpcContract>(overlay, {}, { rpc: server.rpc, settings });
  slots.push(slot);
  return slot;
}

const overBudget = () => backend(undefined, { overBudget: () => ({ threads: [{ threadId: THREAD, cost: 12.4, budget: 10, estimated: false }] }) });

describe("overBudgetStatus", () => {
  it("marks a cost that is a list-price estimate", () => {
    expect(overBudgetStatus({ threadId: THREAD, cost: 12.4, budget: 10, estimated: true }).label).toBe("Over budget · ~$12.40 of $10");
    expect(overBudgetStatus({ threadId: THREAD, cost: 12.4, budget: 10, estimated: false }).label).toBe(FLAG.label);
  });
});

describe("the row-status store", () => {
  it("sets, updates and clears flags through the content script, and clears them all on dispose", async () => {
    const mounted = await mountScripts();
    setRowFlags(new Map([[THREAD, { icon: "burn-flame", label: "a", tone: "error" as const }]]));
    expect(mounted.inspection.getThreadRowStatus(THREAD)).toMatchObject({ label: "a" });
    setRowFlags(new Map([[OTHER, { icon: "burn-flame", label: "b", tone: "error" as const }]]));
    expect(mounted.inspection.getThreadRowStatus(THREAD)).toBeNull();
    expect(mounted.inspection.getThreadRowStatus(OTHER)).toMatchObject({ label: "b" });
    await mounted.lifecycle.dispose();
    expect(mounted.inspection.getThreadRowStatus(OTHER)).toBeNull();
    const again = await mountScripts();
    expect(again.inspection.getThreadRowStatus(OTHER)).toMatchObject({ label: "b" });
  });

  it("applies flags set before the script mounted, and does nothing on a bb without row statuses", async () => {
    setRowFlags(new Map([[THREAD, { icon: "burn-flame", label: "early", tone: "error" as const }]]));
    const mounted = await mountScripts();
    expect(mounted.inspection.getThreadRowStatus(THREAD)).toMatchObject({ label: "early" });
    await mounted.lifecycle.dispose();
    const old = await mountScripts(true);
    expect(old.inspection.threadRowStatusCalls).toEqual([]);
  });
});

describe("the app overlay", () => {
  it("flags every thread over its budget, and clears the flags when the setting is off", async () => {
    const mounted = await mountScripts();
    await renderOverlay(overBudget());
    await vi.waitFor(() => expect(mounted.inspection.getThreadRowStatus(THREAD)).toEqual(FLAG));

    const app = await loadPluginApp(() => import("../../extensions/bb/app.js"));
    slots.splice(0).forEach((s) => s.lifecycle.unmount());
    expect(mounted.inspection.getThreadRowStatus(THREAD)).toBeNull();
    const server = overBudget();
    slots.push(renderSlot(app.appOverlays[0]!, {}, { rpc: server.rpc, settings: { flagOverBudget: false } }));
    await vi.waitFor(() => expect(mounted.inspection.threadRowStatusCalls.length).toBeGreaterThan(1));
    expect(server.callsTo("overBudget")).toEqual([]);
    expect(mounted.inspection.getThreadRowStatus(THREAD)).toBeNull();
  });

  it("refreshes the flags after usage signals", async () => {
    const server = overBudget();
    const slot = await renderOverlay(server);
    await vi.waitFor(() => expect(server.callsTo("overBudget")).toHaveLength(1));
    await slot.behavior.emitRealtime("usage", { threadId: THREAD });
    await vi.waitFor(() => expect(server.callsTo("overBudget")).toHaveLength(2), { timeout: 2500 });
  });

  it("does not check budgets while the page is hidden, and checks once when it is visible again", async () => {
    const server = overBudget();
    const slot = await renderOverlay(server);
    await vi.waitFor(() => expect(server.callsTo("overBudget")).toHaveLength(1));
    setVisibility("hidden");
    await slot.behavior.emitRealtime("usage", { threadId: THREAD });
    await slot.behavior.emitRealtime("usage", { threadId: OTHER });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(server.callsTo("overBudget")).toHaveLength(1);
    setVisibility("visible");
    await vi.waitFor(() => expect(server.callsTo("overBudget")).toHaveLength(2));
    setVisibility("hidden");
    setVisibility("visible");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.callsTo("overBudget")).toHaveLength(2);
  });

  it("does not start the check that signals during a check asked for, once the page is hidden", async () => {
    let release: () => void = () => {};
    let n = 0;
    const server = backend(undefined, {
      overBudget: () => {
        const threads = [{ threadId: THREAD, cost: 12.4, budget: 10, estimated: false }];
        return ++n === 1 ? new Promise<{ threads: typeof threads }>((resolve) => (release = () => resolve({ threads }))) : { threads };
      },
    });
    const slot = await renderOverlay(server);
    await vi.waitFor(() => expect(server.callsTo("overBudget")).toHaveLength(1));
    await slot.behavior.emitRealtime("usage", { threadId: THREAD });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    setVisibility("hidden");
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.callsTo("overBudget")).toHaveLength(1);
    setVisibility("visible");
    await vi.waitFor(() => expect(server.callsTo("overBudget")).toHaveLength(2));
  });

  it("shows each alert once per window, in the tone its kind deserves, with a way to the thread", async () => {
    const slot = await renderOverlay(backend());
    const alert = (over: Partial<BurnAlert>): BurnAlert => ({ id: "x", kind: "near", threadId: THREAD, title: "t", body: "b", at: 1, ...over });
    await slot.behavior.emitRealtime("alert", alert({ id: "near:1", kind: "near", title: "Near" }));
    await slot.behavior.emitRealtime("alert", alert({ id: "near:1", kind: "near", title: "Near" }));
    await slot.behavior.emitRealtime("alert", alert({ id: "over:1", kind: "over", title: "Over" }));
    await slot.behavior.emitRealtime("alert", alert({ id: "stopped:1", kind: "stopped", title: "Stopped" }));
    await slot.behavior.emitRealtime("alert", alert({ id: "daily:1", kind: "daily", threadId: null, title: "Daily" }));
    await slot.behavior.emitRealtime("alert", { id: "junk" });
    expect(toast.warning.mock.calls.map((c) => c[0])).toEqual(["Near", "Daily"]);
    expect(toast.error.mock.calls.map((c) => c[0])).toEqual(["Over", "Stopped"]);
    const [, options] = toast.warning.mock.calls[0] as [string, { id: string; description: string; action: { label: string; onClick: () => void } }];
    expect(options).toMatchObject({ id: "near:1", description: "b", action: { label: "Open thread" } });
    options.action.onClick();
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: THREAD });
    const [, daily] = toast.warning.mock.calls[1] as [string, { action: { label: string; onClick: () => void } }];
    daily.action.onClick();
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "spend" });
  });

  it("keeps over-budget and stop alerts up until dismissed, and the rest long enough to read", async () => {
    const slot = await renderOverlay(backend());
    const kinds = ["near", "over", "stopped", "expensive", "daily"] as const;
    for (const kind of kinds) {
      await slot.behavior.emitRealtime("alert", { id: `${kind}:durations`, kind, threadId: kind === "daily" ? null : THREAD, title: kind, body: "b", at: 1 });
    }
    const calls = [...toast.mock.calls, ...toast.warning.mock.calls, ...toast.error.mock.calls] as [string, object][];
    const shown = new Map(calls);
    expect(Object.fromEntries(kinds.map((kind) => [kind, shown.get(kind)]))).toMatchObject({
      near: { duration: 15_000, closeButton: true },
      over: { duration: Infinity, closeButton: true },
      stopped: { duration: Infinity, closeButton: true },
      expensive: { duration: 10_000, closeButton: true },
      daily: { duration: 15_000, closeButton: true },
    });
  });
});
