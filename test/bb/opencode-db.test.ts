import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createOpencodeDb } from "../../extensions/bb/host/opencode-db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AT = 1_700_000_000_000;

interface Message {
  id: string;
  session: string;
  at: number;
  updated?: number;
  data: Record<string, unknown>;
}

/** An opencode database with the tables the reader queries, and the model catalog beside it. */
function setup(
  messages: Message[],
  parts: { id: string; message: string; session: string; text?: string; data?: Record<string, unknown>; at: number }[],
  sessions: { id: string; parent?: string }[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "burn-opencode-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec(`
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create table session (id text primary key, parent_id text);
  `);
  db.exec("begin");
  const session = db.prepare("insert into session (id, parent_id) values (?, ?)");
  for (const s of sessions) session.run(s.id, s.parent ?? null);
  const message = db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)");
  for (const m of messages) message.run(m.id, m.session, m.at, m.updated ?? m.at, JSON.stringify(m.data));
  const part = db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)");
  for (const p of parts) part.run(p.id, p.message, p.session, p.at, p.at, JSON.stringify(p.data ?? { type: "text", text: p.text }));
  db.exec("commit");
  db.close();
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      deepseek: {
        models: {
          "deepseek-v4-flash": { cost: { input: 0.15, output: 0.6, reasoning: 0.6, cache_read: 0.003 } },
        },
      },
    }),
  );
  return { path: join(dir, "opencode.db"), modelsPath, dir };
}

const assistant = (cost: number): Record<string, unknown> => ({
  role: "assistant",
  providerID: "deepseek",
  modelID: "deepseek-v4-flash",
  cost,
  tokens: { input: 1000, output: 500, reasoning: 100, cache: { read: 2000, write: 0 } },
  time: { created: AT, completed: AT + 2500 },
  finish: "tool-calls",
});

const assistantAt = (cost: number, at: number): Record<string, unknown> => ({ ...assistant(cost), time: { created: at, completed: at + 1000 } });

describe("createOpencodeDb", () => {
  it("turns opencode's user and assistant messages into a report, splitting the recorded cost by kind", async () => {
    const files = setup(
      [
        { id: "msg_user", session: "ses_1", at: AT, data: { role: "user", time: { created: AT } } },
        { id: "msg_a", session: "ses_1", at: AT + 1, updated: AT + 3000, data: assistant(0.005) },
      ],
      [
        { id: "part_1", message: "msg_user", session: "ses_1", text: "<system_instructions>…", at: AT },
        { id: "part_2", message: "msg_user", session: "ses_1", text: "привет  мир", at: AT + 1 },
      ],
    );
    const got = await createOpencodeDb(files).reportOf(["ses_1"], "UTC");
    expect(got?.at).toBe(AT + 3000);
    expect(got?.report.cost.total).toBeCloseTo(0.005, 9);
    const { cost } = got?.report ?? { cost: null };
    expect(cost).not.toBeNull();
    if (cost !== null) expect(cost.input + cost.output + cost.cacheRead + cost.cacheWrite).toBeCloseTo(0.005, 9);
    // opencode reports reasoning outside output; Burn counts it in output tokens.
    expect(got?.report.tokens).toMatchObject({ input: 1000, output: 600, cacheRead: 2000, reasoning: 100 });
    expect(got?.report.byModel).toMatchObject([{ key: "deepseek/deepseek-v4-flash", calls: 1 }]);
    expect(got?.report.turns).toMatchObject([{ n: 1, prompt: "привет мир", calls: 1, ms: 2500 }]);
    expect(got?.report.estimated).toBe(false);
  });

  it("takes a prompt from the last text the user typed, never from text opencode added", async () => {
    const files = setup(
      [
        { id: "msg_user", session: "ses_1", at: AT, data: { role: "user", time: { created: AT } } },
        { id: "msg_a", session: "ses_1", at: AT + 1, data: assistantAt(0.005, AT + 1) },
      ],
      [
        { id: "part_1", message: "msg_user", session: "ses_1", text: "<system_instructions>…", at: AT },
        { id: "part_2", message: "msg_user", session: "ses_1", text: "fix  the flaky test", at: AT },
        { id: "part_3", message: "msg_user", session: "ses_1", data: { type: "text", text: "Called the Read tool with the following input", synthetic: true }, at: AT },
      ],
    );
    const got = await createOpencodeDb(files).reportOf(["ses_1"], "UTC");
    expect(got?.report.turns).toMatchObject([{ n: 1, prompt: "fix the flaky test", calls: 1 }]);
  });

  it("counts the calls after a user message opencode wrote itself within the prompt before it", async () => {
    const user = (id: string, at: number): Message => ({ id, session: "ses_1", at, data: { role: "user", time: { created: at } } });
    const files = setup(
      [
        user("msg_u1", AT),
        { id: "msg_a1", session: "ses_1", at: AT + 1, data: assistantAt(0.001, AT + 1) },
        user("msg_u2", AT + 2),
        { id: "msg_a2", session: "ses_1", at: AT + 3, data: assistantAt(0.001, AT + 3) },
        user("msg_u3", AT + 4),
        { id: "msg_a3", session: "ses_1", at: AT + 5, data: assistantAt(0.001, AT + 5) },
      ],
      [
        { id: "part_1", message: "msg_u1", session: "ses_1", text: "review this", at: AT },
        {
          id: "part_2",
          message: "msg_u2",
          session: "ses_1",
          data: { type: "text", text: "Summarize the task tool output above and continue with your task.", synthetic: true },
          at: AT + 2,
        },
        { id: "part_3", message: "msg_u3", session: "ses_1", data: { type: "compaction", auto: true }, at: AT + 4 },
      ],
    );
    const got = await createOpencodeDb(files).reportOf(["ses_1"], "UTC");
    expect(got?.report.turns).toMatchObject([{ n: 1, prompt: "review this", calls: 3 }]);
    expect(got?.report.days).toMatchObject([{ prompts: 1, calls: 3 }]);
  });

  it("takes a slash command's prompt from its subtask when the user typed no text", async () => {
    const files = setup(
      [
        { id: "msg_user", session: "ses_1", at: AT, data: { role: "user", time: { created: AT } } },
        { id: "msg_a", session: "ses_1", at: AT + 1, data: assistantAt(0.005, AT + 1) },
      ],
      [
        {
          id: "part_1",
          message: "msg_user",
          session: "ses_1",
          data: { type: "subtask", prompt: "Load the explorer skill", description: "explore", agent: "explorer", command: "explore" },
          at: AT,
        },
      ],
    );
    const got = await createOpencodeDb(files).reportOf(["ses_1"], "UTC");
    expect(got?.report.turns).toMatchObject([{ n: 1, prompt: "Load the explorer skill", calls: 1 }]);
  });

  it("reads the newest messages of a session longer than the cap", async () => {
    const messages: Message[] = Array.from({ length: 20_001 }, (_, i) => ({
      id: `msg_${String(i).padStart(6, "0")}`,
      session: "ses_1",
      at: AT + i,
      data: assistantAt(i === 0 ? 5 : 0.001, AT + i),
    }));
    const got = await createOpencodeDb(setup(messages, [])).reportOf(["ses_1"], "UTC");
    expect(got?.report.calls).toBe(20_000);
    expect(got?.report.cost.total).toBeCloseTo(20, 6);
  });

  it("prices the tokens at the catalog's rates when opencode recorded no cost", async () => {
    const files = setup([{ id: "msg_a", session: "ses_1", at: AT, data: assistant(0) }], []);
    const got = await createOpencodeDb(files).reportOf(["ses_1"], "UTC");
    expect(got?.report.cost.total).toBeCloseTo((1000 * 0.15 + 600 * 0.6 + 2000 * 0.003) / 1_000_000, 12);
    expect(got?.report.estimated).toBe(true);
  });

  it("splits a recorded cost by token count when the catalog does not price the model", async () => {
    const files = setup([{ id: "msg_a", session: "ses_1", at: AT, data: { ...assistant(0.0036), modelID: "deepseek-unlisted" } }], []);
    const got = await createOpencodeDb(files).reportOf(["ses_1"], "UTC");
    const cost = got?.report.cost;
    expect(cost?.total).toBeCloseTo(0.0036, 12);
    // 1000 input, 600 output, 2000 cache read: 3600 tokens.
    expect(cost?.input).toBeCloseTo(0.001, 12);
    expect(cost?.output).toBeCloseTo(0.0006, 12);
    expect(cost?.cacheRead).toBeCloseTo(0.002, 12);
    expect(got?.report.estimated).toBe(false);
  });

  it("reads the catalog again after opencode refreshes it, so a model added later gets its prices", async () => {
    const files = setup([{ id: "msg_a", session: "ses_1", at: AT, data: { ...assistant(0), modelID: "deepseek-new" } }], []);
    const db = createOpencodeDb(files);
    expect((await db.reportOf(["ses_1"], "UTC"))?.report.cost.total ?? 0).toBe(0);
    writeFileSync(files.modelsPath, JSON.stringify({ deepseek: { models: { "deepseek-new": { cost: { input: 1, output: 1, cache_read: 1 } } } } }));
    utimesSync(files.modelsPath, new Date(AT + 60_000), new Date(AT + 60_000));
    expect((await db.reportOf(["ses_1"], "UTC"))?.report.cost.total).toBeCloseTo(3600 / 1_000_000, 12);
  });

  it("counts the calls of subagent sessions under the thread's session, within the parent's prompt", async () => {
    const files = setup(
      [
        { id: "msg_user", session: "ses_1", at: AT, data: { role: "user", time: { created: AT } } },
        { id: "msg_a", session: "ses_1", at: AT + 1, data: assistantAt(0.005, AT + 1) },
        { id: "msg_task", session: "ses_child", at: AT + 2, data: { role: "user", time: { created: AT + 2 } } },
        { id: "msg_b", session: "ses_child", at: AT + 3, data: assistantAt(0.002, AT + 3) },
        { id: "msg_c", session: "ses_grandchild", at: AT + 4, data: assistantAt(0.001, AT + 4) },
        { id: "msg_other", session: "ses_other", at: AT + 5, data: assistantAt(0.5, AT + 5) },
      ],
      [{ id: "part_1", message: "msg_user", session: "ses_1", text: "run the review", at: AT }],
      [{ id: "ses_1" }, { id: "ses_child", parent: "ses_1" }, { id: "ses_grandchild", parent: "ses_child" }, { id: "ses_other" }],
    );
    const got = await createOpencodeDb(files).reportOf(["ses_1"], "UTC");
    expect(got?.report.cost.total).toBeCloseTo(0.008, 12);
    expect(got?.report.byModel).toMatchObject([{ key: "deepseek/deepseek-v4-flash", calls: 3 }]);
    expect(got?.report.turns).toMatchObject([{ n: 1, prompt: "run the review", calls: 3 }]);
  });

  it("counts calls opencode recorded as failed or aborted, which carry no tokens", async () => {
    const failed = (name: string, at: number): Record<string, unknown> => ({
      role: "assistant",
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: at, completed: at + 1000 },
      error: { name, data: { message: "stopped" } },
    });
    const files = setup(
      [
        { id: "msg_a", session: "ses_1", at: AT, data: assistantAt(0.005, AT) },
        { id: "msg_aborted", session: "ses_1", at: AT + 10, data: failed("MessageAbortedError", AT + 10) },
        { id: "msg_error", session: "ses_1", at: AT + 20, data: failed("ProviderAuthError", AT + 20) },
      ],
      [],
    );
    const got = await createOpencodeDb(files).reportOf(["ses_1"], "UTC");
    expect(got?.report.cost.total).toBeCloseTo(0.005, 12);
    expect(got?.report.byModel).toMatchObject([{ key: "deepseek/deepseek-v4-flash", calls: 3, failed: 1 }]);
    expect(got?.report.days).toMatchObject([{ calls: 3, failed: 1, aborted: 1 }]);
  });

  it("returns null for a session the database does not have, and for a database that is not there", async () => {
    const files = setup([], []);
    expect(await createOpencodeDb(files).reportOf(["ses_missing"], "UTC")).toBeNull();
    expect(await createOpencodeDb({ path: join(files.dir, "missing.db"), modelsPath: files.modelsPath }).reportOf(["ses_1"], "UTC")).toBeNull();
  });

  describe("opencode 2's session_message table", () => {
    interface Row {
      id: string;
      session: string;
      type: string;
      data: Record<string, unknown> | string;
    }

    /** An opencode 2 database; row shapes come from opencode 2.2.4. `legacy` adds the older tables with one message. */
    function setupV2(rows: Row[], sessions: { id: string; parent?: string }[] = [], legacy = false) {
      const dir = mkdtempSync(join(tmpdir(), "burn-opencode-"));
      dirs.push(dir);
      const db = new DatabaseSync(join(dir, "opencode.db"));
      db.exec(`
        create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null, time_created integer not null, time_updated integer not null, data text not null);
        create table session_v2 (id text primary key, parent_id text);
      `);
      const session = db.prepare("insert into session_v2 (id, parent_id) values (?, ?)");
      for (const s of sessions) session.run(s.id, s.parent ?? null);
      const insert = db.prepare("insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)");
      rows.forEach((row, seq) => insert.run(row.id, row.session, row.type, seq, AT + seq, AT + seq, typeof row.data === "string" ? row.data : JSON.stringify(row.data)));
      if (legacy) {
        db.exec(`
          create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
          create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
          create table session (id text primary key, parent_id text);
        `);
        db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run(
          "old",
          "ses_old",
          AT,
          AT,
          JSON.stringify({ role: "assistant", providerID: "p", modelID: "legacy-model", time: { created: AT }, cost: 0.5, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }),
        );
      }
      db.close();
      return createOpencodeDb({ path: join(dir, "opencode.db"), modelsPath: join(dir, "none.json") });
    }

    const call = (tokens: Record<string, unknown>, cost = 0): Record<string, unknown> => ({
      time: { created: AT, completed: AT + 500 },
      agent: "build",
      model: { id: "mimo-v2.6-pro", providerID: "omni" },
      finish: "stop",
      cost,
      tokens,
      content: [{ type: "text", text: "SECRET TOOL OUTPUT" }],
    });
    const userRow = (id: string, session: string, text: string): Row => ({ id, session, type: "user", data: { time: { created: AT }, text, files: [] } });

    it("reads prompts, calls, models and reasoning outside output, and skips other row types", async () => {
      const db = setupV2([
        { id: "s", session: "ses_1", type: "system", data: { time: { created: AT }, text: "instructions" } },
        userRow("u1", "ses_1", "  what   time?  "),
        { id: "a1", session: "ses_1", type: "assistant", data: call({ input: 8806, output: 57, reasoning: 43, cache: { read: 256, write: 0 } }, 0.2) },
        { id: "i", session: "ses_1", type: "idle", data: { time: { created: AT }, outcome: "succeeded" } },
      ]);
      const got = await db.reportOf(["ses_1"], "UTC");
      expect(got?.report.calls).toBe(1);
      expect(got?.report.tokens).toEqual({ input: 8806, output: 100, cacheRead: 256, cacheWrite: 0, reasoning: 43 });
      expect(got?.report.cost.total).toBeCloseTo(0.2);
      expect(got?.report.turns?.map((t) => t.prompt)).toEqual(["what time?"]);
      expect(JSON.stringify(got)).toContain("mimo-v2.6-pro");
      expect(JSON.stringify(got)).not.toContain("SECRET TOOL OUTPUT");
    });

    it("counts a compaction as a call with its own cost and tokens", async () => {
      const db = setupV2([
        userRow("u1", "ses_1", "hello"),
        {
          id: "c1",
          session: "ses_1",
          type: "compaction",
          data: { time: { created: AT }, status: "completed", reason: "manual", model: { id: "m", providerID: "p" }, summary: "SECRET SUMMARY", cost: 0.1, tokens: { input: 12604, output: 282, reasoning: 0, cache: { read: 42, write: 0 } } },
        },
      ]);
      const got = await db.reportOf(["ses_1"], "UTC");
      expect(got?.report.tokens).toMatchObject({ input: 12604, output: 282, cacheRead: 42 });
      expect(got?.report.cost.total).toBeCloseTo(0.1);
    });

    it("counts failed and aborted calls that record no tokens", async () => {
      const failed = (type: string): Record<string, unknown> => ({ time: { created: AT }, agent: "build", model: { id: "m", providerID: "p" }, finish: "error", error: { type, message: "SECRET ERROR" } });
      const db = setupV2([
        userRow("u1", "ses_1", "hello"),
        { id: "a1", session: "ses_1", type: "assistant", data: failed("provider.auth") },
        { id: "a2", session: "ses_1", type: "assistant", data: failed("aborted") },
      ]);
      const got = await db.reportOf(["ses_1"], "UTC");
      expect(got?.report.calls).toBe(2);
      expect(JSON.stringify(got)).not.toContain("SECRET ERROR");
    });

    it("counts subagent sessions from session_v2 under the thread's session, not as prompts", async () => {
      const db = setupV2(
        [
          userRow("u1", "ses_parent", "delegate"),
          { id: "a1", session: "ses_parent", type: "assistant", data: call({ input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }) },
          userRow("u2", "ses_child", "You are a subagent"),
          { id: "a2", session: "ses_child", type: "assistant", data: call({ input: 50, output: 5, reasoning: 0, cache: { read: 1, write: 0 } }) },
        ],
        [{ id: "ses_parent" }, { id: "ses_child", parent: "ses_parent" }],
      );
      const got = await db.reportOf(["ses_parent"], "UTC");
      expect(got?.report.calls).toBe(2);
      expect(got?.report.tokens).toMatchObject({ input: 150, output: 15, cacheRead: 1 });
      expect(got?.report.turns?.map((t) => t.prompt)).toEqual(["delegate"]);
      expect(got?.report.agents?.rows.map((r) => r.id)).toEqual(["ses_child"]);
    });

    it("skips a malformed row and keeps the rest", async () => {
      const db = setupV2([
        { id: "bad", session: "ses_1", type: "assistant", data: "{not json" },
        { id: "a1", session: "ses_1", type: "assistant", data: call({ input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }) },
      ]);
      expect((await db.reportOf(["ses_1"], "UTC"))?.report.calls).toBe(1);
    });

    it("still reads a session that is only in the older message table when both exist", async () => {
      const db = setupV2([{ id: "a1", session: "ses_1", type: "assistant", data: call({ input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }) }], [], true);
      expect((await db.reportOf(["ses_old"], "UTC"))?.report.tokens).toMatchObject({ input: 7, output: 3 });
      expect((await db.reportOf(["ses_1"], "UTC"))?.report.tokens).toMatchObject({ input: 10, output: 1 });
    });
  });
});
