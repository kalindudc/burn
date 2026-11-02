import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import type { rpcContract, UsageAnswer } from "./contract.js";

export const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * How long a read may go unanswered before it stops holding back the next one. bb's fetch has no
 * deadline, so a lost answer would otherwise leave every later signal waiting on it.
 */
export const READ_TIMEOUT_MS = 30_000;
/** How often a working thread is read again with no signal, in case one was missed. */
export const WORKING_REFETCH_MS = 60_000;

/** schema.ts#THREAD_ID without importing zod into the app bundle. */
export const isThreadId = (id: string): boolean => /^thr_[0-9a-z]{6,40}$/.test(id);

/** The thread a `usage` signal is about, or null for one that names none (every thread). */
export function signalThread(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const id = (payload as { threadId?: unknown }).threadId;
  return typeof id === "string" ? id : null;
}

/** Runs `onChange` after a reconnect: plugin signals are not replayed, so anything may have changed meanwhile. */
export function useOnReconnect(onChange: () => void): void {
  const connection = useRealtimeConnectionState();
  const last = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && last.current !== "connected") onChange();
    last.current = connection;
  }, [connection, onChange]);
}

/**
 * The thread's usage, refetched on its own `usage` signal (and its children's
 * when `withChildren`), after a reconnect and every minute while the thread
 * works; at list price when `listPrice`.
 */
export function useUsage(
  threadId: string,
  opts: { withChildren?: boolean; listPrice?: boolean } = {},
): { answer: UsageAnswer | null; error: string | null; refetch: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const listPrice = opts.listPrice === true;
  const key = `${threadId}:${listPrice}`;
  // Tagged with what it answers, so a switch of thread or prices never shows the old answer under the new one.
  const [held, setHeld] = useState<{ key: string; answer: UsageAnswer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const children = useRef<ReadonlySet<string>>(new Set());
  // A burst of signals for one thread joins the read under way, then reads once more for anything that arrived meanwhile.
  const flights = useRef(new Map<string, { again: boolean }>());
  // A flight that settles after a switch must not read the thread it started on again.
  const current = useRef(key);
  current.current = key;
  const mounted = useRef(true);

  const refetch = useCallback(function run() {
    const key = `${threadId}:${listPrice}`;
    const under = flights.current.get(key);
    if (under) {
      under.again = true;
      return;
    }
    const flight = { again: false };
    flights.current.set(key, flight);
    const asked = ++latest.current;
    let finished = false;
    // Runs once, when the read settles or times out; a late answer still counts if nothing newer was asked.
    const done = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      flights.current.delete(key);
      if (flight.again && mounted.current && current.current === key) run();
    };
    const timer = setTimeout(done, READ_TIMEOUT_MS);
    rpc.call("usage", listPrice ? { threadId, listPrice: true } : { threadId }).then(
      (next) => {
        if (asked === latest.current) {
          children.current = new Set(next.family.children.map((c) => c.threadId));
          setHeld({ key, answer: next });
          setError(null);
        }
        done();
      },
      (cause: unknown) => {
        if (asked === latest.current) setError(errorText(cause));
        done();
      },
    );
  }, [rpc, threadId, listPrice]);

  useEffect(() => {
    setHeld(null);
    refetch();
  }, [refetch]);
  useEffect(() => {
    // Set here as well as in useRef: React's development remount runs this again after the cleanup.
    mounted.current = true;
    return () => {
      mounted.current = false;
      latest.current++;
      flights.current.clear();
    };
  }, []);
  const withChildren = opts.withChildren === true;
  useRealtime(
    "usage",
    useCallback(
      (payload: unknown) => {
        const about = signalThread(payload);
        if (about === null || about === threadId || (withChildren && children.current.has(about))) refetch();
      },
      [threadId, withChildren, refetch],
    ),
  );
  useOnReconnect(refetch);
  const answer = held?.key === key ? held.answer : null;
  const working = answer?.report?.running === true;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(refetch, WORKING_REFETCH_MS);
    return () => clearInterval(timer);
  }, [working, refetch]);
  return { answer, error, refetch };
}

/** Date.now(), refreshed every `everyMs` while mounted. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
