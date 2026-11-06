// @vitest-environment jsdom
import type { BbNavigate, PluginBrowserBbSdk, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import { type RenderedSlot, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { rpcContract } from "../../extensions/bb/contract.js";
import { costAction, costDetail, type ThreadCosts, useThreadCosts } from "../../extensions/bb/menu.js";
import { registerPanelOpener } from "../../extensions/bb/panel-requests.js";
import { backend, CHILD, costRow, OTHER, THREAD } from "./fixtures.js";
import { resetVisibility, setVisibility } from "./visibility.js";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));

const slots: RenderedSlot[] = [];
afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  resetVisibility();
});

const target = (id: string): PluginThreadActionTarget => ({
  id,
  projectId: "proj_1",
  parentThreadId: null,
  archivedAt: null,
  pinnedAt: null,
  sectionId: null,
  isUnread: false,
  status: "idle",
  environment: null,
});

function fakeNavigate() {
  const calls: unknown[] = [];
  const navigate = {
    toThread: (threadId: string) => calls.push(["toThread", threadId]),
    openThreadPanel: (options: unknown) => (calls.push(["openThreadPanel", options]), true),
  } as unknown as BbNavigate;
  return { navigate, calls };
}

const item = (data: ThreadCosts, navigate: BbNavigate, id = THREAD) =>
  costAction({ thread: target(id), data, sdk: {} as PluginBrowserBbSdk, navigate });

const data = (rows: ReturnType<typeof costRow>[], copy = vi.fn()): ThreadCosts => ({ rows: new Map(rows.map((r) => [r.threadId, r])), copy });

describe("the Cost thread action", () => {
  it("shows the cost and the family total, or that nothing reported yet", () => {
    expect(costDetail(undefined)).toBeUndefined();
    expect(costDetail(costRow({ threadId: THREAD }))).toBe("$4.82");
    expect(costDetail(costRow({ threadId: THREAD, familyCost: 6.64 }))).toBe("$4.82 · $6.64 with children");
    expect(costDetail(costRow({ threadId: THREAD, cost: null, label: null }))).toBe("No report yet");
    expect(costDetail(costRow({ threadId: THREAD, label: "~$4.82", familyCost: 6.64, estimated: true }))).toBe("~$4.82 · ~$6.64 with children");
  });

  it("offers the panel, the budget and the summary, with the budget share as a hint", () => {
    const { navigate } = fakeNavigate();
    const action = item(data([costRow({ threadId: THREAD, familyCost: 6.64, budget: { amount: 10, source: "setting" }, state: "ok" })]), navigate);
    expect(action).toMatchObject({ label: "Cost", icon: "burn-flame", detail: "$4.82 · $6.64 with children" });
    expect(action.choices?.items.map((c) => c.label)).toEqual(["Open Burn panel", "Set budget…", "Copy cost summary"]);
    expect(action.choices?.hint).toBe("48% of the $10 thread budget");
    expect(item(data([]), navigate).choices?.hint).toBeUndefined();
    expect(item(data([costRow({ threadId: THREAD, cost: null, label: null })]), navigate).choices?.items[2]?.disabled).toBe(true);
  });

  it("opens the panel in place for a thread on screen, and goes to any other thread first", async () => {
    const { navigate, calls } = fakeNavigate();
    const opened: unknown[] = [];
    const unregister = registerPanelOpener(THREAD, (params) => (opened.push(params), true));
    await item(data([]), navigate).run({ value: "budget", requestRename: () => {} });
    expect(opened).toEqual([{ focus: "budget" }]);
    expect(calls).toEqual([]);

    await item(data([]), navigate, OTHER).run({ value: "open", requestRename: () => {} });
    expect(calls).toEqual([["toThread", OTHER]]);
    const later: unknown[] = [];
    registerPanelOpener(OTHER, (params) => (later.push(params), true))();
    expect(later).toEqual([null]);
    unregister();
  });

  it("copies the summary through the data hook", async () => {
    const copy = vi.fn();
    const { navigate } = fakeNavigate();
    await item(data([], copy), navigate).run({ value: "copy", requestRename: () => {} });
    expect(copy).toHaveBeenCalledWith(THREAD);
  });
});

describe("useThreadCosts", () => {
  function renderHookSlot(server: ReturnType<typeof backend>, initial: string[]) {
    let latest: ThreadCosts | null = null;
    let setIds: (ids: string[]) => void = () => {};
    function Probe({ ids }: { ids: string[] }) {
      latest = useThreadCosts({ threadIds: ids });
      return null;
    }
    const slot = renderSlot<{ ids: string[] }, typeof rpcContract>({ component: Probe }, { ids: initial }, { rpc: server.rpc });
    setIds = (ids) => slot.lifecycle.rerender(<Probe ids={ids} />);
    slots.push(slot);
    return { slot, rows: () => (latest as ThreadCosts | null)?.rows ?? new Map(), setIds };
  }

  it("loads the ids on screen in one batch, only once each, and skips ids that are not bb threads", async () => {
    const server = backend();
    const hook = renderHookSlot(server, [THREAD, CHILD, "thread-1"]);
    await vi.waitFor(() => expect(hook.rows().size).toBe(2));
    expect(server.callsTo("costs").map((c) => c.input)).toEqual([{ threadIds: [THREAD, CHILD] }]);
    await act(async () => hook.setIds([THREAD, CHILD, OTHER]));
    await vi.waitFor(() => expect(hook.rows().size).toBe(3));
    expect(server.callsTo("costs").map((c) => c.input)).toEqual([{ threadIds: [THREAD, CHILD] }, { threadIds: [OTHER] }]);
  });

  it("refetches what is on screen once after a burst of usage signals", async () => {
    const server = backend();
    const hook = renderHookSlot(server, [THREAD, CHILD]);
    await vi.waitFor(() => expect(hook.rows().size).toBe(2));
    await hook.slot.behavior.emitRealtime("usage", { threadId: CHILD });
    await hook.slot.behavior.emitRealtime("usage", { threadId: THREAD });
    await vi.waitFor(() => expect(server.callsTo("costs")).toHaveLength(2), { timeout: 2000 });
    expect(server.callsTo("costs")[1]?.input).toEqual({ threadIds: [THREAD, CHILD] });
  });

  it("does not start the reload that signals during a read asked for, once the page is hidden", async () => {
    let release: () => void = () => {};
    let n = 0;
    const server = backend(undefined, {
      costs: ({ threadIds }) => {
        const threads = threadIds.map((threadId) => costRow({ threadId }));
        return ++n === 1 ? new Promise<{ threads: typeof threads }>((resolve) => (release = () => resolve({ threads }))) : { threads };
      },
    });
    const hook = renderHookSlot(server, [THREAD, CHILD]);
    await vi.waitFor(() => expect(server.callsTo("costs")).toHaveLength(1));
    await hook.slot.behavior.emitRealtime("usage", { threadId: CHILD });
    await new Promise((resolve) => setTimeout(resolve, 900));
    setVisibility("hidden");
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.callsTo("costs")).toHaveLength(1);
    setVisibility("visible");
    await vi.waitFor(() => expect(server.callsTo("costs")).toHaveLength(2));
    expect(server.callsTo("costs")[1]?.input).toEqual({ threadIds: [THREAD, CHILD] });
  });

  it("fetches nothing on usage signals while the page is hidden, and refetches once when it is visible again", async () => {
    const server = backend();
    const hook = renderHookSlot(server, [THREAD, CHILD]);
    await vi.waitFor(() => expect(hook.rows().size).toBe(2));
    setVisibility("hidden");
    await hook.slot.behavior.emitRealtime("usage", { threadId: CHILD });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(server.callsTo("costs")).toHaveLength(1);
    setVisibility("visible");
    await vi.waitFor(() => expect(server.callsTo("costs")).toHaveLength(2));
    expect(server.callsTo("costs")[1]?.input).toEqual({ threadIds: [THREAD, CHILD] });
  });
});
