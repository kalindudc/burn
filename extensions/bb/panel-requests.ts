import type { BbNavigate, ExperimentalPanelController, JsonValue } from "@get-bb/plugin-sdk/app";

/** The thread action tab id of the Burn panel. */
export const PANEL_ACTION_ID = "burn";
const PENDING_MS = 10_000;

type Opener = (params: JsonValue | null) => boolean;

// Thread menus and toasts are app-wide, but a panel opens in one thread's side panel.
// Each mounted context chip registers an opener bound to that thread's panel controller.
const openers = new Map<string, Opener[]>();
let pending: { threadId: string; params: JsonValue | null; at: number } | null = null;

export function openPanelIn(panel: ExperimentalPanelController, params: JsonValue | null): boolean {
  const tab = { id: PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" } as const;
  return panel.openTab(params === null ? { tab } : { tab, params });
}

/** Registers the opener of a mounted chip, and runs a request that was waiting for this thread to open. */
export function registerPanelOpener(threadId: string, open: Opener, now: number = Date.now()): () => void {
  const list = openers.get(threadId) ?? [];
  list.push(open);
  openers.set(threadId, list);
  if (pending !== null && pending.threadId === threadId) {
    const request = pending;
    pending = null;
    if (now - request.at < PENDING_MS) open(request.params);
  }
  return () => {
    const left = (openers.get(threadId) ?? []).filter((o) => o !== open);
    if (left.length > 0) openers.set(threadId, left);
    else openers.delete(threadId);
  };
}

/**
 * Opens the Burn tab of `threadId`: in place when that thread is on screen,
 * otherwise by going to the thread and opening it once its chip mounts.
 */
export function requestPanel(navigate: BbNavigate, threadId: string, params: JsonValue | null, now: number = Date.now()): void {
  const list = openers.get(threadId);
  const open = list?.[list.length - 1];
  if (open !== undefined && open(params)) return;
  pending = { threadId, params, at: now };
  navigate.toThread(threadId);
}
