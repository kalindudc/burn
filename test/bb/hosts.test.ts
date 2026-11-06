import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createHostWatch } from "../../extensions/bb/hosts.js";

type Change = "host-connected" | "host-disconnected" | "provider-model-catalog-changed";
type Watcher = (event: { id?: string; changes: Change[] }) => void;

function setup(initial: Record<string, boolean>, opts: { subscribeFails?: boolean; listFails?: boolean } = {}) {
  const listed = new Map(Object.entries(initial));
  const watchers: Watcher[] = [];
  const connects: string[] = [];
  let lists = 0;
  let listGate: Promise<void> | null = null;
  let listFails = opts.listFails === true;
  let now = 1_000_000;
  const { bb, harness } = createFakePluginHost({
    pluginId: "burn",
    sdk: {
      hosts: {
        list: async () => {
          lists++;
          if (listFails) throw new Error("bb is busy");
          const gate = listGate;
          // The answer is the list as it was when bb was asked, as a slow connection would deliver it.
          const answer = [...listed].map(([id, connected]) => ({ id, status: connected ? "connected" : "disconnected" }));
          if (gate) await gate;
          return answer;
        },
      },
      subscribe: ((args: { callback: Watcher }) => {
        if (opts.subscribeFails) throw new Error("no realtime");
        watchers.push(args.callback);
        return () => void watchers.splice(watchers.indexOf(args.callback), 1);
      }) as never,
    },
  });
  const watch = createHostWatch(bb, { onConnect: (hostId) => void connects.push(hostId), now: () => now });
  const flush = async (): Promise<void> => {
    for (let n = 0; n < 5; n++) await Promise.resolve();
  };
  const emit = (id: string | undefined, ...changes: Change[]): void => {
    for (const watcher of [...watchers]) watcher({ id, changes });
  };
  const hold = (): (() => void) => {
    let release = (): void => undefined;
    listGate = new Promise((resolve) => {
      release = () => {
        listGate = null;
        resolve();
      };
    });
    return release;
  };
  const warnings = () => harness.inspection.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
  const failLists = (on: boolean): void => {
    listFails = on;
  };
  return { watch, failLists, listed, connects, lists: () => lists, flush, emit, hold, warnings, watchers, tick: (ms: number) => (now += ms), harness };
}

describe("createHostWatch", () => {
  it("takes every host as connected until the list has been read", async () => {
    const s = setup({ a: false });
    expect(s.watch.connected("a")).toBe(true);
    await s.flush();
    expect(s.watch.connected("a")).toBe(false);
  });

  it("reads the list for which hosts are connected, and takes a host it does not list as not connected", async () => {
    const s = setup({ a: true, b: false });
    await s.flush();
    expect(s.watch.connected("a")).toBe(true);
    expect(s.watch.connected("b")).toBe(false);
    expect(s.watch.connected("unlisted")).toBe(false);
    expect(s.connects).toEqual([]);
  });

  it("follows host-connected and host-disconnected events, and names a host that connects", async () => {
    const s = setup({ a: true, b: false });
    await s.flush();
    s.emit("a", "host-disconnected");
    expect(s.watch.connected("a")).toBe(false);
    s.emit("b", "host-connected");
    expect(s.watch.connected("b")).toBe(true);
    expect(s.connects).toEqual(["b"]);
    s.emit("b", "host-connected");
    expect(s.connects).toEqual(["b"]);
    s.emit("a", "host-connected");
    expect(s.connects).toEqual(["b", "a"]);
  });

  it("takes the later of two changes in one event, and ignores events that say nothing of connection", async () => {
    const s = setup({ a: true, b: false });
    await s.flush();
    s.emit("a", "host-connected", "host-disconnected");
    expect(s.watch.connected("a")).toBe(false);
    s.emit("b", "host-disconnected", "host-connected");
    expect(s.watch.connected("b")).toBe(true);
    s.emit("b", "provider-model-catalog-changed");
    expect(s.watch.connected("b")).toBe(true);
  });

  it("keeps what an event said while the list was being read, since it is newer than the list", async () => {
    const s = setup({ a: true, b: false });
    const release = s.hold();
    s.emit("a", "host-disconnected");
    s.emit("b", "host-connected");
    release();
    await s.flush();
    expect(s.watch.connected("a")).toBe(false);
    expect(s.watch.connected("b")).toBe(true);
  });

  it("takes a host bb deleted as not connected", async () => {
    const s = setup({ a: true });
    await s.flush();
    await s.harness.emitThreadEvent("experimental_host.deleted", { host: { id: "a" } as never });
    expect(s.watch.connected("a")).toBe(false);
  });

  it("reads the list again for a host it takes as not connected, at most once a minute", async () => {
    const s = setup({ a: false });
    await s.flush();
    expect(s.lists()).toBe(1);
    for (let n = 0; n < 5; n++) expect(s.watch.connected("a")).toBe(false);
    expect(s.lists()).toBe(1);
    s.listed.set("a", true);
    s.tick(60_000);
    expect(s.watch.connected("a")).toBe(false);
    expect(s.watch.connected("a")).toBe(false);
    expect(s.lists()).toBe(2);
    await s.flush();
    expect(s.watch.connected("a")).toBe(true);
    expect(s.connects).toEqual(["a"]);
  });

  it("does not read the list for a connected host", async () => {
    const s = setup({ a: true });
    await s.flush();
    s.tick(10 * 60_000);
    expect(s.watch.connected("a")).toBe(true);
    expect(s.lists()).toBe(1);
  });

  it("reads the list on an event that names no host", async () => {
    const s = setup({ a: false });
    await s.flush();
    s.listed.set("a", true);
    s.emit(undefined, "host-connected");
    await s.flush();
    expect(s.watch.connected("a")).toBe(true);
    expect(s.connects).toEqual(["a"]);
  });

  it("keeps taking every host as connected when the list cannot be read, and says so once", async () => {
    const s = setup({ a: false }, { listFails: true });
    await s.flush();
    expect(s.watch.connected("a")).toBe(true);
    s.tick(60_000);
    expect(s.watch.connected("a")).toBe(true);
    await s.flush();
    expect(s.lists()).toBe(2);
    expect(s.watch.connected("a")).toBe(true);
    expect(s.warnings().filter((w) => w.includes("listing bb's hosts failed"))).toHaveLength(1);
  });

  it("takes every host as connected again when a later read of the list fails, and keeps trying it", async () => {
    const s = setup({ a: false, b: true });
    await s.flush();
    expect(s.watch.connected("a")).toBe(false);
    s.failLists(true);
    s.tick(60_000);
    expect(s.watch.connected("a")).toBe(false);
    await s.flush();
    expect(s.watch.connected("a")).toBe(true);
    expect(s.watch.connected("b")).toBe(true);
    expect(s.lists()).toBe(2);
    s.tick(60_000);
    expect(s.watch.connected("b")).toBe(true);
    expect(s.lists()).toBe(3);
    await s.flush();
    s.listed.set("a", true);
    s.failLists(false);
    s.tick(60_000);
    expect(s.watch.connected("b")).toBe(true);
    await s.flush();
    expect(s.lists()).toBe(4);
    expect(s.watch.connected("a")).toBe(true);
    expect(s.connects).toEqual(["a"]);
    expect(s.warnings().filter((w) => w.includes("listing bb's hosts failed"))).toHaveLength(1);
  });

  it("goes back to hiding a host the list shows as not connected once the list can be read again", async () => {
    const s = setup({ a: false });
    await s.flush();
    s.failLists(true);
    s.tick(60_000);
    s.watch.connected("a");
    await s.flush();
    expect(s.watch.connected("a")).toBe(true);
    s.failLists(false);
    s.tick(60_000);
    s.watch.connected("a");
    await s.flush();
    expect(s.watch.connected("a")).toBe(false);
  });

  it("falls back to the list when events cannot be watched, and stops watching when disposed", async () => {
    const failing = setup({ a: false }, { subscribeFails: true });
    await failing.flush();
    expect(failing.warnings()).toEqual([expect.stringContaining("watching bb's hosts failed")]);
    expect(failing.watch.connected("a")).toBe(false);
    const s = setup({ a: true });
    expect(s.watchers).toHaveLength(1);
    s.watch.dispose();
    expect(s.watchers).toHaveLength(0);
  });
});
