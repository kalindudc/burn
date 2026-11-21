import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SESSION_FILE_MAX, THREAD_ID, usageReportSchema } from "../schema.js";

/** Threads per `reports` call: 32 reports of at most 240 KiB stay under the host's 8 MiB output limit. */
export const HOST_BATCH = 32;
/** Session ids per `changed` signal; more than this is sent as `all`. */
export const CHANGED_MAX = 512;

const threadId = z.string().regex(THREAD_ID);

/**
 * What the server asks the Burn host entry on each machine. `harness` names the
 * agent whose usage to read: pi, OMP or Claude session logs, or opencode's database.
 */
export const hostContract = defineRpcContract({
  reports: {
    input: z.object({
      harness: z.enum(["pi", "omp", "opencode", "claude"]),
      /** The bb server's IANA zone, so `days` are its local days whatever the host's zone. */
      timeZone: z.string().max(100),
      /** Burn's price overrides from settings, for the Claude reader, which prices tokens itself. */
      prices: z
        .record(
          z.string().max(200),
          z.object({ input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(), cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative() }),
        )
        .optional(),
      threads: z
        .array(
          z.object({
            threadId,
            sessionIds: z.array(z.string().max(200)).max(32),
            since: z.number().nonnegative().optional(),
            parentSessionIds: z.array(z.string().max(200)).max(32).optional(),
            /** pi's session log as the thread's pi reported it, read before the folders the host knows. */
            sessionFile: z.string().max(SESSION_FILE_MAX).optional(),
          }),
        )
        .min(1)
        .max(HOST_BATCH),
    }),
    output: z.object({
      /** The folder the host reads, for the server's log lines. */
      dir: z.string(),
      /**
       * `at` is when the thread's newest log last changed; both are null when the host has no log for it, and `error` says why when it could not read one.
       * `searched` names the folders a pi thread's log was looked for in, when none held it.
       */
      reports: z.array(
        z.object({
          threadId,
          report: usageReportSchema.nullable(),
          at: z.number().nullable(),
          error: z.string().max(500).optional(),
          searched: z.array(z.string().max(SESSION_FILE_MAX)).max(16).optional(),
          /** The log may be in a folder the host does not watch, so only the thread's pi reports its changes. */
          unwatched: z.boolean().optional(),
        }),
      ),
    }),
  },
});

export const hostSignals = {
  /** Session logs that changed since the last signal; `all` when the host lost track and every thread should reread. */
  changed: { payload: z.object({ sessionIds: z.array(z.string()).max(CHANGED_MAX), all: z.boolean() }) },
} satisfies ExperimentalHostSignals;
