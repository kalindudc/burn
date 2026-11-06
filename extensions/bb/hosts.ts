import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** The shortest time between two reads of bb's host list that a read of a host Burn does not take as connected causes. */
const LIST_MS = 60_000;

export interface HostWatch {
  /**
   * Whether Burn should ask the host. False once bb has said the host is not connected, or after its list
   * left the host out. True until the list has been read once, and while the latest read of it failed,
   * so a bb that cannot list hosts changes nothing.
   */
  connected(hostId: string): boolean;
  dispose(): void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Which hosts are connected, from bb's host list and its host change events. A host that is not connected
 * answers every read with an error, and bb keeps the hosts of replaced sandboxes for as long as they have threads.
 * `onConnect` names a host that was not connected and now is, so Burn reads its threads again.
 */
export function createHostWatch(bb: BbPluginApi, opts: { onConnect(hostId: string): void; now?: () => number; listMs?: number }): HostWatch {
  const now = opts.now ?? Date.now;
  const listMs = opts.listMs ?? LIST_MS;
  let connectedIds: Set<string> | null = null;
  // What events said while the list was being read, which is newer than the list.
  let said: Map<string, boolean> | null = null;
  let listing = false;
  let listedAt = Number.NEGATIVE_INFINITY;
  let listFailed = false;
  let disposed = false;

  const set = (hostId: string, connected: boolean): void => {
    said?.set(hostId, connected);
    if (connectedIds === null) return;
    if (!connected) {
      connectedIds.delete(hostId);
      return;
    }
    if (connectedIds.has(hostId)) return;
    connectedIds.add(hostId);
    opts.onConnect(hostId);
  };

  async function refresh(): Promise<void> {
    if (disposed || listing) return;
    listing = true;
    listedAt = now();
    said = new Map();
    try {
      const hosts = await bb.sdk.hosts.list();
      if (disposed) return;
      const before = connectedIds;
      const next = new Set(hosts.filter((h) => h.status === "connected").map((h) => h.id));
      for (const [hostId, connected] of said) {
        if (connected) next.add(hostId);
        else next.delete(hostId);
      }
      connectedIds = next;
      listFailed = false;
      if (before !== null) for (const hostId of next) if (!before.has(hostId)) opts.onConnect(hostId);
    } catch (err) {
      if (!listFailed) bb.log.warn(`listing bb's hosts failed, so Burn asks every host for its figures: ${message(err)}`);
      listFailed = true;
    } finally {
      listing = false;
      said = null;
    }
  }

  const settle = (): void => void refresh();

  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = bb.sdk.subscribe({
      event: "host:changed",
      callback: ({ id, changes }) => {
        if (id === undefined) return settle();
        // bb names the change in the order it happened; the last of the two is the host's state now.
        const last = [...changes].reverse().find((c) => c === "host-connected" || c === "host-disconnected");
        if (last !== undefined) set(id, last === "host-connected");
      },
    });
  } catch (err) {
    bb.log.warn(`watching bb's hosts failed, so Burn reads bb's host list now and then instead: ${message(err)}`);
  }
  bb.events.on("experimental_host.deleted", ({ host }) => set(host.id, false));
  settle();

  return {
    connected(hostId) {
      const known = listFailed ? null : connectedIds;
      // A host the list left out may have connected since, and an event can be missed; a failed list is tried again.
      if ((known === null || !known.has(hostId)) && now() - listedAt >= listMs) settle();
      return known === null || known.has(hostId);
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
