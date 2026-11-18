import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { createMinimaxSessions } from "../../extensions/bb/host/minimax-sessions.js";
import { createHermesSessions } from "../../extensions/bb/host/hermes-sessions.js";
import { createDshSessions } from "../../extensions/bb/host/dsh-sessions.js";
import { createMirrorSessions } from "../../extensions/bb/host/mirror-sessions.js";
import { ollamaCost } from "../../extensions/bb/host/ollama-prices.js";
import { createZcodeSessions } from "../../extensions/bb/host/zcode-sessions.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp() { const d = mkdtempSync(join(tmpdir(), "burn-ollama-")); dirs.push(d); return d; }
const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
it("prices DeepSeek by UTC weekday and time without applying Ollama prices to other providers", () => {
  const peak = Date.parse("2026-11-16T14:00:00Z"), weekend = Date.parse("2026-11-14T14:00:00Z");
  expect(ollamaCost("ollama-cloud", "deepseek-v4.1-flash", tokens, peak).cost.total).toBeCloseTo(1.506);
  expect(ollamaCost("ollama-cloud", "deepseek-v4.1-flash", tokens, weekend).cost.total).toBeCloseTo(.753);
  expect(ollamaCost("other", "deepseek-v4.1-flash", tokens, peak).priced).toBe(false);
  expect(ollamaCost("ollama-cloud", "unknown", tokens, peak).partial).toBe(true);
});
it("reads exact DSH compressed frames without counting neighbouring sessions", async () => {
  const d = tmp(), p = join(d, "work", "session_a"); mkdirSync(p, { recursive: true });
  const row = { type: "assistant/message", time: Date.parse("2026-11-16T14:00:00Z"),
    data: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 }, message: { source: { provider: "ollama-cloud", model: "deepseek-v4.1-flash" } } } };
  const frames = [ { type: "session" }, row ].map(x => zstdCompressSync(Buffer.from(JSON.stringify(x) + "\n")));
  writeFileSync(join(p, "session.v3.jsonl.zstd"), Buffer.concat(frames));
  const result = await createDshSessions({ dir: d }).reportOf(["session_a", "thr_bb"], "UTC");
  expect(result?.report.calls).toBe(1);
  expect(result?.report.tokens).toMatchObject({ input: 100, cacheRead: 20, output: 10 });
  expect(result?.report.cost.total).toBeCloseTo((100*.3 + 20*.006 + 10*1.2)/1e6);
});
it("maps BB ZCode sessions to usage rows and excludes cached input from full input", async () => {
  const d = tmp(), path = join(d, "db.sqlite"), mapping = join(d, "sessions.json");
  writeFileSync(mapping, JSON.stringify({ abc: { zcodeSid: "sess_a" } }));
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE model_usage(session_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER); CREATE TABLE session_task_link(parent_session_id TEXT)");
  db.prepare("INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("sess_a", "ollama-cloud", "glm-5.3-flash", "completed", Date.parse("2026-11-16T14:00:00Z"), 100, 10, 80, 0);
  db.close();
  const result = await createZcodeSessions({ mapping, database: path }).reportOf(["abc", "thr_bb"], "UTC");
  expect(result?.report.tokens).toMatchObject({ input: 20, cacheRead: 80, output: 10 });
  expect(result?.report.cost.total).toBeCloseTo((20*.15 + 80*.03 + 10*.5)/1e6);
});
const variable = (n: number): Buffer => { const a = []; do { let b = n % 128; n = Math.floor(n/128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); };
const vint = (key: number, value: number) => Buffer.concat([variable(key*8), variable(value)]);
const data = (key: number, value: Buffer | string) => { const b = Buffer.from(value); return Buffer.concat([variable(key*8+2), variable(b.length), b]); };
it("reads Mirror protobuf usage only when its inference host is Ollama", async () => {
  const d = tmp(), path = join(d, "state.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE react_session(id TEXT); CREATE TABLE react_entry(session_id TEXT, sequence INTEGER, payload BLOB)");
  db.prepare("INSERT INTO react_session VALUES (?)").run("session_a");
  const usage = Buffer.concat([vint(1, 100),vint(2, 10),vint(3, 80)]);
  const stamp = vint(1, 1794837600);
  const config = Buffer.concat([data(1, "beam"), data(3, "https://ollama.com/v1")]);
  const msg = Buffer.concat([data(3, stamp),data(4, data(5, usage)),data(8, config)]);
  db.prepare("INSERT INTO react_entry VALUES (?, ?, ?)").run("session_a", 1, msg);
  db.close();
  const result = await createMirrorSessions({ path }).reportOf(["session_a"], "UTC");
  expect(result?.report.calls).toBe(1);
  expect(result?.report.tokens).toMatchObject({ input: 20, cacheRead: 80, output: 10 });
  expect(result?.report.cost.total).toBeCloseTo((20*.125 + 80*.015 + 10*.4)/1e6);
});

it("prices MiniMax Code messages only when provider identity names Ollama", async () => {
  const d = tmp(), path = join(d, "mcode.sqlite"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE local_runtime_sessions(session_id TEXT); CREATE TABLE local_runtime_pi_history_rows(id INTEGER, session_id TEXT, created_at_ms INTEGER, data_json TEXT); CREATE TABLE local_runtime_token_usage(session_id TEXT)");
  db.prepare("INSERT INTO local_runtime_sessions VALUES (?)").run("session_a");
  const msg = { role: "assistant", provider: "custom_provider:ollama-cloud-minimax", model: "minimax-m3.1-flash", usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0 } };
  db.prepare("INSERT INTO local_runtime_pi_history_rows VALUES (?, ?, ?, ?)").run(1, "session_a", Date.parse("2026-11-16T14:00:00Z"), JSON.stringify(msg));
  db.close();
  const got = await createMinimaxSessions({ path }).reportOf(["session_a"], "UTC");
  expect(got?.report.calls).toBe(1);
  expect(got?.report.cost.total).toBeCloseTo((100*.15+20*.015+10*.6)/1e6);
});
it("shows a partial estimate from Hermes aggregate usage, including call count", async () => {
  const d = tmp(), path = join(d, "state.db"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE sessions(id TEXT); CREATE TABLE session_model_usage(session_id TEXT,model TEXT,billing_provider TEXT,billing_base_url TEXT,api_call_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,first_seen REAL,last_seen REAL)");
  db.prepare("INSERT INTO sessions VALUES (?)").run("session_a");
  db.prepare("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("session_a","minimax-m3","ollama-cloud","https://ollama.com",3,100,10,20,0,1794837600,1794837900);
  db.close();
  const got = await createHermesSessions({ dir: d }).reportOf(["session_a"], "UTC");
  expect(got?.report.calls).toBe(3);
  expect(got?.report.coverage).toBe("partial");
  expect(got?.report.cost.total).toBeCloseTo((100*.6+20*.12+10*2.4)/1e6);
});
