import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildReport, type EntryLike, type UsageReport } from "../../../src/report.js";

/** A session longer than this is read from its newest messages, which matter most for a live chip. */
const MESSAGES_MAX = 20_000;
/** How deep Burn follows subagent sessions (the task tool) below a thread's own session. */
const CHILD_DEPTH_MAX = 8;
const PER_MILLION = 1_000_000;

/** Where opencode keeps its database, following XDG like opencode itself. */
export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : join(homedir(), ".local", "share");
  return join(data, "opencode", "opencode.db");
}

/** Where opencode caches models.dev's catalog, whose prices split a recorded cost into its kinds. */
export function opencodeModelsPath(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== "" ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(cache, "opencode", "models.json");
}

interface Rates {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  estimated: boolean;
}

interface MessageRow {
  id: string;
  data: string;
  time_created: number;
  time_updated: number;
  type?: string;
}

interface UserPartRow {
  message_id: string;
  type: unknown;
  text: unknown;
  prompt: unknown;
  synthetic: unknown;
  ignored: unknown;
}

interface Prompt {
  /** Some part of the message came from the user rather than from opencode. */
  typed: boolean;
  text: string;
}

export interface OpencodeDb {
  /** The report of a thread's opencode sessions on this machine; null when the database has none of them. */
  reportOf(sessionIds: readonly string[], timeZone: string): Promise<{ report: UsageReport; at: number } | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function parse(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ratesOf(catalog: unknown, providerId: string, modelId: string): Rates | null {
  if (!isRecord(catalog) || !isRecord(catalog[providerId])) return null;
  const models = catalog[providerId].models;
  if (!isRecord(models) || !isRecord(models[modelId]) || !isRecord(models[modelId].cost)) return null;
  const cost = models[modelId].cost;
  return {
    input: num(cost.input),
    output: num(cost.output),
    reasoning: num(cost.reasoning ?? cost.output),
    cacheRead: num(cost.cache_read),
    cacheWrite: num(cost.cache_write),
  };
}

/**
 * A message's tokens as Burn's usage. opencode records the call's cost, so the
 * token prices only split that total into input, output, cache read and write;
 * without a recorded cost they price the tokens instead and mark the result an
 * estimate.
 */
function usageOf(data: Record<string, unknown>, rates: Rates | null): Usage | null {
  const failed = isRecord(data.error);
  const tokens = isRecord(data.tokens) ? data.tokens : failed ? {} : null;
  if (tokens === null) return null;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const input = num(tokens.input);
  const answered = num(tokens.output);
  const reasoning = num(tokens.reasoning);
  // opencode counts reasoning outside output; Burn, like the providers that
  // include it in output tokens, shows and totals it as part of output.
  const output = answered + reasoning;
  const cacheRead = num(cache.read);
  const cacheWrite = num(cache.write);
  // A failed or aborted call records no tokens; keep it so Burn counts it.
  if (input + output + cacheRead + cacheWrite === 0 && !failed) return null;

  const raw =
    rates === null
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : {
          input: (input * rates.input) / PER_MILLION,
          output: (answered * rates.output + reasoning * rates.reasoning) / PER_MILLION,
          cacheRead: (cacheRead * rates.cacheRead) / PER_MILLION,
          cacheWrite: (cacheWrite * rates.cacheWrite) / PER_MILLION,
        };
  const rawTotal = raw.input + raw.output + raw.cacheRead + raw.cacheWrite;
  const recorded = num(data.cost);
  const total = recorded > 0 ? recorded : rawTotal;
  // Without the model's prices (not in the catalog), split the recorded cost
  // by token count, so the kinds still add up to the total.
  const tokenTotal = input + output + cacheRead + cacheWrite;
  const share =
    rawTotal > 0
      ? { input: raw.input / rawTotal, output: raw.output / rawTotal, cacheRead: raw.cacheRead / rawTotal, cacheWrite: raw.cacheWrite / rawTotal }
      : tokenTotal > 0
        ? { input: input / tokenTotal, output: output / tokenTotal, cacheRead: cacheRead / tokenTotal, cacheWrite: cacheWrite / tokenTotal }
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost = {
    input: total * share.input,
    output: total * share.output,
    cacheRead: total * share.cacheRead,
    cacheWrite: total * share.cacheWrite,
    total,
  };
  return { input, output, cacheRead, cacheWrite, reasoning, cost, estimated: recorded <= 0 && rawTotal > 0 };
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** json_extract reads a JSON true as 1. */
const opencodesOwn = (part: UserPartRow): boolean => part.type === "compaction" || (part.type === "text" && (part.synthetic === 1 || part.ignored === 1));

/**
 * Each user message's prompt: the last text the user typed, else the prompt of a
 * slash command's subtask. A message whose every part opencode wrote itself, such
 * as "Continue if you have next steps" or a compaction, is not typed.
 */
function promptsOf(parts: readonly UserPartRow[]): Map<string, Prompt> {
  const typed = new Map<string, boolean>();
  const texts = new Map<string, string>();
  const subtasks = new Map<string, string>();
  for (const part of parts) {
    const own = opencodesOwn(part);
    typed.set(part.message_id, (typed.get(part.message_id) ?? false) || !own);
    if (!own && part.type === "text" && typeof part.text === "string") texts.set(part.message_id, collapse(part.text));
    if (part.type === "subtask" && typeof part.prompt === "string") subtasks.set(part.message_id, collapse(part.prompt));
  }
  const prompts = new Map<string, Prompt>();
  for (const [id, isTyped] of typed) prompts.set(id, { typed: isTyped, text: texts.get(id) ?? subtasks.get(id) ?? "" });
  return prompts;
}

/** The stop reason of a call opencode recorded as failed: aborted by the user, or an error. */
function stopReasonOf(data: Record<string, unknown>): "error" | "aborted" | undefined {
  if (isRecord(data.error)) return data.error.name === "MessageAbortedError" || data.error.type === "aborted" ? "aborted" : "error";
  return data.finish === "error" ? "error" : undefined;
}

/** The provider and model of a v2 assistant row, recorded under `model` rather than at the top level. */
function v2ModelOf(data: Record<string, unknown>): { provider: string; model: string } {
  const model = isRecord(data.model) ? data.model : {};
  const provider = typeof model.providerID === "string" && model.providerID !== "" ? model.providerID : "unknown";
  const id = typeof model.id === "string" && model.id !== "" ? model.id : "unknown";
  return { provider, model: id };
}

/**
 * What the reader needs of one session: its messages oldest first, and
 * each user message's prompt. The old database keeps messages and parts in the
 * `message`/`part` tables, with the role inside `data.role`; v2 keeps them in
 * `session_message` with the role in the `type` column and splits `session` into
 * `session_v2`. Both are read the same way below, so a reader change is a query
 * change, not a report change.
 */
interface SessionReader {
  messages(sessionId: string): MessageRow[];
  prompts(sessionId: string): Map<string, Prompt>;
}

function v1Reader(db: DatabaseSync, warnOnce: (what: string, err: unknown) => void): SessionReader {
  const messages = db.prepare(
    "select id, data, time_created, time_updated from message where session_id = ? order by time_created desc, id desc limit ?",
  );
  // cross join keeps SQLite on the message index, so it reads the parts of user messages only, never tool output.
  const userParts = db.prepare(
    "select p.message_id, json_extract(p.data, '$.type') as type, json_extract(p.data, '$.text') as text, json_extract(p.data, '$.prompt') as prompt, " +
      "json_extract(p.data, '$.synthetic') as synthetic, json_extract(p.data, '$.ignored') as ignored " +
      "from message m cross join part p on p.message_id = m.id where m.session_id = ? and json_extract(m.data, '$.role') = 'user' order by p.time_created, p.id",
  );
  return {
    messages(sessionId) {
      const rows = (messages.all(sessionId, MESSAGES_MAX) as unknown as MessageRow[]).reverse();
      return rows;
    },
    prompts(sessionId) {
      try {
        return promptsOf(userParts.all(sessionId) as unknown as UserPartRow[]);
      } catch (err) {
        warnOnce("could not read the parts of opencode's user messages, so prompts show without their text", err);
        return new Map();
      }
    },
  };
}

/**
 * The v2 reader: `session_message` rows of `type` user, assistant or compaction, with the
 * prompt text in the user row's `data.text` and the model under `data.model`.
 */
function v2Reader(db: DatabaseSync, warnOnce: (what: string, err: unknown) => void): SessionReader {
  const messages = db.prepare(
    "select id, case when json_valid(data) then json_remove(data, '$.content', '$.files') else 'null' end as data, type, time_created, time_updated from session_message where session_id = ? and type in ('user', 'assistant', 'compaction') order by time_created desc, id desc limit ?",
  );
  const userRows = db.prepare(
    "select id, case when json_valid(data) then json_extract(data, '$.text') else null end as text from session_message where session_id = ? and type = 'user' order by time_created, id",
  );
  return {
    messages(sessionId) {
      return (messages.all(sessionId, MESSAGES_MAX) as unknown as MessageRow[]).reverse();
    },
    prompts(sessionId) {
      const prompts = new Map<string, Prompt>();
      try {
        for (const row of userRows.all(sessionId) as unknown as { id: string; text: unknown }[]) {
          const text = typeof row.text === "string" ? collapse(row.text) : "";
          prompts.set(row.id, { typed: true, text });
        }
      } catch (err) {
        warnOnce("could not read opencode's user messages, so prompts show without their text", err);
      }
      return prompts;
    },
  };
}

/**
 * Reads opencode's own SQLite database, where every assistant message records
 * the tokens and cost of its call, so ACP threads show up in Burn even though
 * bb's ACP bridge records no usage events for them.
 */
export function createOpencodeDb(opts: { path: string; modelsPath?: string }): OpencodeDb {
  const modelsPath = opts.modelsPath ?? opencodeModelsPath();
  let catalog: unknown = null;
  let catalogStamp: number | null = null;
  // A missing database is normal (opencode is not installed); a locked, unreadable or changed one is not, and should not look like "no data".
  const warned = new Set<string>();
  function warnOnce(what: string, err: unknown): void {
    if (warned.has(what)) return;
    if (warned.size > 20) warned.clear();
    warned.add(what);
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[burn] ${what}: ${detail}`);
  }

  /** models.dev's catalog, read again whenever opencode refreshes the file, so a model added later gets its prices. */
  function prices(): unknown {
    let stamp: number;
    try {
      stamp = statSync(modelsPath).mtimeMs;
    } catch {
      catalogStamp = null;
      catalog = null;
      return null;
    }
    if (stamp !== catalogStamp) {
      catalogStamp = stamp;
      try {
        catalog = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
      } catch (err) {
        warnOnce("opencode's model catalog is not valid JSON, so recorded costs are split by tokens instead of prices", err);
        catalog = null;
      }
    }
    return catalog;
  }

  /** The thread's sessions and, below them, the subagent sessions opencode's task tool opened, marked as children. */
  function withChildren(db: DatabaseSync, layouts: { v1: boolean; v2: boolean }, ids: readonly string[]): { id: string; child: boolean }[] {
    const all = new Map<string, boolean>(ids.map((id) => [id, false]));
    const readers: ReturnType<DatabaseSync["prepare"]>[] = [];
    for (const [available, table] of [[layouts.v1, "session"], [layouts.v2, "session_v2"]] as const) {
      if (!available) continue;
      try {
        readers.push(db.prepare(`select id from ${table} where parent_id = ?`));
      } catch (err) {
        warnOnce(`opencode's ${table} table has no parent_id column, so its subagent sessions are not counted`, err);
      }
    }
    let level = [...ids];
    for (let depth = 0; depth < CHILD_DEPTH_MAX && level.length > 0; depth++) {
      const next: string[] = [];
      for (const parent of level) {
        for (const children of readers) {
          for (const row of children.all(parent) as unknown as { id: string }[]) {
            if (all.has(row.id)) continue;
            all.set(row.id, true);
            next.push(row.id);
          }
        }
      }
      level = next;
    }
    return [...all].map(([id, child]) => ({ id, child }));
  }

  /** Both layouts may coexist during migration; choose the new one per session. */
  function schemasOf(db: DatabaseSync): { v1: boolean; v2: boolean } {
    const has = (table: string): boolean => db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table) !== undefined;
    return { v1: has("message") && has("part"), v2: has("session_message") };
  }

  return {
    async reportOf(sessionIds, timeZone) {
      const ids = [...new Set(sessionIds)].filter((id) => id !== "");
      if (ids.length === 0) return null;
      let db: DatabaseSync;
      try {
        db = new DatabaseSync(opts.path, { readOnly: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") warnOnce("could not open opencode's database, so its threads show no figures", err);
        return null;
      }
      try {
        const layouts = schemasOf(db);
        if (!layouts.v1 && !layouts.v2) {
          warnOnce("opencode's database has neither the message nor the session_message table, so its threads show no figures", new Error("unknown layout"));
          return null;
        }
        const v1 = layouts.v1 ? v1Reader(db, warnOnce) : null;
        const v2 = layouts.v2 ? v2Reader(db, warnOnce) : null;
        const entries: EntryLike[] = [];
        let at = 0;
        for (const { id: sessionId, child } of withChildren(db, layouts, ids)) {
          const newer = v2?.messages(sessionId) ?? [];
          const schema = newer.length > 0 ? "v2" : "v1";
          const reader = schema === "v2" ? v2! : v1;
          if (reader === null) continue;
          const rows = schema === "v2" ? newer : reader.messages(sessionId);
          if (rows.length === 0) continue;
          const prompts = child ? new Map<string, Prompt>() : reader.prompts(sessionId);
          for (const row of rows) {
            const data = parse(row.data);
            if (data === null) continue;
            const time = isRecord(data.time) ? data.time : {};
            const created = num(time.created) || num(row.time_created);
            if (created <= 0) continue;
            const updated = Math.max(num(time.updated), num(time.completed), num(row.time_updated), created);
            at = Math.max(at, updated);
            const timestamp = new Date(created).toISOString();
            const role = schema === "v2" ? (row.type === "compaction" ? "assistant" : row.type) : data.role;
            if (role === "user") {
              // A subagent's prompt comes from the parent's task call, not from the user, and
              // opencode writes some user messages itself; their calls count within the prompt before them.
              const prompt = prompts.get(row.id);
              if (child || prompt?.typed === false) continue;
              const entry = { type: "message", timestamp, message: { role: "user", content: prompt?.text ?? "" } } as EntryLike;
              entries.push(entry);
              continue;
            }
            if (role !== "assistant") continue;
            const { provider, model } = schema === "v2"
              ? v2ModelOf(data)
              : {
                  provider: typeof data.providerID === "string" && data.providerID !== "" ? data.providerID : "unknown",
                  model: typeof data.modelID === "string" && data.modelID !== "" ? data.modelID : "unknown",
                };
            const usage = usageOf(data, ratesOf(prices(), provider, model));
            if (usage === null) continue;
            const completed = num(time.completed);
            const durationMs = completed > created ? completed - created : undefined;
            const entry = {
              type: "message",
              timestamp,
              ...(child ? { agentId: sessionId } : {}),
              message: {
                role: "assistant",
                provider,
                model,
                ...(durationMs !== undefined ? { durationMs } : {}),
                ...(stopReasonOf(data) !== undefined ? { stopReason: stopReasonOf(data) } : {}),
                usage,
              },
            } as EntryLike;
            entries.push(entry);
          }
        }
        if (entries.length === 0) return null;
        entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        const report = buildReport(entries, null, { timeZone });
        report.agents = { coverage: "partial", rows: report.agents?.rows ?? [] };
        return { report, at: at || Date.now() };
      } catch (err) {
        warnOnce("could not read opencode's database, so its threads show no figures", err);
        return null;
      } finally {
        db.close();
      }
    },
  };
}
